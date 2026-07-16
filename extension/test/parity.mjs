#!/usr/bin/env node
// Parity harness: the extension variant must expose the SAME tool surface as the Node
// server. Tool names are extracted from ../../src/tools/*.ts source (no build needed,
// stays in lockstep with upstream), then asserted against the extension's tools/list
// and exercised where a generic fixture flow applies.
//
// Debug knobs: FDM_TRACE=1 (BiDi trace + full browser log), FDM_FIREFOX=<binary>,
// --headed.

import { readdirSync, readFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { QUIET_STARTUP_PREFS, EXTENSION_PREFS, prefArgs } from "../prefs.mjs";

const FIXTURE_HTML = `<!doctype html><title>fdm fixture</title>
<h1>Fixture</h1>
<button id="btn" onclick="window.__clicks=(window.__clicks||0)+1;window.__trusted=event.isTrusted">Add Item</button>
<input id="name" placeholder="Your name">
<a href="#x">A link</a>
<script src="app.js"></script>`;

// Line 3 (the counter increment) is the logpoint target.
const FIXTURE_JS = `window.__ticks = 0;
function tick() {
  window.__ticks = window.__ticks + 1;
  return window.__ticks;
}
window.tick = tick;`;
const FIXTURE_JS_LOGPOINT_LINE = 3;

const fixtureServer = createServer((req, res) => {
  if (req.url?.endsWith("app.js")) {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(FIXTURE_JS);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => fixtureServer.listen(0, "127.0.0.1", r));
const FIXTURE_ORIGIN = `http://127.0.0.1:${fixtureServer.address().port}`;
const FIXTURE_URL = `${FIXTURE_ORIGIN}/fixture.html`;

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(EXT_DIR, "..");
const TOOLS_DIR = join(REPO_DIR, "src", "tools");
const PORT = 9500 + Math.floor(Math.random() * 400);
const TOKEN = "bidi-bridge-dev";
const BASE = `http://127.0.0.1:${PORT}`;
const HEADLESS = !process.argv.includes("--headed");

// Tools that are Node-process-bound and intentionally NOT exposed by the extension.
const NODE_ONLY_TOOLS = new Set([
  "restart_firefox", // relaunching the host binary is meaningless in-addon
  "get_firefox_output", // reads the launcher's log file
  "list_extensions", // addon management stays a Node-transport concern
  "install_extension",
  "uninstall_extension",
]);

// ---------- expected surface: parse upstream tool sources ----------

function upstreamToolNames() {
  const names = [];
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(TOOLS_DIR, file), "utf8");
    for (const m of src.matchAll(/name: '([a-z_]+)'/g)) names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

// ---------- assertions ----------

let passed = 0,
  failed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------- MCP client ----------

let nextId = 1;
let sessionId = null;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(method.startsWith("notifications/") ? {} : { id: nextId++ }),
      method,
      params,
    }),
  });
  const issued = res.headers.get("mcp-session-id");
  if (issued) sessionId = issued;
  if (res.status === 202) return null;
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// ---------- lifecycle ----------

const expected = upstreamToolNames();
if (expected.length < 40) {
  throw new Error(`tool-name extraction looks broken: only ${expected.length} names found (quote style change upstream?)`);
}
const expectedInExtension = expected.filter((n) => !NODE_ONLY_TOOLS.has(n));
console.log(`[parity] upstream defines ${expected.length} tools; ${expectedInExtension.length} expected in extension`);

const profileDir = mkdtempSync(join(tmpdir(), "fdm-ext-test-"));
mkdirSync(join(profileDir, "downloads"), { recursive: true });

// Prefer the pinned web-ext from extension/package.json; npx as fallback.
const localWebExt = join(EXT_DIR, "node_modules", ".bin", "web-ext");
const [webExtBin, webExtPrefix] = existsSync(localWebExt) ? [localWebExt, []] : ["npx", ["web-ext"]];
const webExt = spawn(
  webExtBin,
  [
    // FDM_FIREFOX: absolute binary path override (regression bisecting).
    ...webExtPrefix, "run", `--firefox=${process.env.FDM_FIREFOX || "nightly"}`, "--no-reload", "--verbose",
    ...(HEADLESS ? ["--args=-headless"] : []),
    `--source-dir=${EXT_DIR}`,
    `--firefox-profile=${profileDir}`, "--profile-create-if-missing", "--keep-profile-changes",
    ...prefArgs(EXTENSION_PREFS(PORT)),
    ...prefArgs(QUIET_STARTUP_PREFS),
    ...prefArgs([
      "extensions.bidibridge.testhooks=true",
      "browser.download.folderList=2",
      `browser.download.dir=${profileDir}/downloads`,
      // observability: extension/page console errors must reach the harness log
      "devtools.console.stdout.chrome=true",
      "devtools.console.stdout.content=true",
      "browser.dom.window.dump.enabled=true",
    ]),
    // FDM_TRACE=1: Firefox-side trace of every BiDi command/response/event.
    ...(process.env.FDM_TRACE ? prefArgs(["remote.log.level=Trace"]) : []),
  ],
  { cwd: EXT_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true }
);
webExt.on("error", (e) => {
  console.error(`[parity] failed to spawn web-ext: ${e}`);
  process.exit(2);
});
const browserLog = [];
for (const stream of [webExt.stdout, webExt.stderr]) {
  stream.on("data", (d) => browserLog.push(d.toString()));
}

async function teardown(code) {
  try { process.kill(-webExt.pid, "SIGTERM"); } catch { webExt.kill("SIGTERM"); }
  await new Promise((r) => { webExt.on("exit", r); setTimeout(r, 5000); });
  await new Promise((r) => spawn("pkill", ["-f", profileDir]).on("exit", r));
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  fixtureServer.close();
  if (process.env.FDM_TRACE) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/fdm-browser-full.log", browserLog.join(""));
    console.log("[parity] full browser log: /tmp/fdm-browser-full.log");
  }
  if (code !== 0) {
    const interesting = browserLog.join("").split("\n").filter((l) => /error|exception|bidi/i.test(l));
    console.log("\n[parity] interesting browser output:\n" + interesting.slice(-30).join("\n"));
  }
  process.exit(code);
}
process.on("SIGINT", () => teardown(130));
process.on("SIGTERM", () => teardown(143));
process.on("unhandledRejection", (e) => { console.error(`[parity] unhandled: ${e}`); teardown(3); });

// ---------- suite ----------

try {
  // wait for the extension MCP server
  const deadline = Date.now() + 90000;
  let init = null;
  let lastInitError = null;
  while (Date.now() < deadline && !init) {
    try {
      init = await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "fdm-extension-parity", version: "1.0" },
      });
    } catch (e) {
      lastInitError = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!init) throw new Error(`extension MCP server did not come up (last error: ${lastInitError})`);
  await rpc("notifications/initialized", {});

  const listed = (await rpc("tools/list", {})).tools.map((t) => t.name).sort();

  // The headline parity assertion: every upstream tool (minus node-only) is exposed.
  const missing = expectedInExtension.filter((n) => !listed.includes(n));
  const extra = listed.filter((n) => !expected.includes(n));
  check("all upstream tools exposed", missing.length === 0, `missing: ${missing.join(", ")}`);
  check("no unexpected extra tools", extra.length === 0, `extra: ${extra.join(", ")}`);

  // Per-tool presence lines: red list = the work queue for the platform layer.
  for (const name of expectedInExtension) {
    check(`tool: ${name}`, listed.includes(name));
  }

  // ---------- behavioral smoke flows ----------

  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
    return { ...r, text };
  };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  // Poll instead of fixed sleeps: returns fn's first truthy result, or its last result on timeout.
  const pollUntil = async (fn, timeout = 4000, interval = 200) => {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      last = await fn();
      if (last || Date.now() > end) return last;
      await sleepMs(interval);
    }
  };

  // page lifecycle: new_page → navigate → list shows it
  const np = await call("new_page", { url: FIXTURE_URL });
  check("new_page opens fixture", !np.isError, np.text.slice(0, 200));
  const pages = await call("list_pages");
  // list_pages prints titles, not URLs
  check("list_pages includes fixture", !pages.isError && pages.text.includes("fdm fixture"), pages.text.slice(0, 300));

  // evaluate_script takes a function declaration string (upstream schema: `function`)
  const ev = await call("evaluate_script", { function: "() => document.title" });
  check("evaluate_script returns title", ev.text.includes("fdm fixture"), ev.text.slice(0, 200));

  // snapshot → uid → click (trusted) → fill
  const snap = await call("take_snapshot");
  check("take_snapshot produces uids", !snap.isError && /\d+_\d+/.test(snap.text), snap.text.slice(0, 300));
  const uidMatch = snap.text.match(/(\d+_\d+)[^\n]*Add Item/) ?? snap.text.match(/Add Item[^\n]*?(\d+_\d+)/) ?? snap.text.match(/uid[=: ]"?(\S+?)"?[^\n]*Add Item/);
  const btnUid = uidMatch?.[1];
  check("snapshot exposes button uid", !!btnUid, snap.text.slice(0, 400));
  if (btnUid) {
    const clicked = await call("click_by_uid", { uid: btnUid });
    check("click_by_uid succeeds", !clicked.isError, clicked.text);
    const clickState = await call("evaluate_script", {
      function: "() => JSON.stringify({c: window.__clicks, t: window.__trusted})",
    });
    // The response embeds the JSON string in a fenced block with escaped quotes.
    check("uid click fired trusted handler", /c\\?":1/.test(clickState.text) && /t\\?":true/.test(clickState.text), clickState.text);
    const sel = await call("resolve_uid_to_selector", { uid: btnUid });
    check("resolve_uid_to_selector returns selector", !sel.isError && sel.text.includes("btn"), sel.text.slice(0, 200));

    const hov = await call("hover_by_uid", { uid: btnUid });
    const hovering = await call("evaluate_script", { function: "() => document.querySelector('#btn:hover') !== null" });
    check("hover_by_uid hovers button", !hov.isError && hovering.text.includes("true"), `${hov.text} / ${hovering.text}`.slice(0, 200));

    const uidShot = await call("screenshot_by_uid", { uid: btnUid });
    const uidImage = uidShot.content?.find((c) => c.type === "image");
    check("screenshot_by_uid returns image", !uidShot.isError && (uidImage?.data?.length ?? 0) > 100, `imageLen=${uidImage?.data?.length ?? 0}`);
  }

  // negative paths
  const staleClick = await call("click_by_uid", { uid: "999_999" });
  check("click_by_uid rejects unknown uid", staleClick.isError === true, staleClick.text.slice(0, 200));
  const unknownTool = await rpc("tools/call", { name: "does_not_exist", arguments: {} }).then(
    (r) => ({ ok: r?.isError === true, text: JSON.stringify(r).slice(0, 150) }),
    (e) => ({ ok: true, text: String(e).slice(0, 150) })
  );
  check("unknown tool name rejected", unknownTool.ok, unknownTool.text);
  const nameUid = (snap.text.match(/(\d+_\d+)[^\n]*Your name/) ?? snap.text.match(/Your name[^\n]*?(\d+_\d+)/))?.[1];
  if (nameUid) {
    await call("fill_by_uid", { uid: nameUid, value: "Parity" });
    const filled = await call("evaluate_script", { function: "() => document.getElementById('name').value" });
    check("fill_by_uid types value", filled.text.includes("Parity"), filled.text);
  } else {
    check("snapshot exposes input uid", false, snap.text.slice(0, 400));
  }

  // console capture
  await call("evaluate_script", { function: "() => { console.log('parity-marker'); return 1; }" });
  const consoleOut = await pollUntil(async () => {
    const r = await call("list_console_messages");
    return r.text.includes("parity-marker") ? r : null;
  });
  check("console capture sees marker", !!consoleOut, "marker never appeared");
  const cleared = await call("clear_console_messages");
  const consoleAfter = await call("list_console_messages");
  check("clear_console_messages empties buffer", !cleared.isError && !consoleAfter.text.includes("parity-marker"), consoleAfter.text.slice(0, 200));

  // network capture: the buffer auto-clears on navigation (upstream default), so
  // trigger a post-load fetch and look for that.
  await call("evaluate_script", { function: "() => fetch('app.js?xhr=1').then((r) => r.text()).then(() => 'fetched')" });
  const net = await pollUntil(async () => {
    const r = await call("list_network_requests");
    return r.text.includes("app.js?xhr=1") ? r : null;
  });
  check("network capture lists fetch", !!net, "fetch never appeared in buffer");
  const netDetail = await call("get_network_request", { url: `${FIXTURE_ORIGIN}/app.js?xhr=1` });
  check("get_network_request finds fetch by url", !netDetail.isError && netDetail.text.includes("app.js?xhr=1"), netDetail.text.slice(0, 200));

  // screenshot
  const shot = await call("screenshot_page");
  const shotImage = shot.content?.find((c) => c.type === "image");
  check("screenshot_page returns image", (shotImage?.data?.length ?? 0) > 1000 || shot.text.length > 1000, `imageLen=${shotImage?.data?.length ?? 0} textLen=${shot.text.length}`);

  // dialog: arm a confirm, accept it
  await call("evaluate_script", { function: "() => { setTimeout(() => { window.__c = confirm('go?'); }, 0); return 'armed'; }" });
  const acc = await pollUntil(async () => {
    const r = await call("accept_dialog");
    return r.isError ? null : r;
  });
  check("accept_dialog succeeds", !!acc, acc?.text ?? "dialog never accepted");
  const confirmed = await pollUntil(async () => {
    const r = await call("evaluate_script", { function: "() => String(window.__c)" });
    return r.text.includes("true") ? r : null;
  });
  check("accepted confirm returns true", !!confirmed, "window.__c never became true");

  // dialog: arm another confirm, dismiss it
  const arm2 = await call("evaluate_script", { function: "() => { setTimeout(() => { window.__d = confirm('go again?'); }, 0); return 'armed'; }" });
  let dis = await pollUntil(async () => {
    const r = await call("dismiss_dialog");
    return r.isError ? null : r;
  });
  dis ??= await call("dismiss_dialog");
  check("dismiss_dialog succeeds", !dis.isError, `${dis.text} (arm: ${arm2.text.slice(0, 100)})`);
  const dismissed = await pollUntil(async () => {
    const r = await call("evaluate_script", { function: "() => String(window.__d)" });
    return r.text.includes("false") ? r : null;
  });
  check("dismissed confirm returns false", !!dismissed, "window.__d never became false");

  // viewport
  const vp = await call("set_viewport_size", { width: 800, height: 600 });
  check("set_viewport_size succeeds", !vp.isError, vp.text);

  // moz:profiler passthrough. The module only ships in Firefox >= 154 builds that
  // include it; older Nightlies surface "not supported", which matches upstream's
  // errorResponse behavior against the same binary.
  const pact = await call("profiler_is_active");
  check(
    "profiler_is_active answers",
    /active|inactive/i.test(pact.text) || /not supported|requires Firefox/i.test(pact.text),
    pact.text
  );

  // prefs (via experiment privilege): read a known pref, then set/get round-trip
  const pref = await call("get_firefox_prefs", { names: ["browser.shell.checkDefaultBrowser"] });
  check("get_firefox_prefs reads pref", !pref.isError && pref.text.includes("false"), pref.text.slice(0, 200));
  const setPref = await call("set_firefox_prefs", { prefs: { "fdm.parity.test": "roundtrip" } });
  const readBack = await call("get_firefox_prefs", { names: ["fdm.parity.test"] });
  check("set_firefox_prefs round-trips", !setPref.isError && readBack.text.includes("roundtrip"), `${setPref.text} / ${readBack.text}`.slice(0, 200));

  // debugging: enable, list scripts, logpoint round-trip
  const dbg = await call("enable_debugger");
  check("enable_debugger succeeds", !dbg.isError, dbg.text);
  const scripts = await call("list_scripts");
  check("list_scripts sees fixture script", scripts.text.includes("app.js"), scripts.text.slice(0, 300));
  const src = await call("get_script_source", { scriptUrl: `${FIXTURE_ORIGIN}/app.js` });
  check("get_script_source returns source", src.text.includes("window.__ticks"), src.text.slice(0, 200));
  const lp = await call("set_logpoint", {
    url: `${FIXTURE_ORIGIN}/app.js`,
    line: FIXTURE_JS_LOGPOINT_LINE,
    expression: "'tick ran, count=' + window.__ticks",
  });
  check("set_logpoint succeeds", !lp.isError && lp.text.includes("id:"), lp.text);
  const lpId = lp.text.match(/id: (\S+?)\)/)?.[1];
  if (lpId) {
    await call("evaluate_script", { function: "() => window.tick()" });
    const lpRes = await pollUntil(async () => {
      const r = await call("get_logpoint_results", { logpoint: lpId });
      return r.text.includes("tick ran") ? r : null;
    });
    check("logpoint captured a hit", !!lpRes, "no hit recorded");
    const lpRm = await call("remove_logpoint", { logpoint: lpId });
    check("remove_logpoint succeeds", !lpRm.isError, lpRm.text);
  } else {
    check("logpoint id parsed", false, lp.text);
  }

  // navigation: navigate_page → history back, verified via location
  const nav = await call("navigate_page", { url: `${FIXTURE_URL}?nav=1` });
  const navLoc = await pollUntil(async () => {
    const r = await call("evaluate_script", { function: "() => location.search" });
    return r.text.includes("nav=1") ? r : null;
  });
  check("navigate_page lands on url", !nav.isError && !!navLoc, nav.text.slice(0, 200));
  const back = await call("navigate_history", { direction: "back" });
  const backLoc = await pollUntil(async () => {
    const r = await call("evaluate_script", { function: "() => location.search" });
    return r.text.includes("nav=1") ? null : r;
  });
  check("navigate_history goes back", !back.isError && !!backLoc, back.text.slice(0, 200));

  // tab selection round-trip
  const fixtureIdx = () =>
    call("list_pages").then((p) => p.text.match(/\[(\d+)\][^\n]*fdm fixture/)?.[1]);
  const selBack = await call("select_page", { pageIdx: 0 });
  const idxAfter = await fixtureIdx();
  const selFixture = idxAfter != null ? await call("select_page", { pageIdx: Number(idxAfter) }) : { isError: true, text: "fixture idx not found" };
  const selTitle = await call("evaluate_script", { function: "() => document.title" });
  check("select_page round-trips", !selBack.isError && !selFixture.isError && selTitle.text.includes("fdm fixture"), `${selBack.text} / ${selTitle.text}`.slice(0, 200));

  // info surfaces
  const info = await call("get_firefox_info");
  check("get_firefox_info reports version", !info.isError && /\d+\.\d+/.test(info.text), info.text.slice(0, 200));

  // close the fixture page (derive index; extra tabs must not shift it)
  const closeIdx = await fixtureIdx();
  const closed = closeIdx != null ? await call("close_page", { pageIdx: Number(closeIdx) }) : { isError: true, text: "fixture idx not found" };
  check("close_page succeeds", !closed.isError, closed.text);

  console.log(`\n[parity] ${passed} passed, ${failed} failed${failed ? `: ${failures.slice(0, 8).join(", ")}…` : ""}`);
  await teardown(failed ? 1 : 0);
} catch (e) {
  console.error(`\n[parity] fatal: ${e?.stack ?? e}`);
  await teardown(2);
}
