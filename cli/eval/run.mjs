// CLI-vs-MCP efficiency eval: run the same deterministic browser tasks through
// an agent backend twice — once with only a shell + firefox-cli, once with the
// MCP server attached — and compare success, turns, tokens, cost, duration.
//
//   node eval/run.mjs [--suite basic|web|all] [--task <id>] [--model <id>]
//                     [--backend anthropic|codex] [--headed]
//
// Suites: 'basic' = tiny data:-URL tasks; 'web' = simulated sites served from
// eval/pages/ (no live web). --headed launches visible Firefox windows.
// Results land in eval/results/ (gitignored) as JSON plus a shareable
// markdown report.

import { readFile } from 'node:fs/promises';
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, listInstances, stop } from '../lib/instances.mjs';
import { startPagesServer } from './server.mjs';
import { ANSWERS } from './answers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '..', 'bin', 'firefox-cli.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const BACKEND_NAME = flag('backend', 'anthropic');
const backend = await import(`./backends/${BACKEND_NAME}.mjs`);
const MODEL = flag('model', backend.DEFAULT_MODEL);
const SUITE = flag('suite', 'basic');
const ONLY_TASK = flag('task', null);
const HEADED = args.includes('--headed');

function basicTasks(base) {
  return [
    {
      id: 'title',
      maxTurns: 16,
      ask: `Open ${base}/basic/title.html in the browser. Report the exact page title.`,
      expect: new RegExp(ANSWERS.basic.title),
    },
    {
      id: 'click-reveal',
      maxTurns: 16,
      ask:
        `Open ${base}/basic/click-reveal.html in the browser. Click the "Reveal code" ` +
        `button and report the code that appears.`,
      expect: new RegExp(ANSWERS.basic.revealCode),
    },
    {
      id: 'form-fill',
      maxTurns: 16,
      ask:
        `Open ${base}/basic/form-fill.html in the browser. Type "Marmalade" into the ` +
        `name field, click the Greet button, and report the greeting text that appears.`,
      expect: new RegExp(ANSWERS.basic.greeting),
    },
  ];
}

async function webTasks(base) {
  const newsItems = JSON.parse(
    await readFile(join(here, 'pages', 'news', 'items.json'), 'utf8')
  );
  return [
    {
      id: 'gridword',
      maxTurns: 40,
      ask:
        `Open ${base}/gridword/?day=0 — a word puzzle. Play it until you solve it ` +
        `(you have 6 guesses; use the per-letter feedback shown after each guess to choose ` +
        `your next word). Then report the answer word and how many guesses you used.`,
      validate: (text) => ({
        pass: new RegExp(ANSWERS.gridword.day0Word, 'i').test(text),
      }),
    },
    {
      id: 'price-compare',
      maxTurns: 30,
      ask:
        `Three online stores sell computer monitors:\n` +
        `- ${base}/shop/voltro/\n- ${base}/shop/nexbuy/\n- ${base}/shop/gadgetron/\n` +
        `Find the cheapest IN-STOCK 27-inch 4K (UHD) monitor across all three stores. ` +
        `Report the winning product name, store, and price, plus the cheapest qualifying ` +
        `product you found at each store.`,
      validate: (text) => ({
        pass:
          text.includes(ANSWERS.priceCompare.overall.price) &&
          new RegExp(
            `${ANSWERS.priceCompare.overall.store}|ClaritySee`,
            'i'
          ).test(text),
      }),
    },
    {
      id: 'form-gauntlet',
      maxTurns: 35,
      ask:
        `Open ${base}/forms/ — an appointment request form. Fill it out with:\n` +
        `name: Maya Okafor, email: maya.okafor@example.com, phone: 312-555-0164,\n` +
        `service: Cleaning, insurance: Self-pay, new patient: Yes, date of birth: 1990-03-14,\n` +
        `preferred date: 2026-08-12, time: Morning, and give consent. Leave optional fields alone.\n` +
        `Proceed through the form to the review step and report the reference code shown. ` +
        `IMPORTANT: do NOT press the final Submit button.`,
      validate: (text, ctx) => {
        const walked = ctx.pages.state.progress.some((p) => p.body.includes('3'));
        return {
          pass:
            text.includes(ANSWERS.form.refCode) &&
            walked &&
            ctx.pages.state.submissions.length === 0,
          detail: `walked=${walked} submissions=${ctx.pages.state.submissions.length}`,
        };
      },
    },
    {
      id: 'gov-lookup',
      maxTurns: 25,
      ask:
        `Open ${base}/gov/ — a government agency site. Find the annual filing deadline ` +
        `for Form RV-7 and the URL of the RV-7 instructions page. Report both.`,
      validate: (text) => ({
        pass:
          /june\s*12/i.test(text) &&
          text.toLowerCase().includes(ANSWERS.gov.instructionsPath),
      }),
    },
    {
      id: 'news-extract',
      maxTurns: 25,
      ask:
        `Open ${base}/news/ — a link-aggregator front page. Extract the top 20 posts ` +
        `and output a markdown table with columns: rank, title, points, comments.`,
      validate: (text) => {
        const top20 = newsItems.slice(0, 20);
        const correct = top20.filter(
          (item) =>
            text.includes(item.title) &&
            text.includes(String(item.points)) &&
            text.includes(String(item.comments))
        ).length;
        return { pass: correct >= 18, detail: `rows correct: ${correct}/20` };
      },
    },
  ];
}

const CLI_CHEATSHEET = `You control a running Firefox via the \`firefox-cli\` shell command.
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
  return `${intro}\n\nTask: ${task.ask}\nAnswer concisely with the requested information.`;
}

async function runTask(condition, task, ctx) {
  const spec = {
    prompt: taskPrompt(condition, task),
    model: MODEL,
    maxTurns: task.maxTurns,
    condition,
    cwd: ctx.scratchDir,
    endpoint: ctx.endpoint,
    env: {
      ...process.env,
      PATH: `${ctx.binDir}:${process.env.PATH}`,
      FIREFOX_CLI_STATE_DIR: ctx.stateDir,
    },
  };
  // Stream the raw agent transcript (thinking, tool calls, results) to disk
  // as it happens rather than buffering.
  let transcriptStream = null;
  if (ctx.transcriptsDir) {
    transcriptStream = createWriteStream(
      join(ctx.transcriptsDir, `${condition}--${task.id}.jsonl`)
    );
    spec.onMessage = (message) =>
      transcriptStream.write(JSON.stringify(message) + '\n');
  }
  const wallStart = Date.now();
  let r;
  try {
    r = await backend.run(spec);
  } finally {
    transcriptStream?.end();
  }
  const wallMs = Date.now() - wallStart;
  const verdict = task.validate
    ? task.validate(r.text, ctx)
    : { pass: task.expect.test(r.text) };
  const tenth = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);
  return {
    condition,
    task: task.id,
    success: verdict.pass,
    detail: verdict.detail,
    answer: r.text.slice(0, 160).replace(/\n/g, ' '),
    turns: r.turns,
    input_tokens: r.input_tokens,
    cache_creation: r.cache_creation,
    cache_read: r.cache_read,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd,
    duration_s: tenth(r.duration_ms),
    api_s: tenth(r.api_duration_ms),
    wall_s: tenth(wallMs),
  };
}

function totalsByCondition(results) {
  const totals = {};
  for (const r of results) {
    const t = (totals[r.condition] ??= {
      tasks: 0, passed: 0, turns: 0, input_tokens: 0, cache_creation: 0,
      cache_read: 0, output_tokens: 0, cost_usd: 0, duration_s: 0, api_s: 0, wall_s: 0,
    });
    t.tasks++;
    t.passed += r.success ? 1 : 0;
    for (const key of ['turns', 'input_tokens', 'cache_creation', 'cache_read', 'output_tokens', 'cost_usd', 'duration_s', 'api_s', 'wall_s']) {
      t[key] += r[key] ?? 0;
    }
  }
  for (const t of Object.values(totals)) {
    t.cost_usd = Math.round(t.cost_usd * 10000) / 10000;
    for (const key of ['duration_s', 'api_s', 'wall_s']) {
      t[key] = Math.round(t[key] * 10) / 10;
    }
  }
  return totals;
}

function markdownReport({ meta, results, totals }) {
  const lines = [
    `# firefox-cli eval: CLI vs MCP`,
    '',
    `- date: ${meta.date}`,
    `- backend: ${meta.backend} · model: ${meta.model} · suite: ${meta.suite}`,
    `- tasks are simulated local pages (no live web); harness: cli/eval/run.mjs`,
    '',
    '## Totals per condition',
    '',
    '| condition | passed | turns | input | cache write | cache read | output | cost (USD) | api (s) | wall (s) |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [condition, t] of Object.entries(totals)) {
    lines.push(
      `| ${condition} | ${t.passed}/${t.tasks} | ${t.turns} | ${t.input_tokens} | ` +
        `${t.cache_creation} | ${t.cache_read} | ${t.output_tokens} | ${t.cost_usd} | ${t.api_s} | ${t.wall_s} |`
    );
  }
  lines.push('', '## Per-task results', '',
    '| condition | task | pass | turns | cache read | output | cost | api (s) | wall (s) | notes |',
    '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| ${r.condition} | ${r.task} | ${r.success ? 'PASS' : 'FAIL'} | ${r.turns ?? ''} | ` +
        `${r.cache_read ?? ''} | ${r.output_tokens ?? ''} | ${r.cost_usd?.toFixed?.(4) ?? ''} | ` +
        `${r.api_s ?? ''} | ${r.wall_s ?? ''} | ${r.detail ?? r.error ?? ''} |`
    );
  }
  lines.push('', '## Answers (truncated)', '');
  for (const r of results) {
    lines.push(`- **${r.condition}/${r.task}**: ${r.answer ?? '(error)'}`);
  }
  return lines.join('\n') + '\n';
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
  const pages = await startPagesServer();
  let tasks = [];
  if (SUITE === 'basic' || SUITE === 'all') {
    tasks.push(...basicTasks(pages.url));
  }
  if (SUITE === 'web' || SUITE === 'all') {
    tasks.push(...(await webTasks(pages.url)));
  }
  if (ONLY_TASK) {
    tasks = tasks.filter((t) => t.id === ONLY_TASK);
  }
  if (!tasks.length) {
    throw new Error(`no tasks selected (suite=${SUITE}, task=${ONLY_TASK})`);
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const runDir = join(here, 'results', `run-${stamp}`);
  const transcriptsDir = join(runDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });

  const scratchDir = mkdtempSync(join(tmpdir(), 'ffcli-eval-scratch-'));
  const binDir = mkdtempSync(join(tmpdir(), 'ffcli-eval-bin-'));
  const wrapper = join(binDir, 'firefox-cli');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cliBin}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  const results = [];
  for (const condition of ['cli', 'mcp']) {
    const stateDir = mkdtempSync(join(tmpdir(), `ffcli-eval-${condition}-`));
    console.log(`\n=== condition: ${condition} (backend: ${BACKEND_NAME}, model: ${MODEL}) ===`);
    await withInstance(stateDir, async (instance) => {
      const ctx = {
        scratchDir, binDir, stateDir, pages, transcriptsDir,
        endpoint: instance.discovery.endpoint,
      };
      for (const task of tasks) {
        if (pages) {
          pages.state.submissions.length = 0;
          pages.state.progress.length = 0;
        }
        process.stdout.write(`  ${task.id}... `);
        try {
          const r = await runTask(condition, task, ctx);
          results.push(r);
          console.log(
            `${r.success ? 'PASS' : 'FAIL'} turns=${r.turns} cacheR=${r.cache_read} ` +
              `out=${r.output_tokens} ${r.cost_usd?.toFixed?.(4) ?? '?'} wall=${r.wall_s}s api=${r.api_s ?? '?'}s` +
              (r.detail ? ` (${r.detail})` : '')
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
  await pages?.close();

  const totals = totalsByCondition(results);
  console.log('\n=== totals per condition ===');
  console.table(totals);

  const meta = {
    date: startedAt.toISOString(),
    backend: BACKEND_NAME,
    model: MODEL,
    suite: SUITE,
    task: ONLY_TASK ?? undefined,
  };
  const jsonPath = join(runDir, 'results.json');
  const mdPath = join(runDir, 'report.md');
  writeFileSync(jsonPath, JSON.stringify({ meta, results, totals }, null, 2));
  writeFileSync(mdPath, markdownReport({ meta, results, totals }));
  console.log(`\nrun dir: ${runDir}\nreport:  ${mdPath}`);

  const failed = results.filter((r) => !r.success).length;
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
