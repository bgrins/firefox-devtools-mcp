// Codex backend: drives tasks through OpenAI's Codex SDK (@openai/codex-sdk),
// which shells out to the `codex` CLI and streams JSONL events back.
// Same interface as backends/anthropic.mjs (see its header), including the
// onMessage transcript sink (receives raw ThreadEvents).
//
// condition 'cli': commands run in the workspace-write sandbox with network
//   access enabled (firefox-cli only talks loopback HTTP) and the state dir
//   added as a writable root. The harness env (PATH with the firefox-cli
//   wrapper, FIREFOX_CLI_STATE_DIR) is passed to the codex process, which
//   shell commands inherit.
// condition 'mcp': the MCP server is spawned over stdio (`mcpStdio`) by
//   default, or attached via the streamable HTTP `endpoint`, through a
//   `mcp_servers` config override (the SDK flattens `config` into --config
//   flags). Tools are auto-approved (default_tools_approval_mode) since
//   codex otherwise cancels non-read-only MCP tools under approval 'never';
//   MCP tool calls bypass the command sandbox, so read-only is enough.
//
// maxTurns is not enforced — the SDK has no equivalent option.
// cost_usd / api_duration_ms are not reported by codex.

import { Codex } from '@openai/codex-sdk';
import { tmpdir } from 'node:os';

// Pinned explicitly (rather than deferring to ~/.codex/config.toml) so runs
// are reproducible and the model is recorded in results. terra is the
// sonnet-4-6-equivalent tier.
export const DEFAULT_MODEL = 'gpt-5.6-terra';

export async function run({ prompt, model, effort, condition, env, endpoint, cwd, onMessage, mcpStdio }) {
  const codexOptions = {
    // When env is provided the SDK does not inherit process.env, so run.mjs
    // builds it from the full process.env.
    env: { ...env },
    config: {
      approval_policy: 'never',
      ...(effort ? { model_reasoning_effort: effort } : {}),
    },
  };
  if (condition === 'cli') {
    codexOptions.config.sandbox_workspace_write = {
      network_access: true,
      writable_roots: [env?.FIREFOX_CLI_STATE_DIR, tmpdir()].filter(Boolean),
    };
    // Codex's default shell_environment_policy passes only "core" vars
    // (PATH, HOME, ...) to shell commands — custom vars like
    // FIREFOX_CLI_STATE_DIR are dropped, which strands firefox-cli in the
    // wrong state dir. Inherit everything and pin the vars we depend on.
    codexOptions.config.shell_environment_policy = {
      inherit: 'all',
      set: {
        ...(env?.FIREFOX_CLI_STATE_DIR
          ? { FIREFOX_CLI_STATE_DIR: env.FIREFOX_CLI_STATE_DIR }
          : {}),
        ...(env?.PATH ? { PATH: env.PATH } : {}),
      },
    };
  } else {
    codexOptions.config.mcp_servers = {
      firefox: {
        ...(mcpStdio
          ? { command: mcpStdio.command, args: mcpStdio.args }
          : { url: endpoint }),
        // Codex cancels non-read-only MCP tools under approval 'never';
        // auto-approve this server's tools instead.
        default_tools_approval_mode: 'approve',
        // Headroom for Firefox's lazy cold start inside the first tool call.
        startup_timeout_sec: 60,
        tool_timeout_sec: 180,
      },
    };
  }
  const codex = new Codex(codexOptions);
  const thread = codex.startThread({
    ...(model ? { model } : {}),
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: condition === 'cli' ? 'workspace-write' : 'read-only',
  });

  const started = Date.now();
  const { events } = await thread.runStreamed(prompt);
  let usage = null;
  let text = '';
  let toolCalls = 0;
  let failure = null;
  for await (const event of events) {
    onMessage?.(event);
    if (event.type === 'turn.completed') {
      usage = event.usage;
    } else if (event.type === 'turn.failed') {
      failure = event.error;
    } else if (event.type === 'error') {
      failure = { message: event.message };
    } else if (event.type === 'item.completed') {
      const item = event.item;
      if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
        toolCalls++;
      } else if (item.type === 'agent_message') {
        text = item.text ?? text;
      }
    }
  }
  if (failure) {
    throw new Error(`codex turn failed: ${failure.message}`);
  }
  return {
    text,
    // Codex reports one "turn" per run; approximate agent turns as tool-call
    // rounds plus the final response.
    turns: toolCalls + 1,
    input_tokens: usage?.input_tokens ?? 0,
    cache_creation: usage?.cache_write_input_tokens ?? 0,
    cache_read: usage?.cached_input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cost_usd: null,
    duration_ms: Date.now() - started,
    api_duration_ms: null,
  };
}
