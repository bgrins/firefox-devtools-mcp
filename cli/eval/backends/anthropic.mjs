// Anthropic backend: drives tasks through the Claude Agent SDK.
// Backend interface (shared with backends/codex.mjs):
//   run({ prompt, model, maxTurns, condition, env, endpoint, cwd, onMessage,
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

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export async function run({ prompt, model, effort, maxTurns, condition, env, endpoint, cwd, onMessage, mcpStdio }) {
  const options = {
    model,
    maxTurns,
    permissionMode: 'dontAsk',
    cwd,
    settingSources: [],
    ...(effort ? { effort } : {}),
  };
  if (condition === 'cli') {
    options.allowedTools = ['Bash'];
    options.env = env;
  } else {
    options.allowedTools = ['mcp__firefox'];
    options.mcpServers = {
      firefox: mcpStdio
        ? { type: 'stdio', command: mcpStdio.command, args: mcpStdio.args }
        : { type: 'http', url: endpoint },
    };
  }

  const started = Date.now();
  let result = null;
  for await (const message of query({ prompt, options })) {
    onMessage?.(message);
    if (message.type === 'result') {
      result = message;
    }
  }
  if (!result) {
    throw new Error('no result message from agent');
  }
  const usage = result.usage ?? {};
  return {
    text: result.subtype === 'success' ? result.result : `[${result.subtype}]`,
    turns: result.num_turns,
    input_tokens: usage.input_tokens ?? 0,
    cache_creation: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cost_usd: result.total_cost_usd ?? null,
    duration_ms: result.duration_ms ?? Date.now() - started,
    // Time spent in API calls (vs tool execution etc.), when reported.
    api_duration_ms: result.duration_api_ms ?? null,
  };
}
