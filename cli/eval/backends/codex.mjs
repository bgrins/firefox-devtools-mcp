// Codex backend: drives tasks through OpenAI's Codex TypeScript SDK
// (@openai/codex-sdk), which shells out to the bundled `codex` CLI binary
// (`codex exec --experimental-json`) and streams JSONL events back.
// Backend interface (shared with backends/anthropic.mjs):
//   run({ prompt, model, maxTurns, condition, env, endpoint, cwd }) ->
//     { text, turns, input_tokens, cache_creation, cache_read, output_tokens,
//       cost_usd, duration_ms }
//
// SDK surface used: new Codex() -> codex.startThread({ model, sandboxMode,
// workingDirectory, skipGitRepoCheck }) -> await thread.run(prompt), which
// returns { items, finalResponse, usage } where usage is
// { input_tokens, cached_input_tokens, output_tokens }.
//
// The SDK exposes no way to pass shell env or MCP servers directly, but the
// codex binary reads $CODEX_HOME/config.toml, so we generate a throwaway
// CODEX_HOME per run (copying auth.json from the real one so ChatGPT auth
// still works) and inject settings there:
//   - condition 'cli': sandbox workspace-write with network_access = true
//     (firefox-cli only talks loopback HTTP) plus the state dir as a writable
//     root, and shell_environment_policy.set entries forcing the harness env
//     (PATH with the firefox-cli wrapper, FIREFOX_CLI_STATE_DIR) into every
//     shell command.
//   - condition 'mcp': [mcp_servers.firefox] with url = endpoint (streamable
//     HTTP). experimental_use_rmcp_client = true is included for codex
//     versions where HTTP MCP servers were gated behind that flag; newer
//     versions use it by default and tolerate the key.
// CODEX_HOME is applied by mutating process.env around the run because the
// spawned codex process inherits the parent environment; do not run this
// backend concurrently within one process.
//
// maxTurns is ignored: neither the SDK nor codex config exposes a cap on
// agent turns / tool-call rounds.

import { Codex } from '@openai/codex-sdk';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODEL = 'gpt-5.1-codex';

function toml(value) {
  return JSON.stringify(String(value));
}

function buildConfig({ condition, env, endpoint }) {
  const lines = ['approval_policy = "never"'];
  if (condition === 'cli') {
    lines.push('', '[sandbox_workspace_write]', 'network_access = true');
    if (env?.FIREFOX_CLI_STATE_DIR) {
      lines.push(`writable_roots = [${toml(env.FIREFOX_CLI_STATE_DIR)}]`);
    }
    lines.push('', '[shell_environment_policy]', 'inherit = "all"');
    const overrides = Object.entries(env ?? {}).filter(
      ([key, value]) => value != null && process.env[key] !== value,
    );
    if (overrides.length > 0) {
      lines.push('', '[shell_environment_policy.set]');
      for (const [key, value] of overrides) {
        lines.push(`${toml(key)} = ${toml(value)}`);
      }
    }
  } else {
    lines.push('experimental_use_rmcp_client = true');
    lines.push('', '[mcp_servers.firefox]', `url = ${toml(endpoint)}`);
  }
  return lines.join('\n') + '\n';
}

export async function run({ prompt, model, maxTurns, condition, env, endpoint, cwd }) {
  void maxTurns;
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-eval-'));
  const realHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  await copyFile(join(realHome, 'auth.json'), join(codexHome, 'auth.json')).catch(() => {});
  await writeFile(join(codexHome, 'config.toml'), buildConfig({ condition, env, endpoint }));

  const savedCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const started = Date.now();
  try {
    const codex = new Codex();
    const thread = codex.startThread({
      model,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      // 'cli' needs to execute firefox-cli; 'mcp' only needs MCP tool calls
      // (which bypass the command sandbox), so read-only is enough there.
      sandboxMode: condition === 'cli' ? 'workspace-write' : 'read-only',
    });
    const result = await thread.run(prompt);
    const items = result.items ?? [];
    const toolCalls = items.filter(
      (item) => item.type === 'command_execution' || item.type === 'mcp_tool_call',
    ).length;
    const usage = result.usage ?? {};
    return {
      text: result.finalResponse ?? '',
      // Codex reports one "turn" per run(); approximate agent turns as
      // tool-call rounds plus the final response.
      turns: toolCalls + 1,
      input_tokens: usage.input_tokens ?? 0,
      cache_creation: 0,
      cache_read: usage.cached_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cost_usd: null,
      duration_ms: Date.now() - started,
    };
  } finally {
    if (savedCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHome;
    }
    await rm(codexHome, { recursive: true, force: true }).catch(() => {});
  }
}
