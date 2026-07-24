// CLI-vs-MCP efficiency eval: run the same deterministic browser tasks through
// an agent backend twice — once with only a shell + firefox-cli, once with the
// MCP server attached — and compare success, turns, tokens, cost, duration.
//
//   node eval/run.mjs [--suite basic|web|all] [--task <id>] [--model <id>]
//                     [--backend anthropic|codex] [--headed] [--parallel]
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
import { callTool } from '../lib/mcp.mjs';
import { startPagesServer } from './server.mjs';
import { ANSWERS } from './answers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, '..', 'bin', 'firefox-cli.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const BACKEND_ARG = flag('backend', 'anthropic');
const BACKEND_NAMES =
  BACKEND_ARG === 'all' ? ['anthropic', 'codex'] : BACKEND_ARG.split(',');
const BACKENDS = Object.fromEntries(
  await Promise.all(
    BACKEND_NAMES.map(async (name) => [name, await import(`./backends/${name}.mjs`)])
  )
);
const MODEL_FLAG = flag('model', null);
if (MODEL_FLAG && BACKEND_NAMES.length > 1) {
  throw new Error('--model cannot be combined with multiple backends; each uses its default');
}
const modelFor = (name) => MODEL_FLAG ?? BACKENDS[name].DEFAULT_MODEL;
const SUITE = flag('suite', 'basic');
const ONLY_TASK = flag('task', null);
if (args.includes('--help') || args.includes('help')) {
  console.log(`firefox-cli eval harness — compare agent backends driving Firefox via
the firefox-cli shell command (cli) vs the MCP server (mcp).

Usage: node eval/run.mjs [options]

  --suite basic|web|all   task suite (default: basic; web = simulated sites)
  --task <id>             run a single task by id
  --model <id>            model for the agent backend
  --backend <names>       anthropic (default), codex, comma list, or 'all'
  --headed                visible Firefox windows (side-by-side with --parallel)
  --mcp-transport <t>     stdio (default; agent spawns the MCP server, as real
                          client configs do) or http (shared instance endpoint)
  --parallel              run cli and mcp conditions concurrently
  --help                  show this help

Results land in eval/results/run-<timestamp>/ (gitignored): results.json,
report.md (shareable), and transcripts/*.jsonl (full agent message streams).`);
  process.exit(0);
}

const HEADED = args.includes('--headed');
const PARALLEL = args.includes('--parallel');
// 'stdio' spawns the MCP server per agent session, like real client configs
// (npx firefox-devtools-mcp); 'http' attaches the shared instance's endpoint.
const MCP_TRANSPORT = flag('mcp-transport', 'stdio');

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
  const topThread = JSON.parse(
    await readFile(join(here, 'pages', 'news', 'threads', 'item-1.json'), 'utf8')
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
      id: 'news-thread',
      maxTurns: 25,
      ask:
        `Open ${base}/news/ — a link-aggregator front page. Open the comment thread ` +
        `for the #1 top post and report: the title of the post and how many top-level ` +
        `(non-reply) comments are shown in the thread.`,
      validate: (text) => {
        const topLevel = topThread.comments.length;
        return {
          pass:
            text.includes(newsItems[0].title.slice(0, 30)) &&
            new RegExp(`\\b${topLevel}\\b`).test(text),
          detail: `expected top-level=${topLevel}`,
        };
      },
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
Exactly one managed Firefox instance is ALREADY RUNNING for you — never run
\`firefox-cli launch\`, \`stop\`, or \`servers\`. If a command errors, retry it
or adjust its arguments instead of managing instances.

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

async function runTask(backendName, condition, label, task, ctx) {
  const backend = BACKENDS[backendName];
  const spec = {
    prompt: taskPrompt(condition, task),
    model: modelFor(backendName),
    maxTurns: task.maxTurns,
    condition,
    cwd: ctx.scratchDir,
    endpoint: ctx.endpoint,
    mcpStdio:
      condition === 'mcp' && MCP_TRANSPORT === 'stdio'
        ? {
            command: process.execPath,
            args: [
              join(here, '..', '..', 'dist', 'index.js'),
              '--enable-script',
              ...(HEADED ? [] : ['--headless']),
            ],
          }
        : null,
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
      join(ctx.transcriptsDir, `${label.replace('/', '--')}--${task.id}.jsonl`)
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
    backend: backendName,
    condition: label,
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

// launch()/listInstances() read FIREFOX_CLI_STATE_DIR from process.env, so
// concurrent conditions serialize just their launch/teardown around it.
let envLock = Promise.resolve();
function withEnvLock(fn) {
  const next = envLock.then(fn);
  envLock = next.catch(() => {});
  return next;
}

async function buildTasks(base) {
  let tasks = [];
  if (SUITE === 'basic' || SUITE === 'all') {
    tasks.push(...basicTasks(base));
  }
  if (SUITE === 'web' || SUITE === 'all') {
    tasks.push(...(await webTasks(base)));
  }
  if (ONLY_TASK) {
    tasks = tasks.filter((t) => t.id === ONLY_TASK);
  }
  return tasks;
}

// Pre-seed window geometry so headed windows tile side by side (cli left,
// mcp right) instead of stacking.
function seedWindowGeometry(stateDir, backendName, condition) {
  const profileDir = join(stateDir, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const col = condition === 'cli' ? 0 : 1;
  const row = BACKEND_NAMES.indexOf(backendName);
  const rows = BACKEND_NAMES.length;
  const height = rows > 1 ? 470 : 920;
  const geometry = {
    'chrome://browser/content/browser.xhtml': {
      'main-window': {
        screenX: String(col * 880),
        screenY: String(40 + row * (height + 30)),
        width: '860',
        height: String(height),
        sizemode: 'normal',
      },
    },
  };
  writeFileSync(join(profileDir, 'xulstore.json'), JSON.stringify(geometry));
  return profileDir;
}

async function runCondition(backendName, condition, shared) {
  const label = BACKEND_NAMES.length > 1 ? `${backendName}/${condition}` : condition;
  // Each condition gets its own pages server so form-state validation
  // (submissions/progress) stays isolated when running in parallel.
  const pages = await startPagesServer();
  const tasks = await buildTasks(pages.url);
  const stateDir = mkdtempSync(join(tmpdir(), `ffcli-eval-${condition}-`));
  const results = [];
  const needsInstance = condition === 'cli' || MCP_TRANSPORT === 'http';
  console.log(`[${label}] starting (model: ${modelFor(backendName) || '(backend default)'})`);
  const instance = !needsInstance ? null : await withEnvLock(async () => {
    process.env.FIREFOX_CLI_STATE_DIR = stateDir;
    const inst = await launch({
      headless: !HEADED,
      ...(HEADED ? { profile: seedWindowGeometry(stateDir, backendName, condition) } : {}),
    });
    // Firefox starts lazily on the first tool call. Warm it up while still
    // serialized: concurrent cold starts can SIGABRT in macOS
    // RegisterApplication/LaunchServices when several instances register at
    // once (TransformProcessType abort).
    await callTool(inst.discovery.endpoint, 'list_pages', {}).catch((error) =>
      console.log(`[${label}] warm-up failed: ${error.message}`)
    );
    return inst;
  });
  try {
    const ctx = {
      ...shared,
      stateDir,
      pages,
      endpoint: instance?.discovery.endpoint ?? null,
    };
    for (const task of tasks) {
      pages.state.submissions.length = 0;
      pages.state.progress.length = 0;
      try {
        const r = await runTask(backendName, condition, label, task, ctx);
        results.push(r);
        console.log(
          `[${label}] ${task.id}: ${r.success ? 'PASS' : 'FAIL'} turns=${r.turns} ` +
            `cacheR=${r.cache_read} out=${r.output_tokens} $${r.cost_usd?.toFixed?.(4) ?? '?'} ` +
            `wall=${r.wall_s}s api=${r.api_s ?? '?'}s` +
            (r.detail ? ` (${r.detail})` : '')
        );
      } catch (error) {
        console.log(`[${label}] ${task.id}: ERROR ${error.message}`);
        results.push({ backend: backendName, condition: label, task: task.id, success: false, error: error.message });
      }
    }
  } finally {
    if (needsInstance) {
      await withEnvLock(async () => {
        process.env.FIREFOX_CLI_STATE_DIR = stateDir;
        for (const inst of listInstances()) {
          await stop(inst).catch(() => {});
        }
      });
    }
    await pages.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
  return results;
}

async function main() {
  if (!(await buildTasks('http://placeholder')).length) {
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
  const shared = { scratchDir, binDir, transcriptsDir };

  const runs = BACKEND_NAMES.flatMap((backendName) =>
    ['cli', 'mcp'].map((condition) => [backendName, condition])
  );
  let results;
  if (PARALLEL) {
    console.log('(parallel mode: runs execute side by side; wall timings may include contention)\n');
    results = (
      await Promise.all(runs.map(([b, c]) => runCondition(b, c, shared)))
    ).flat();
  } else {
    results = [];
    for (const [b, c] of runs) {
      results.push(...(await runCondition(b, c, shared)));
    }
  }
  rmSync(scratchDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });

  const totals = totalsByCondition(results);
  console.log('\n=== totals per condition ===');
  console.table(totals);

  const meta = {
    date: startedAt.toISOString(),
    backend: BACKEND_NAMES.join(','),
    model: MODEL_FLAG ?? '(backend defaults)',
    suite: SUITE,
    task: ONLY_TASK ?? undefined,
    mcpTransport: MCP_TRANSPORT,
    parallel: PARALLEL || undefined,
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
