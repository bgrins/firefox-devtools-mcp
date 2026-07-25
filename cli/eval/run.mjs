// CLI-vs-MCP efficiency eval: run the same deterministic browser tasks through
// an agent backend twice — once with only a shell + firefox-cli, once with the
// MCP server attached — and compare success, turns, tokens, cost, duration.
//
//   node eval/run.mjs [options] — see --help for the full flag list.
//
// Suites: 'basic' = tiny smoke pages, 'web' = simulated sites; both are
// served locally from eval/pages/ (no live web). --headed shows Firefox.
// Results land in eval/results/ (gitignored) as JSON plus a shareable
// markdown report.
//
// Common runs:
//   node eval/run.mjs
//     quick smoke: basic suite, cli+mcp, sequential
//   node eval/run.mjs --suite web --conditions cli,mcp,playwright --parallel --parallel-tasks 2
//     fast 3-condition iteration sweep (headless)
//   node eval/run.mjs --suite web --backend all --conditions cli,mcp,playwright --parallel --parallel-tasks 4 --headed
//     full demo matrix, both backends, tiled windows
//   node eval/run.mjs --suite web --repeat 3
//     sequential + repeats: use this for numbers you plan to share
//     (parallel wall timings carry machine-contention noise)
//   node eval/transcript.mjs [run-dir] [--task <id>]
//     inspect what the agents actually did

import { spawn, spawnSync } from 'node:child_process';
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
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
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
// Pin reasoning effort symmetrically across backends (Agent SDK `effort`,
// codex `model_reasoning_effort`); 'default' leaves each backend's own default.
const EFFORT = flag('effort', 'medium');
if (!['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(EFFORT)) {
  throw new Error(`--effort must be default|low|medium|high|xhigh|max, got "${EFFORT}"`);
}
const REPEAT = Number(flag('repeat', '1'));
if (!Number.isInteger(REPEAT) || REPEAT < 1) {
  throw new Error('--repeat must be a positive integer');
}
const SUITE = flag('suite', 'basic');
const ONLY_TASK = flag('task', null);
if (args.includes('--help') || args.includes('help')) {
  console.log(`firefox-cli eval harness — compare agent backends driving Firefox via
the firefox-cli shell command (cli) vs the MCP server (mcp).

Usage: node eval/run.mjs [options]

  --suite basic|web|all   task suite (default: basic; web = simulated sites)
  --task <id>             run a single task by id
  --repeat <n>            run each task n times; report adds per-task medians
  --model <id>            model for the agent backend
  --effort <level>        reasoning effort for both backends (default: medium;
                          'default' = leave backend defaults)
  --backend <names>       anthropic (default), codex, comma list, or 'all'
  --headed                visible Firefox windows, tiled into a screen-sized
                          grid (one cell per browser; wraps with a cascade
                          offset past capacity)
  --screen <WxH>          screen size for the headed grid (default: detected
                          on macOS, else 1920x1080)
  --mcp-transport <t>     stdio (default; agent spawns the MCP server, as real
                          client configs do) or http (shared instance endpoint)
  --conditions <list>     comma list of cli, mcp, playwright (default: cli,mcp);
                          playwright = vendored @playwright/mcp over stdio
                          driving Playwright Firefox
  --mcp-command "<cmd>"   custom stdio MCP server for the mcp condition, e.g.
                          "npx @playwright/mcp@latest --browser firefox";
                          replaces the built-in firefox-devtools-mcp server
  --parallel              run conditions concurrently
  --parallel-tasks <n>    run up to n tasks concurrently within each condition
                          (each worker gets its own browser + pages server;
                          wall timings gain contention noise)
  --help                  show this help

Results land in eval/results/run-<timestamp>/ (gitignored): results.json,
report.md (shareable), and transcripts/*.jsonl (full agent message streams).
Render transcripts with: node eval/transcript.mjs [run-dir] [--task <id>] [--md]`);
  process.exit(0);
}

const HEADED = args.includes('--headed');
const PARALLEL = args.includes('--parallel');
// Tasks-within-a-condition concurrency; each worker gets an isolated env
// (own pages server, state dir, and browser where the condition shares one).
const PARALLEL_TASKS = Number(flag('parallel-tasks', '1'));
if (!Number.isInteger(PARALLEL_TASKS) || PARALLEL_TASKS < 1) {
  throw new Error(`--parallel-tasks must be a positive integer`);
}
// 'stdio' spawns the MCP server per agent session, like real client configs
// (npx firefox-devtools-mcp); 'http' attaches the shared instance's endpoint.
const MCP_TRANSPORT = flag('mcp-transport', 'stdio');
if (!['stdio', 'http'].includes(MCP_TRANSPORT)) {
  throw new Error(`--mcp-transport must be stdio or http, got "${MCP_TRANSPORT}"`);
}
// Swap in any stdio MCP server (e.g. playwright-mcp) as the mcp condition.
// Naive whitespace split; quote-free commands only.
const MCP_COMMAND = flag('mcp-command', null);
if (MCP_COMMAND && MCP_TRANSPORT !== 'stdio') {
  throw new Error('--mcp-command requires --mcp-transport stdio');
}
const CUSTOM_MCP = MCP_COMMAND ? MCP_COMMAND.trim().split(/\s+/) : null;

// Named conditions. 'playwright' spawns the vendored @playwright/mcp over
// stdio (registered under the same 'firefox' server name) driving Playwright's
// own Firefox build.
const KNOWN_CONDITIONS = ['cli', 'mcp', 'playwright'];
const CONDITIONS = flag('conditions', 'cli,mcp')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const c of CONDITIONS) {
  if (!KNOWN_CONDITIONS.includes(c)) {
    throw new Error(`unknown condition "${c}" (known: ${KNOWN_CONDITIONS.join(', ')})`);
  }
}
const PLAYWRIGHT_MCP_CLI = join(here, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');

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
        const walked = ctx.pages.state
          .beaconsOf('form-progress')
          .some((b) => b.data?.step === 3);
        const submissions = ctx.pages.state.beaconsOf('form-submit').length;
        return {
          pass: text.includes(ANSWERS.form.refCode) && walked && submissions === 0,
          detail: `walked=${walked} submissions=${submissions}`,
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
      id: 'iframe-schedule',
      maxTurns: 20,
      ask:
        `Open ${base}/gov/offices.html — an agency's office locations page, which embeds ` +
        `a weekly schedule widget. What are the THURSDAY hours of the Harborview satellite ` +
        `office, per the embedded schedule? Report the opening and closing times.`,
      validate: (text) => ({
        pass: /10:00\s*a\.?m\.?/i.test(text) && /6:30\s*p\.?m\.?/i.test(text),
      }),
    },
    {
      id: 'shadow-unlock',
      maxTurns: 25,
      ask:
        `Open ${base}/shadow/ — a facility access console. Enter the access code ` +
        `"ORCHID-22" in the access widget and press Unlock. Report the exact message ` +
        `shown after unlocking.`,
      validate: (text, ctx) => {
        const unlocked = ctx.pages.state
          .beaconsOf('shadow-unlock')
          .some((b) => b.data?.code === ANSWERS.shadow.code);
        return {
          pass: unlocked && new RegExp(ANSWERS.shadow.message, 'i').test(text),
          detail: `unlocked=${unlocked}`,
        };
      },
    },
    {
      id: 'roster',
      maxTurns: 35,
      ask:
        `Open ${base}/forms/roster.html — a group registration form. Register these 4 ` +
        `attendees, using the "Add attendee" button as needed:\n` +
        `- Dara Voss / dara.voss@example.com\n- Lionel Prue / l.prue@example.com\n` +
        `- Mika Tanager / mika.t@example.com\n- Odette Brill / odette.brill@example.com\n` +
        `Submit the form and report the group code shown.`,
      validate: (text, ctx) => {
        const expected = [
          ['Dara Voss', 'dara.voss@example.com'],
          ['Lionel Prue', 'l.prue@example.com'],
          ['Mika Tanager', 'mika.t@example.com'],
          ['Odette Brill', 'odette.brill@example.com'],
        ];
        const submits = ctx.pages.state.beaconsOf('roster-submit');
        const good = submits.find(
          (b) =>
            b.data?.attendees?.length === 4 &&
            expected.every(([name, email]) =>
              b.data.attendees.some((a) => a.name === name && a.email === email)
            )
        );
        const code = good
          ? 'GRP-' + ctx.pages.state.sessions.get(good.sid).nonce.slice(0, 4).toUpperCase()
          : null;
        return {
          pass: submits.length === 1 && !!good && text.includes(code),
          detail: `submits=${submits.length} match=${!!good} code=${code}`,
        };
      },
    },
    {
      id: 'flaky-retry',
      maxTurns: 20,
      ask:
        `Open ${base}/flaky/ and load the quarterly report. The reporting backend is ` +
        `unreliable — retry if it fails. Report the Q3 total revenue figure.`,
      validate: (text, ctx) => {
        const sessions = [...ctx.pages.state.sessions.values()];
        const retried = sessions.some((s) => (s.reportAttempts ?? 0) >= 3);
        return {
          pass: text.includes('1,284,550') && retried,
          detail: `retried-in-session=${retried}`,
        };
      },
    },
    {
      id: 'handbook',
      maxTurns: 20,
      ask:
        `Open ${base}/gov/handbook.html — an agency's 30-section compliance handbook. ` +
        `Per section 22, what is the retention period for FIELD AUDIT LOGS? Report the period.`,
      validate: (text) => ({
        pass: /\b(7|seven)\s*years?\b/i.test(text),
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
      : condition === 'playwright' || CUSTOM_MCP
        ? 'You control a web browser via the connected "firefox" MCP tools.'
        : 'You control a running Firefox via the connected "firefox" MCP tools.';
  return `${intro}\n\nTask: ${task.ask}\nAnswer concisely with the requested information.`;
}

// Playwright drives its own Firefox build; download it (no-op when present)
// before any agent loop starts so install time never counts against a task.
function ensurePlaywrightFirefox() {
  return new Promise((resolve, reject) => {
    console.log('(checking Playwright Firefox is installed)');
    const child = spawn(
      process.execPath,
      [join(here, '..', 'node_modules', 'playwright', 'cli.js'), 'install', 'firefox'],
      { stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`playwright install firefox exited ${code}`))
    );
  });
}

function mcpStdioFor(condition, ctx) {
  if (condition === 'playwright') {
    return {
      command: process.execPath,
      args: [
        PLAYWRIGHT_MCP_CLI,
        '--browser',
        'firefox',
        '--isolated',
        ...(HEADED ? [] : ['--headless']),
      ],
    };
  }
  if (condition === 'mcp' && MCP_TRANSPORT === 'stdio') {
    return CUSTOM_MCP
      ? { command: CUSTOM_MCP[0], args: CUSTOM_MCP.slice(1) }
      : {
          command: process.execPath,
          args: [
            join(here, '..', '..', 'dist', 'index.js'),
            '--enable-script',
            ...(HEADED ? [] : ['--headless']),
            ...(ctx.stdioProfile ? ['--profile-path', ctx.stdioProfile] : []),
          ],
        };
  }
  return null;
}

async function runTask(backendName, condition, label, task, ctx, rep = 1) {
  const backend = BACKENDS[backendName];
  const spec = {
    prompt: taskPrompt(condition, task),
    model: modelFor(backendName),
    effort: EFFORT === 'default' ? null : EFFORT,
    maxTurns: task.maxTurns,
    condition,
    cwd: ctx.scratchDir,
    endpoint: ctx.endpoint,
    mcpStdio: mcpStdioFor(condition, ctx),
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
      join(
        ctx.transcriptsDir,
        `${label.replace('/', '--')}--${task.id}${rep > 1 ? `--r${rep}` : ''}.jsonl`
      )
    );
    transcriptStream.on('error', (error) =>
      console.error(`transcript write failed: ${error.message}`)
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
    ...(REPEAT > 1 ? { rep } : {}),
    model: modelFor(backendName) || '(backend default)',
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
    t.cost_known ||= r.cost_usd != null;
  }
  for (const t of Object.values(totals)) {
    t.cost_usd = t.cost_known ? Math.round(t.cost_usd * 10000) / 10000 : null;
    delete t.cost_known;
    for (const key of ['duration_s', 'api_s', 'wall_s']) {
      t[key] = Math.round(t[key] * 10) / 10;
    }
  }
  return totals;
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function medianLines(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.condition}|${r.task}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const lines = [
    '',
    '## Per-task medians across repeats',
    '',
    '| condition | task | pass | med turns | med input | med cache write | med cache read | med output | med cost (USD) | med api (s) | med wall (s) |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [key, rs] of groups) {
    const [condition, task] = key.split('|');
    const passed = rs.filter((r) => r.success).length;
    const cost = median(rs.map((r) => r.cost_usd));
    lines.push(
      `| ${condition} | ${task} | ${passed}/${rs.length} | ${median(rs.map((r) => r.turns)) ?? ''} | ` +
        `${median(rs.map((r) => r.input_tokens)) ?? ''} | ${median(rs.map((r) => r.cache_creation)) ?? ''} | ` +
        `${median(rs.map((r) => r.cache_read)) ?? ''} | ${median(rs.map((r) => r.output_tokens)) ?? ''} | ` +
        `${cost != null ? cost.toFixed(4) : ''} | ${median(rs.map((r) => r.api_s)) ?? ''} | ` +
        `${median(rs.map((r) => r.wall_s)) ?? ''} |`
    );
  }
  return lines;
}

function markdownReport({ meta, results, totals }) {
  const models = Object.entries(meta.models ?? {})
    .map(([b, m]) => `${b}: ${m}`)
    .join(', ');
  const lines = [
    `# firefox-cli eval: CLI vs MCP`,
    '',
    `- date: ${meta.date}`,
    `- backend: ${meta.backend} · models: ${models} · effort: ${meta.effort} · suite: ${meta.suite}` +
      (meta.repeat ? ` · repeat: ${meta.repeat}` : ''),
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
    '| condition | task | pass | turns | input | cache write | cache read | output | cost | api (s) | wall (s) | notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    lines.push(
      `| ${r.condition} | ${task} | ${r.success ? 'PASS' : 'FAIL'} | ${r.turns ?? ''} | ` +
        `${r.input_tokens ?? ''} | ${r.cache_creation ?? ''} | ` +
        `${r.cache_read ?? ''} | ${r.output_tokens ?? ''} | ${r.cost_usd?.toFixed?.(4) ?? ''} | ` +
        `${r.api_s ?? ''} | ${r.wall_s ?? ''} | ${r.detail ?? r.error ?? ''} |`
    );
  }
  if (meta.repeat) {
    lines.push(...medianLines(results));
  }
  lines.push('', '## Answers (truncated)', '');
  for (const r of results) {
    const task = r.rep ? `${r.task} (r${r.rep})` : r.task;
    lines.push(`- **${r.condition}/${task}**: ${r.answer ?? '(error)'}`);
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

// --- headed window grid ---------------------------------------------------
// Every positionable headed env (cli instances and stdio firefox-devtools-mcp;
// playwright has no window-position knob) claims a grid cell sized from the
// screen. Slots beyond capacity wrap with a cascade offset so stacked windows
// stay distinguishable.

// Conditions whose windows we can position via a seeded profile.
const POSITIONABLE = CONDITIONS.filter((c) => c !== 'playwright');
const TOTAL_SLOTS = BACKEND_NAMES.length * POSITIONABLE.length * PARALLEL_TASKS;

// Usable desktop area in top-left-origin coordinates.
let SCREEN = { w: 1920, h: 1040, top: 40, left: 0 };
function detectScreen() {
  const arg = flag('screen', null);
  if (arg) {
    const m = arg.match(/^(\d+)x(\d+)$/);
    if (!m) {
      throw new Error(`--screen must look like 1920x1080, got "${arg}"`);
    }
    SCREEN = { w: Number(m[1]), h: Number(m[2]) - 40, top: 40, left: 0 };
    return;
  }
  if (process.platform === 'darwin') {
    // NSScreen.visibleFrame excludes the menu bar and Dock, and (unlike
    // AppleScript app automation) needs no TCC permission. AppKit frames are
    // bottom-left-origin; convert the top offset.
    const out = spawnSync('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("AppKit"); const s = $.NSScreen.mainScreen; const v = s.visibleFrame; ' +
        'JSON.stringify({w: v.size.width, h: v.size.height, left: v.origin.x, ' +
        'top: s.frame.size.height - v.origin.y - v.size.height})',
    ]);
    try {
      const v = JSON.parse(String(out.stdout ?? ''));
      SCREEN = { w: v.w, h: v.h, top: v.top, left: v.left };
    } catch {
      // keep the default
    }
  }
}

// Deterministic slot per (backend, condition, worker) keeps a condition's
// workers adjacent in the grid.
function slotFor(backendName, condition, workerIndex) {
  const runIdx =
    BACKEND_NAMES.indexOf(backendName) * POSITIONABLE.length +
    POSITIONABLE.indexOf(condition);
  return runIdx * PARALLEL_TASKS + workerIndex;
}

function seedWindowGeometry(stateDir, slot) {
  const profileDir = join(stateDir, 'profile');
  mkdirSync(profileDir, { recursive: true });
  const cols = Math.ceil(Math.sqrt(TOTAL_SLOTS));
  const rows = Math.ceil(TOTAL_SLOTS / cols);
  const capacity = cols * rows;
  const cell = slot % capacity;
  const cascade = Math.floor(slot / capacity) * 30;
  const width = Math.floor(SCREEN.w / cols);
  const height = Math.floor(SCREEN.h / rows);
  const geometry = {
    'chrome://browser/content/browser.xhtml': {
      'main-window': {
        screenX: String(SCREEN.left + (cell % cols) * width + cascade),
        screenY: String(SCREEN.top + Math.floor(cell / cols) * height + cascade),
        width: String(width),
        height: String(height),
        sizemode: 'normal',
      },
    },
  };
  writeFileSync(join(profileDir, 'xulstore.json'), JSON.stringify(geometry));
  return profileDir;
}

// One isolated execution environment: pages server + state dir + (for
// conditions that share a browser across tool calls) a managed instance.
// Sequential runs use one env per condition; --parallel-tasks uses one per
// worker.
async function makeEnv(backendName, condition, label, workerIndex = 0) {
  // Each env gets its own pages server so validator state (sessions/beacons)
  // never mixes across concurrent agents.
  const pages = await startPagesServer();
  const stateDir = mkdtempSync(join(tmpdir(), `ffcli-eval-${condition}-`));
  const needsInstance =
    condition === 'cli' || (condition === 'mcp' && MCP_TRANSPORT === 'http');
  // Seed window geometry so headed windows tile into their grid cell
  // (stdio MCP servers launch their own Firefox and get it via --profile-path).
  const headedProfile =
    HEADED && POSITIONABLE.includes(condition)
      ? seedWindowGeometry(stateDir, slotFor(backendName, condition, workerIndex))
      : null;
  const stdioProfile = !needsInstance ? headedProfile : null;
  let instance = null;
  if (needsInstance) {
    // launch()/listInstances() read FIREFOX_CLI_STATE_DIR from process.env;
    // the lock only guards that mutation. Concurrent Firefox cold starts are
    // fine (the old SIGABRT was codex-sandboxed launches, not contention).
    instance = await withEnvLock(async () => {
      process.env.FIREFOX_CLI_STATE_DIR = stateDir;
      return launch({
        headless: !HEADED,
        ...(headedProfile ? { profile: headedProfile } : {}),
      });
    });
    // Firefox starts lazily on the first tool call; warm it up so startup
    // never counts against the first task.
    await callTool(instance.discovery.endpoint, 'list_pages', {}).catch((error) =>
      console.log(`[${label}] warm-up failed: ${error.message}`)
    );
  }
  return {
    pages,
    stateDir,
    stdioProfile,
    endpoint: instance?.discovery.endpoint ?? null,
    async close() {
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
    },
  };
}

async function runCondition(backendName, condition, shared) {
  const label = BACKEND_NAMES.length > 1 ? `${backendName}/${condition}` : condition;
  console.log(`[${label}] starting (model: ${modelFor(backendName) || '(backend default)'})`);

  async function runOne(env, item) {
    // Task asks embed the env's pages URL, so rebuild against this env.
    const task = (await buildTasks(env.pages.url)).find((t) => t.id === item.id);
    const tag = REPEAT > 1 ? `${item.id} (r${item.rep})` : item.id;
    env.pages.state.reset();
    try {
      const ctx = {
        ...shared,
        stateDir: env.stateDir,
        pages: env.pages,
        endpoint: env.endpoint,
        stdioProfile: env.stdioProfile,
      };
      const r = await runTask(backendName, condition, label, task, ctx, item.rep);
      console.log(
        `[${label}] ${tag}: ${r.success ? 'PASS' : 'FAIL'} turns=${r.turns} ` +
          `in=${r.input_tokens} cacheW=${r.cache_creation} cacheR=${r.cache_read} ` +
          `out=${r.output_tokens} $${r.cost_usd?.toFixed?.(4) ?? '?'} ` +
          `wall=${r.wall_s}s api=${r.api_s ?? '?'}s` +
          (r.detail ? ` (${r.detail})` : '')
      );
      return r;
    } catch (error) {
      console.log(`[${label}] ${tag}: ERROR ${error.message}`);
      return { backend: backendName, condition: label, task: item.id, rep: item.rep, success: false, error: error.message };
    }
  }

  const items = (await buildTasks('http://placeholder')).flatMap((t) =>
    Array.from({ length: REPEAT }, (_, i) => ({ id: t.id, rep: i + 1 }))
  );
  if (PARALLEL_TASKS > 1) {
    const queue = [...items];
    const done = new Map();
    const keyOf = (item) => `${item.id}#${item.rep}`;
    const workerCount = Math.min(PARALLEL_TASKS, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async (_, workerIndex) => {
        const env = await makeEnv(backendName, condition, label, workerIndex);
        try {
          while (queue.length) {
            const item = queue.shift();
            done.set(keyOf(item), await runOne(env, item));
          }
        } finally {
          await env.close().catch(() => {});
        }
      })
    );
    return items.map((item) => done.get(keyOf(item))).filter(Boolean);
  }

  const env = await makeEnv(backendName, condition, label);
  try {
    const results = [];
    for (const item of items) {
      results.push(await runOne(env, item));
    }
    return results;
  } finally {
    await env.close().catch(() => {});
  }
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

  if (CONDITIONS.includes('playwright')) {
    await ensurePlaywrightFirefox();
  }
  if (HEADED) {
    detectScreen();
  }

  const runs = BACKEND_NAMES.flatMap((backendName) =>
    CONDITIONS.map((condition) => [backendName, condition])
  );
  let results = [];
  if (PARALLEL) {
    console.log('(parallel mode: runs execute side by side; wall timings may include contention)\n');
    // allSettled so one condition's failure still lets the others finish and
    // tear down their instances/servers.
    const settled = await Promise.allSettled(
      runs.map(([b, c]) => runCondition(b, c, shared))
    );
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        const [b, c] = runs[i];
        console.error(`[${b}/${c}] condition failed: ${outcome.reason?.message}`);
        results.push({ backend: b, condition: `${b}/${c}`, task: '(condition)', success: false, error: outcome.reason?.message });
      }
    }
  } else {
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
    models: Object.fromEntries(
      BACKEND_NAMES.map((n) => [n, modelFor(n) || '(backend default)'])
    ),
    effort: EFFORT,
    suite: SUITE,
    task: ONLY_TASK ?? undefined,
    repeat: REPEAT > 1 ? REPEAT : undefined,
    conditions: CONDITIONS.join(','),
    mcpTransport: MCP_TRANSPORT,
    mcpCommand: MCP_COMMAND ?? undefined,
    parallel: PARALLEL || undefined,
    parallelTasks: PARALLEL_TASKS > 1 ? PARALLEL_TASKS : undefined,
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
