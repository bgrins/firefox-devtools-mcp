// Golden-path self-test: proves each eval task is still SOLVABLE and that its
// validator still accepts a correct solution and rejects a wrong one — without
// spending agent budget.
//
//   node eval/verify.mjs [--task <ids>] [--headed] [--list]
//
// Why this exists: every fixture change risks silently breaking a task (a
// restyle once changed measured behaviour with no logic change) and every
// validator risks failing correct answers (repeatedly our most common defect).
// An agent sweep catches both, at ~$20 and ~30 minutes. This catches most of it
// in minutes for nothing.
//
// It drives the browser through OUR OWN MCP server (dogfooding: the same
// surface the `mcp` condition uses), so a green run also means our snapshot and
// tool surface are sufficient to win the task. That is deliberately NOT true of
// a Playwright-driven equivalent, which would prove only that the fixture works.
//
// Each driver returns the answer text a correct agent would produce, having done
// the real interaction so the server-observed gates are genuinely satisfied.
// Tasks whose success is prose or judgment (a written summary, a phishing
// verdict) can only have their interaction driven and their prose supplied
// canned — those are marked `canned: true` and prove the validator accepts a
// correct answer, not that composing one is possible.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, listInstances, stop } from '../lib/instances.mjs';
import { callTool } from '../lib/mcp.mjs';
import { startPagesServer } from './server.mjs';
import { DRIVERS } from './verify-drivers/index.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const HEADED = args.includes('--headed');
const ONLY = flag('task', null);
const patterns = ONLY ? ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;
const selected = (id) => !patterns || patterns.some((p) => (p.includes('*')
  ? new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(id)
  : p === id));

// The validators live inline in run.mjs, which auto-runs main() on import, so
// slice webTasks() out of the source and eval it instead.
async function loadTasks(base) {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('async function webTasks(');
  if (start === -1) throw new Error('could not find webTasks() in run.mjs');
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  const body = src.slice(open, i + 1);
  const { ANSWERS } = await import('./answers.mjs');
  const fn = new Function(
    'ANSWERS', 'readFile', 'join', 'here', 'base',
    `return (async function webTasks(base) ${body})(base);`
  );
  return fn(ANSWERS, readFile, join, new URL('.', import.meta.url).pathname, base);
}

if (args.includes('--list')) {
  const tasks = await loadTasks('http://placeholder');
  const withDriver = tasks.filter((t) => DRIVERS[t.id]);
  console.log(`${withDriver.length}/${tasks.length} tasks have a golden path\n`);
  for (const t of tasks) {
    const d = DRIVERS[t.id];
    console.log(
      `  ${d ? (d.canned ? 'canned ' : 'driven ') : '  --   '} ${t.id}` +
        (d?.note ? `  (${d.note})` : '')
    );
  }
  console.log('\ndriven = interaction and answer both produced by the driver');
  console.log('canned = interaction driven, prose supplied (judgment/composition task)');
  console.log('  --   = no golden path yet');
  process.exit(0);
}

const pages = await startPagesServer();
const stateDir = mkdtempSync(join(tmpdir(), 'ffcli-verify-'));
process.env.FIREFOX_CLI_STATE_DIR = stateDir;
const instance = await launch({ headless: !HEADED });
const endpoint = instance.discovery.endpoint;
const mcp = (name, toolArgs = {}) => callTool(endpoint, name, toolArgs);
// Most drivers only need to navigate and read/poke the page; uid-based tools are
// available too, and using them is what makes this a real dogfood of the surface.
const helpers = {
  mcp,
  base: pages.url,
  goto: (path) => mcp('navigate_page', { url: pages.url + path }),
  evaluate: async (fn, fnArgs) => {
    const r = await mcp('evaluate_script', { function: String(fn), args: fnArgs });
    const text = (r.content ?? []).map((c) => c.text).join('\n');
    const m = text.match(/```json\n([\s\S]*?)\n```/);
    if (!m) return text;
    // A function with no return value comes back as the literal `undefined`,
    // which is not JSON; treat any unparseable payload as raw text.
    try {
      return JSON.parse(m[1]);
    } catch {
      return m[1] === 'undefined' ? undefined : m[1];
    }
  },
  snapshot: async () => {
    const r = await mcp('take_snapshot', {});
    return (r.content ?? []).map((c) => c.text).join('\n');
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

try {
  const tasks = await loadTasks(pages.url);
  for (const task of tasks) {
    if (!selected(task.id)) continue;
    const driver = DRIVERS[task.id];
    if (!driver) {
      skipped++;
      continue;
    }
    const ctx = { pages };
    pages.state.reset();
    let answer;
    try {
      answer = await driver.run(helpers, ctx);
    } catch (error) {
      fail++;
      failures.push(`${task.id}: driver threw — ${error.message}`);
      console.log(`FAIL  ${task.id}  driver threw: ${error.message}`);
      continue;
    }
    const good = task.validate(answer, ctx);
    // The same server state must REJECT a wrong answer, or the validator is
    // only checking the interaction and would pass any prose.
    const bad = task.validate(driver.wrong ?? 'The answer is 42.', ctx);
    const ok = good.pass === true && bad.pass === false;
    if (ok) {
      pass++;
      console.log(`ok    ${task.id}${driver.canned ? '  (canned prose)' : ''}`);
    } else {
      fail++;
      const why = good.pass !== true
        ? `validator REJECTED a correct solution — ${good.detail ?? ''}`
        : `validator ACCEPTED a wrong answer — ${bad.detail ?? ''}`;
      failures.push(`${task.id}: ${why}`);
      console.log(`FAIL  ${task.id}  ${why}`);
    }
  }
} finally {
  for (const inst of listInstances()) await stop(inst).catch(() => {});
  await pages.close();
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} failed, ${skipped} without a golden path`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail ? 1 : 0;
