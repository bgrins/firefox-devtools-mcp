// MCP streamable-HTTP layer over the experiment's loopback listener, serving the
// UPSTREAM tool surface (../../src/tools).

import * as toolExports from "../../src/tools/index.js";
import { getFirefox } from "./provider.js";

const SERVER_INFO = { name: "firefox-devtools-mcp-extension", version: "0.0.1" };
const DEV_TOKEN = "bidi-bridge-dev";
export const DEFAULT_PORT = 9339;

// Node-process-bound tools have no meaning in-addon. The webextension tools are also
// excluded: install/uninstall need Selenium's installAddon, and listing would require
// the management permission — addon management stays a Node-transport concern.
const NODE_ONLY_TOOLS = new Set([
  "restart_firefox",
  "get_firefox_output",
  "list_extensions",
  "install_extension",
  "uninstall_extension",
]);

interface ToolEntry {
  definition: { name: string; description: string; inputSchema: object };
  handler: (args: unknown) => Promise<any>;
}

declare const browser: any;

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const errText = (e: unknown) => ({
  content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

// Upstream's pref tools drive Selenium's chrome-context executeScript, which needs
// -remote-allow-system-access and a WebDriver. The experiment is already privileged,
// so these two handlers are replaced with browser.bidi.getPref/setPref while keeping
// the upstream names, schemas, and response text.
const OVERRIDDEN_HANDLERS: Record<string, (args: unknown) => Promise<any>> = {
  get_firefox_prefs: async (args) => {
    const { names } = args as { names: string[] };
    if (!names || !Array.isArray(names) || names.length === 0) {
      return errText(new Error("names parameter is required and must be a non-empty array"));
    }
    const results: string[] = [];
    const errors: string[] = [];
    for (const name of names) {
      try {
        const res = await browser.bidi.getPref(name);
        results.push(
          res.type === "invalid" ? `  ${name} = (not set)` : `  ${name} = ${JSON.stringify(res.value)}`
        );
      } catch (e) {
        errors.push(`  ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const out: string[] = [];
    if (results.length) out.push("Firefox Preferences:", ...results);
    if (errors.length) out.push(`\nFailed to read ${errors.length} preference(s):`, ...errors);
    return text(out.join("\n"));
  },
  set_firefox_prefs: async (args) => {
    const { prefs } = args as { prefs: Record<string, string | number | boolean> };
    if (!prefs || typeof prefs !== "object") {
      return errText(new Error("prefs parameter is required and must be an object"));
    }
    const entries = Object.entries(prefs);
    if (entries.length === 0) return text("No preferences to set");
    const results: string[] = [];
    const errors: string[] = [];
    for (const [name, value] of entries) {
      try {
        await browser.bidi.setPref(name, value);
        results.push(`  ${name} = ${JSON.stringify(value)}`);
      } catch (e) {
        errors.push(`  ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const out: string[] = [];
    if (results.length) out.push(`Set ${results.length} preference(s):`, ...results);
    if (errors.length) out.push(`\nFailed to set ${errors.length} preference(s):`, ...errors);
    return text(out.join("\n"));
  },
};

// Upstream convention: `xyzTool` definition pairs with `handleXyz`.
function buildRegistry(): Map<string, ToolEntry> {
  const registry = new Map<string, ToolEntry>();
  const exports = toolExports as Record<string, any>;
  for (const [key, value] of Object.entries(exports)) {
    if (!key.endsWith("Tool") || !value?.name) continue;
    const base = key.slice(0, -4);
    const handlerName = `handle${base[0].toUpperCase()}${base.slice(1)}`;
    const handler = exports[handlerName];
    if (typeof handler !== "function") {
      console.warn(`[fdm-ext] no handler ${handlerName} for ${value.name}`);
      continue;
    }
    if (NODE_ONLY_TOOLS.has(value.name)) continue;
    registry.set(value.name, { definition: value, handler: OVERRIDDEN_HANDLERS[value.name] ?? handler });
  }
  return registry;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rpcResult(id: unknown, result: object) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export async function startMcp(port: number): Promise<number> {
  const registry = buildRegistry();
  console.log(`[fdm-ext] serving ${registry.size} tools`);

  browser.bidi.onHttpRequest.addListener(async (req) => {
    const respond = (status: number, body: string, contentType = "application/json") =>
      browser.bidi.sendHttpResponse(req.id, status, { "Content-Type": contentType }, body);
    try {
      if (req.headers["origin"]) return void (await respond(403, "browser origins not allowed", "text/plain"));
      if (req.path !== "/mcp") return void (await respond(404, "not found", "text/plain"));
      if (req.method === "GET") return void (await respond(405, "SSE stream not supported", "text/plain"));
      if (req.method !== "POST") return void (await respond(405, "", "text/plain"));
      if ((req.headers["authorization"] ?? "") !== `Bearer ${DEV_TOKEN}`) {
        return void (await respond(401, "bad or missing bearer token", "text/plain"));
      }
      const msg = JSON.parse(req.body);
      const { id, method, params } = msg;
      if (method?.startsWith("notifications/")) return void (await respond(202, ""));
      switch (method) {
        case "initialize":
          return void (await respond(200, rpcResult(id, {
            protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(params?.protocolVersion)
              ? params.protocolVersion
              : "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          })));
        case "ping":
          return void (await respond(200, rpcResult(id, {})));
        case "tools/list":
          return void (await respond(200, rpcResult(id, {
            tools: [...registry.values()].map((t) => t.definition),
          })));
        case "tools/call": {
          const entry = registry.get(params?.name);
          if (!entry) return void (await respond(200, rpcError(id, -32602, `Unknown tool: ${params?.name}`)));
          // Connect/handler failures must surface as tool errors, not a -32700 parse
          // error from the outer catch.
          let result;
          try {
            await getFirefox(); // ensure connected before any handler runs
            result = await Promise.race([
              entry.handler(params?.arguments ?? {}),
              sleep(60000).then(() => ({
                content: [{ type: "text", text: "Error: tool timed out after 60s" }],
                isError: true,
              })),
            ]);
          } catch (e) {
            result = errText(e);
          }
          return void (await respond(200, rpcResult(id, result)));
        }
        default:
          return void (await respond(200, rpcError(id, -32601, `Method not found: ${method}`)));
      }
    } catch (e) {
      console.error("[fdm-ext] http handler error", e);
      try {
        await respond(400, rpcError(null, -32700, "parse error"));
      } catch {}
    }
  });

  return browser.bidi.startServer(port);
}
