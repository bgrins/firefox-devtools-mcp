import { DEFAULT_PORT, startMcp } from "./mcp.js";

declare const browser: any;

let serverState: { running: boolean; port: number | null } = { running: false, port: null };

async function start(port: number) {
  const bound = await startMcp(port);
  serverState = { running: true, port: bound };
  console.log(`[fdm-ext] MCP server on http://127.0.0.1:${bound}/mcp`);
  return serverState;
}

async function stop() {
  await browser.bidi.stopServer();
  // Keep the port so Start reuses the configured one.
  serverState = { running: false, port: serverState.port };
  return serverState;
}

// BiDi Companion popup protocol.
browser.runtime.onMessage.addListener((msg: any) => {
  switch (msg?.type) {
    case "status":
      return Promise.resolve(serverState);
    case "start":
      return start(msg.port ?? serverState.port ?? DEFAULT_PORT);
    case "stop":
      return stop();
  }
  return undefined;
});

async function boot() {
  const prefs = await browser.bidi.getAutostartConfig().catch(() => ({ autostart: false, port: null }));
  const port = prefs.autostart && prefs.port ? prefs.port : DEFAULT_PORT;
  try {
    await start(port);
  } catch (e) {
    console.error("[fdm-ext] startup failed:", e);
  }
}

boot();

export {};
