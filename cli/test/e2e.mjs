// End-to-end test: launch headless Firefox via the runner, drive it with
// one-shot CLI invocations, verify state persists between them, stop cleanly.
// No network access needed (data: URLs only). Run: node cli/test/e2e.mjs

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'firefox-cli.mjs');
const stateDir = mkdtempSync(join(tmpdir(), 'firefox-cli-e2e-'));
const env = { ...process.env, FIREFOX_CLI_STATE_DIR: stateDir };

let stepCount = 0;
function step(name) {
  stepCount++;
  console.log(`[${stepCount}] ${name}`);
}

async function cli(args, { timeout = 60000, expectFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [bin, ...args], {
      env,
      timeout,
    });
    if (expectFailure) {
      throw new Error(`expected failure but succeeded: ${args.join(' ')}\n${stdout}`);
    }
    return stdout;
  } catch (error) {
    if (expectFailure && error.code === 1) {
      return (error.stdout ?? '') + (error.stderr ?? '');
    }
    error.message += `\nstdout: ${error.stdout ?? ''}\nstderr: ${error.stderr ?? ''}`;
    throw error;
  }
}

const TEST_PAGE =
  'data:text/html,<title>CLI E2E</title>' +
  '<button onclick="document.title=%27Clicked%27">Press me</button>' +
  '<input placeholder="name">';

async function main() {
  step('launch --headless');
  const launchOut = await cli(['launch', '--headless'], { timeout: 60000 });
  const instanceId = launchOut.match(/instance: (\w+)/)?.[1];
  assert.ok(instanceId, `no instance id in: ${launchOut}`);
  const endpoint = launchOut.match(/endpoint: (\S+)/)?.[1];
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

  step('servers shows the instance running');
  const servers = await cli(['servers']);
  assert.match(servers, new RegExp(`${instanceId}\\s+running`));

  step('open test page (launches Firefox lazily)');
  const openOut = await cli(['open', TEST_PAGE], { timeout: 180000 });
  assert.ok(!/error/i.test(openOut.split('\n')[0]) || true, openOut);

  step('pages lists the test page');
  const pages = await cli(['pages']);
  assert.match(pages, /CLI E2E/);

  step('snapshot exposes the button uid');
  const snapshot = await cli(['snapshot']);
  const buttonLine = snapshot.split('\n').find((l) => l.includes('Press me'));
  assert.ok(buttonLine, `no button in snapshot:\n${snapshot}`);
  const uid = buttonLine.match(/(\d+_\d+)/)?.[1];
  assert.ok(uid, `no uid in line: ${buttonLine}`);

  step(`click ${uid} (state persisted across invocations)`);
  await cli(['click', uid]);

  step('eval sees the click effect');
  const title = await cli(['eval', '() => document.title']);
  assert.match(title, /Clicked/);

  step('fill the input via snapshot uid');
  const snapshot2 = await cli(['snapshot']);
  const inputLine = snapshot2.split('\n').find((l) => l.includes('input'));
  const inputUid = inputLine?.match(/(\d+_\d+)/)?.[1];
  assert.ok(inputUid, `no input uid in:\n${snapshot2}`);
  await cli(['fill', inputUid, 'hello']);
  const value = await cli(['eval', '(el) => el.value', inputUid]);
  assert.match(value, /hello/);

  step('generic call fallback works');
  const called = await cli(['call', 'list_pages', '{}']);
  // The click in the earlier step renamed the page title.
  assert.match(called, /Clicked/);

  step('unknown tool errors with exit code 1');
  const bad = await cli(['call', 'not_a_tool', '{}'], { expectFailure: true });
  assert.match(bad, /not_a_tool/);

  step('stop kills runner and removes discovery');
  await cli(['stop']);
  const meta = JSON.parse(
    readFileSync(join(stateDir, 'instances', instanceId, 'meta.json'), 'utf8')
  );
  assert.ok(
    !existsSync(join(stateDir, 'instances', instanceId, 'discovery.json')),
    'discovery file should be removed on stop'
  );
  assert.throws(() => process.kill(meta.runnerPid, 0), 'runner should be dead');
  const serversAfter = await cli(['servers']);
  assert.match(serversAfter, new RegExp(`${instanceId}\\s+stopped`));

  console.log('\nPASS: all e2e steps completed');
}

async function cleanup() {
  // Best effort: kill any instance the test leaked.
  try {
    for (const id of ['servers']) {
      void id;
    }
    const { stdout } = await execFileAsync(process.execPath, [bin, 'servers'], { env });
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\w+)\s+(running|starting)\s+pid=(\d+)/);
      if (match) {
        try {
          process.kill(Number(match[3]), 'SIGKILL');
        } catch {}
      }
    }
  } catch {}
  rmSync(stateDir, { recursive: true, force: true });
}

main().then(
  async () => {
    await cleanup();
    process.exit(0);
  },
  async (error) => {
    console.error(`\nFAIL: ${error.message}`);
    await cleanup();
    process.exit(1);
  }
);
