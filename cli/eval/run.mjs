// CLI-vs-MCP efficiency eval: run the same deterministic browser tasks through
// the Claude Agent SDK twice — once with only Bash + firefox-cli, once with
// the MCP server attached — and compare tokens, turns, cost, duration.
//
//   node eval/run.mjs [--model <id>] [--task <id>] [--headed]
//
// --headed launches visible Firefox windows so you can watch the agent work.
//
// Requires Claude Code auth (the Agent SDK spawns the claude binary).

import { query } from '@anthropic-ai/claude-agent-sdk';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, listInstances, stop } from '../lib/instances.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '..', 'bin', 'firefox-cli.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const MODEL = flag('model', 'claude-sonnet-4-6');
const ONLY_TASK = flag('task', null);
const HEADED = args.includes('--headed');
const MAX_TURNS = 16;

function page(html) {
  return 'data:text/html,' + encodeURIComponent(html);
}

const TASKS = [
  {
    id: 'title',
    url: page('<title>Zephyr Quartz 8412</title><h1>Product page</h1>'),
    ask: 'Report the exact page title.',
    expect: /Zephyr Quartz 8412/,
  },
  {
    id: 'click-reveal',
    url: page(
      '<title>Reveal</title>' +
        '<button onclick="document.getElementById(\'out\').textContent=\'FLUX-93\'">Reveal code</button>' +
        '<div id="out"></div>'
    ),
    ask: 'Click the "Reveal code" button and report the code that appears.',
    expect: /FLUX-93/,
  },
  {
    id: 'form-fill',
    url: page(
      '<title>Greeter</title>' +
        '<input id="name" placeholder="Your name">' +
        '<button onclick="document.getElementById(\'g\').textContent=\'Hello, \'+document.getElementById(\'name\').value">Greet</button>' +
        '<div id="g"></div>'
    ),
    ask: 'Type "Marmalade" into the name field, click the Greet button, and report the greeting text that appears.',
    expect: /Hello, Marmalade/,
  },
];

const CLI_CHEATSHEET = `You control a running Firefox via the \`firefox-cli\` bash command.
Each command is a one-shot process; browser state persists between commands.

  firefox-cli open <url>            open a new tab at url
  firefox-cli find "text"           search the page, returns matching elements with uids like 3_7
  firefox-cli snapshot              full page snapshot with uids (large; prefer find)
  firefox-cli click <uid>
  firefox-cli fill <uid> <value>    fill an editable element
  firefox-cli eval '() => document.title'   run a JS function in the page

Uids are only valid from your most recent find/snapshot output.`;

function taskPrompt(condition, task) {
  const intro =
    condition === 'cli'
      ? CLI_CHEATSHEET
      : 'You control a running Firefox via the connected "firefox" MCP tools.';
  return `${intro}

Task: Open ${task.url} in the browser. Then: ${task.ask}
Answer concisely with just the requested information.`;
}

async function runAgent(condition, task, ctx) {
  const options = {
    model: MODEL,
    maxTurns: MAX_TURNS,
    permissionMode: 'dontAsk',
    cwd: ctx.scratchDir,
    settingSources: [],
  };
  if (condition === 'cli') {
    options.allowedTools = ['Bash'];
    options.env = {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH}`,
      FIREFOX_CLI_STATE_DIR: ctx.stateDir,
    };
  } else {
    options.allowedTools = ['mcp__firefox'];
    options.mcpServers = {
      firefox: { type: 'http', url: ctx.endpoint },
    };
  }

  const started = Date.now();
  let result = null;
  for await (const message of query({ prompt: taskPrompt(condition, task), options })) {
    if (message.type === 'result') {
      result = message;
    }
  }
  if (!result) {
    throw new Error('no result message from agent');
  }
  const text = result.subtype === 'success' ? result.result : `[${result.subtype}]`;
  const usage = result.usage ?? {};
  return {
    condition,
    task: task.id,
    success: task.expect.test(text),
    answer: text.slice(0, 120).replace(/\n/g, ' '),
    turns: result.num_turns,
    input_tokens: usage.input_tokens ?? 0,
    cache_creation: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cost_usd: result.total_cost_usd,
    duration_s: Math.round((result.duration_ms ?? Date.now() - started) / 100) / 10,
  };
}

async function withInstance(stateDir, fn) {
  process.env.FIREFOX_CLI_STATE_DIR = stateDir;
  const instance = await launch({ headless: !HEADED });
  try {
    return await fn(instance);
  } finally {
    const [inst] = listInstances();
    if (inst) {
      await stop(inst).catch(() => {});
    }
  }
}

async function main() {
  const tasks = ONLY_TASK ? TASKS.filter((t) => t.id === ONLY_TASK) : TASKS;
  if (!tasks.length) {
    throw new Error(`unknown task ${ONLY_TASK}`);
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'ffcli-eval-scratch-'));
  const binDir = mkdtempSync(join(tmpdir(), 'ffcli-eval-bin-'));
  const wrapper = join(binDir, 'firefox-cli');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cliBin}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  const results = [];
  for (const condition of ['cli', 'mcp']) {
    const stateDir = mkdtempSync(join(tmpdir(), `ffcli-eval-${condition}-`));
    console.log(`\n=== condition: ${condition} (model: ${MODEL}) ===`);
    await withInstance(stateDir, async (instance) => {
      const ctx = {
        scratchDir,
        binDir,
        stateDir,
        endpoint: instance.discovery.endpoint,
      };
      for (const task of tasks) {
        process.stdout.write(`  ${task.id}... `);
        try {
          const r = await runAgent(condition, task, ctx);
          results.push(r);
          console.log(
            `${r.success ? 'PASS' : 'FAIL'} turns=${r.turns} in=${r.input_tokens} ` +
              `cacheW=${r.cache_creation} cacheR=${r.cache_read} out=${r.output_tokens} ` +
              `$${r.cost_usd?.toFixed(4)} ${r.duration_s}s`
          );
        } catch (error) {
          console.log(`ERROR ${error.message}`);
          results.push({ condition, task: task.id, success: false, error: error.message });
        }
      }
    });
    rmSync(stateDir, { recursive: true, force: true });
  }
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });

  console.log('\n=== per-task results ===');
  console.table(
    results.map(({ answer, ...rest }) => rest)
  );

  console.log('=== totals per condition ===');
  const totals = {};
  for (const r of results) {
    const t = (totals[r.condition] ??= {
      tasks: 0,
      passed: 0,
      turns: 0,
      input_tokens: 0,
      cache_creation: 0,
      cache_read: 0,
      output_tokens: 0,
      cost_usd: 0,
      duration_s: 0,
    });
    t.tasks++;
    t.passed += r.success ? 1 : 0;
    t.turns += r.turns ?? 0;
    t.input_tokens += r.input_tokens ?? 0;
    t.cache_creation += r.cache_creation ?? 0;
    t.cache_read += r.cache_read ?? 0;
    t.output_tokens += r.output_tokens ?? 0;
    t.cost_usd += r.cost_usd ?? 0;
    t.duration_s += r.duration_s ?? 0;
  }
  for (const t of Object.values(totals)) {
    t.cost_usd = Math.round(t.cost_usd * 10000) / 10000;
    t.duration_s = Math.round(t.duration_s * 10) / 10;
  }
  console.table(totals);

  const out = join(tmpdir(), `firefox-cli-eval-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ model: MODEL, results, totals }, null, 2));
  console.log(`results written to ${out}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
