// Anthropic backend: drives tasks through the Claude Agent SDK.
// Backend interface (shared with backends/codex.mjs):
//   run({ prompt, model, condition, env, endpoint, cwd, onMessage,
//         mcpStdio }) ->
//     { text, turns, input_tokens, cache_creation, cache_read, output_tokens,
//       cost_usd, duration_ms, api_duration_ms }
// condition 'cli': `env` contains PATH with a firefox-cli wrapper — expose a
//   bash/shell tool only. condition 'mcp': spawn the MCP server over stdio
//   when `mcpStdio` ({command, args}) is provided, else attach the streamable
//   HTTP server at `endpoint`.
// onMessage (optional): called with every raw agent message as it streams
// (thinking, tool calls, tool results, final result) for transcript logging.

import { query } from '@anthropic-ai/claude-agent-sdk';

export const DEFAULT_MODEL = 'claude-sonnet-5';

// run.mjs prepends a temp dir holding the firefox-cli wrapper to PATH. Drop that
// entry so non-cli conditions get an ordinary shell without the browser CLI.
function stripWrapperDir(path) {
  return (path ?? '')
    .split(':')
    .filter((dir) => !/ffcli-eval-bin-/.test(dir))
    .join(':');
}

export async function run({ prompt, model, effort, condition, env, endpoint, cwd, onMessage, mcpStdio, abortController }) {
  const options = {
    model,
    permissionMode: 'dontAsk',
    cwd,
    settingSources: [],
    ...(effort ? { effort } : {}),
    // Lets run.mjs stop a task on its backend-agnostic token/wall ceilings.
    ...(abortController ? { abortController } : {}),
  };
  if (condition === 'cli') {
    options.allowedTools = ['Bash'];
    options.env = env;
  } else {
    // Every condition gets a shell so the ONLY difference is how the browser is
    // driven. Without this, cli could curl a static fixture while mcp could not,
    // and a cost/turn gap would partly measure shell access rather than the tool
    // surface. The mcp shell deliberately does NOT get the firefox-cli wrapper on
    // PATH (nor its state dir) — with those, an mcp agent could drive the browser
    // through the CLI and the two conditions would collapse into one.
    const { PATH, FIREFOX_CLI_STATE_DIR, ...rest } = env ?? process.env;
    options.allowedTools = ['mcp__firefox', 'Bash'];
    options.env = { ...rest, PATH: stripWrapperDir(PATH ?? process.env.PATH) };
    options.mcpServers = {
      firefox: mcpStdio
        ? { type: 'stdio', command: mcpStdio.command, args: mcpStdio.args }
        : { type: 'http', url: endpoint },
    };
  }

  const started = Date.now();
  // A run can emit MORE THAN ONE result message: if the agent starts a background
  // Bash task (agents do this to wait for an async page reply), its completion
  // re-invokes the agent and the SDK emits a fresh result for that continuation.
  // `usage` and `num_turns` are PER-SEGMENT while `total_cost_usd` and the
  // durations are CUMULATIVE — so usage must be summed and the rest taken at its
  // last value. Keeping only the last result reported a 26-turn/2392-token run as
  // 1 turn and 53 tokens, silently understating the suite's primary metric by 45x.
  const results = [];
  for await (const message of query({ prompt, options })) {
    onMessage?.(message);
    if (message.type === 'result') {
      results.push(message);
    }
  }
  if (!results.length) {
    throw new Error('no result message from agent');
  }
  const last = results.at(-1);
  const sum = (pick) => results.reduce((n, r) => n + (pick(r.usage ?? {}) ?? 0), 0);
  return {
    text: last.subtype === 'success' ? last.result : `[${last.subtype}]`,
    turns: results.reduce((n, r) => n + (r.num_turns ?? 0), 0),
    input_tokens: sum((u) => u.input_tokens),
    cache_creation: sum((u) => u.cache_creation_input_tokens),
    cache_read: sum((u) => u.cache_read_input_tokens),
    output_tokens: sum((u) => u.output_tokens),
    cost_usd: last.total_cost_usd ?? null,
    duration_ms: last.duration_ms ?? Date.now() - started,
    // Time spent in API calls (vs tool execution etc.), when reported.
    api_duration_ms: last.duration_api_ms ?? null,
    segments: results.length,
  };
}
