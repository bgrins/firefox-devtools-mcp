import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function stateDir() {
  return (
    process.env.FIREFOX_CLI_STATE_DIR || join(homedir(), '.firefox-devtools-mcp', 'cli')
  );
}

function instancesDir() {
  return join(stateDir(), 'instances');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function listInstances() {
  let entries = [];
  try {
    entries = readdirSync(instancesDir());
  } catch {
    return [];
  }
  const instances = [];
  for (const id of entries) {
    const dir = join(instancesDir(), id);
    const meta = readJson(join(dir, 'meta.json'));
    if (!meta) {
      continue;
    }
    const discovery = readJson(join(dir, 'discovery.json'));
    const alive = pidAlive(meta.runnerPid);
    let status = 'stopped';
    if (alive) {
      status = discovery ? 'running' : 'starting';
    }
    instances.push({ ...meta, dir, discovery, status });
  }
  return instances;
}

export function resolveInstance(flags) {
  const instances = listInstances();
  if (flags.instance) {
    const match = instances.find((i) => i.id === flags.instance);
    if (!match) {
      throw new Error(`No instance "${flags.instance}". Known: ${instances.map((i) => i.id).join(', ') || '(none)'}`);
    }
    return match;
  }
  const running = instances.filter((i) => i.status === 'running');
  if (running.length === 1) {
    return running[0];
  }
  if (!running.length) {
    throw new Error('No running instance. Start one with: firefox-cli launch');
  }
  throw new Error(
    `Multiple running instances (${running.map((i) => i.id).join(', ')}); pick one with --instance <id>`
  );
}

// The Node MCP runner entry point: sibling of cli/ in this repo, overridable
// for installed layouts.
function runnerEntry() {
  if (process.env.FIREFOX_MCP_ENTRY) {
    return process.env.FIREFOX_MCP_ENTRY;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const inRepo = join(here, '..', '..', 'dist', 'index.js');
  if (existsSync(inRepo)) {
    return inRepo;
  }
  throw new Error(
    'Cannot find the firefox-devtools-mcp entry point (build the repo, or set FIREFOX_MCP_ENTRY)'
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(flags) {
  const id = randomBytes(3).toString('hex');
  const dir = join(instancesDir(), id);
  mkdirSync(dir, { recursive: true });
  const discoveryPath = join(dir, 'discovery.json');
  const logPath = join(dir, 'runner.log');

  const args = [
    runnerEntry(),
    '--http-port',
    '0',
    '--discovery-file',
    discoveryPath,
    '--enable-script',
  ];
  if (flags.headless) {
    args.push('--headless');
  }
  if (flags.binary) {
    args.push('--firefox-path', String(flags.binary));
  }
  if (flags.profile) {
    args.push('--profile-path', String(flags.profile));
  }

  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  closeSync(log);

  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ id, runnerPid: child.pid, createdAt: Date.now(), args }, null, 2)
  );

  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 30000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovery = readJson(discoveryPath);
    if (discovery) {
      return { id, dir, discovery, runnerPid: child.pid };
    }
    if (!pidAlive(child.pid)) {
      throw new Error(`Runner exited during startup; see ${logPath}`);
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${discoveryPath}; see ${logPath}`);
}

export async function stop(instance) {
  if (!pidAlive(instance.runnerPid)) {
    return false;
  }
  process.kill(instance.runnerPid, 'SIGTERM');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!pidAlive(instance.runnerPid)) {
      return true;
    }
    await sleep(100);
  }
  process.kill(instance.runnerPid, 'SIGKILL');
  return true;
}

export function readLog(instance, lines) {
  const logPath = join(instance.dir, 'runner.log');
  let content = '';
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return `(no log at ${logPath})`;
  }
  const all = content.trimEnd().split('\n');
  return all.slice(-(lines ?? 50)).join('\n');
}
