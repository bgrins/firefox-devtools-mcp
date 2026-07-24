import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CALL_TIMEOUT_MS = 120000;

async function withClient(endpoint, fn) {
  const client = new Client({ name: 'firefox-cli', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    // One-shot invocation: end the server-side session, not just the socket.
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export function callTool(endpoint, name, args) {
  return withClient(endpoint, (client) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
  );
}

export async function listTools(endpoint) {
  return (await withClient(endpoint, (client) => client.listTools())).tools;
}

function need(value, label, usage) {
  if (value === undefined) {
    throw new Error(`Missing <${label}>. Usage: firefox-cli ${usage}`);
  }
  return value;
}

// Curated commands over the MCP tool surface. `call <tool> [json]` covers the
// long tail.
export const TOOL_COMMANDS = {
  pages: {
    tool: 'list_pages',
    usage: 'pages',
    describe: 'list open tabs',
    build: () => ({}),
  },
  open: {
    tool: 'new_page',
    usage: 'open <url>',
    describe: 'open a new tab at url',
    build: ([url]) => ({ url: need(url, 'url', 'open <url>') }),
  },
  goto: {
    tool: 'navigate_page',
    usage: 'goto <url>',
    describe: 'navigate the selected tab',
    build: ([url]) => ({ url: need(url, 'url', 'goto <url>') }),
  },
  'tab-select': {
    tool: 'select_page',
    usage: 'tab-select <idx>',
    describe: 'select a tab by index',
    build: ([idx]) => ({ pageIdx: Number(need(idx, 'idx', 'tab-select <idx>')) }),
  },
  'tab-close': {
    tool: 'close_page',
    usage: 'tab-close <idx>',
    describe: 'close a tab by index',
    build: ([idx]) => ({ pageIdx: Number(need(idx, 'idx', 'tab-close <idx>')) }),
  },
  snapshot: {
    tool: 'take_snapshot',
    usage: 'snapshot [--selector <css>]',
    describe: 'capture page snapshot with element uids',
    build: (_, flags) => (flags.selector ? { selector: String(flags.selector) } : {}),
  },
  click: {
    tool: 'click_by_uid',
    usage: 'click <uid>',
    describe: 'click an element from the snapshot',
    build: ([uid]) => ({ uid: need(uid, 'uid', 'click <uid>') }),
  },
  hover: {
    tool: 'hover_by_uid',
    usage: 'hover <uid>',
    describe: 'hover an element from the snapshot',
    build: ([uid]) => ({ uid: need(uid, 'uid', 'hover <uid>') }),
  },
  fill: {
    tool: 'fill_by_uid',
    usage: 'fill <uid> <value>',
    describe: 'fill an editable element',
    build: ([uid, value]) => ({
      uid: need(uid, 'uid', 'fill <uid> <value>'),
      value: need(value, 'value', 'fill <uid> <value>'),
    }),
  },
  eval: {
    tool: 'evaluate_script',
    usage: "eval '<js function>' [uid]",
    describe: 'run a JS function in the page, e.g. "() => document.title"',
    build: ([fn, uid]) => ({
      function: need(fn, 'js function', "eval '<js function>' [uid]"),
      ...(uid ? { args: [{ uid }] } : {}),
    }),
  },
  console: {
    tool: 'list_console_messages',
    usage: 'console',
    describe: 'list console messages',
    build: () => ({}),
  },
  requests: {
    tool: 'list_network_requests',
    usage: 'requests',
    describe: 'list network requests',
    build: () => ({}),
  },
  screenshot: {
    tool: 'screenshot_page',
    usage: 'screenshot',
    describe: 'screenshot the selected tab',
    build: () => ({}),
  },
  back: {
    tool: 'navigate_history',
    usage: 'back',
    describe: 'go back in history',
    build: () => ({ direction: 'back' }),
  },
  forward: {
    tool: 'navigate_history',
    usage: 'forward',
    describe: 'go forward in history',
    build: () => ({ direction: 'forward' }),
  },
};

// Search the current snapshot for text/regex, returning matching lines with
// surrounding context (playwright-cli's `find`) — the token-cheap alternative
// to dumping a full snapshot.
export async function findInSnapshot(endpoint, pattern, flags) {
  const result = await callTool(endpoint, 'take_snapshot', {});
  if (result.isError) {
    return result;
  }
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const lines = text.split('\n');
  const context = flags.context !== undefined ? Number(flags.context) : 2;
  const matcher = flags.regex
    ? new RegExp(...parseRegex(pattern))
    : null;
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = matcher ? matcher.test(lines[i]) : lines[i].includes(pattern);
    if (hit) {
      matches.push(i);
    }
  }
  if (!matches.length) {
    return { content: [{ type: 'text', text: `(no matches for ${pattern})` }], isError: true };
  }
  // Merge overlapping context ranges into blocks.
  const blocks = [];
  for (const idx of matches) {
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    const last = blocks[blocks.length - 1];
    if (last && start <= last.end + 1) {
      last.end = end;
      last.hits.add(idx);
    } else {
      blocks.push({ start, end, hits: new Set([idx]) });
    }
  }
  const out = [];
  for (const block of blocks) {
    if (out.length) {
      out.push('--');
    }
    for (let i = block.start; i <= block.end; i++) {
      out.push(`${block.hits.has(i) ? '>' : ' '} ${lines[i]}`);
    }
  }
  out.push(`(${matches.length} matching line${matches.length === 1 ? '' : 's'})`);
  return { content: [{ type: 'text', text: out.join('\n') }] };
}

function parseRegex(pattern) {
  const slashed = pattern.match(/^\/(.*)\/([a-z]*)$/);
  return slashed ? [slashed[1], slashed[2]] : [pattern, ''];
}

export function printResult(result, flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    for (const item of result.content ?? []) {
      if (item.type === 'text') {
        process.stdout.write(item.text + '\n');
      } else if (item.type === 'image') {
        const file = join(tmpdir(), `firefox-cli-${Date.now()}.png`);
        writeFileSync(file, Buffer.from(item.data, 'base64'));
        process.stdout.write(`[image saved to ${file}]\n`);
      }
    }
  }
  return result.isError ? 1 : 0;
}
