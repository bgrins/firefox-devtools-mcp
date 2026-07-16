# extension/ — same tool surface, in-browser transport

A Firefox WebExtension variant of firefox-devtools-mcp: it **shares `../src/tools/**`
verbatim** (the MCP tool surface and handlers) but tunnels straight to Firefox's
in-process WebDriver BiDi implementation via a WebExtension Experiment — no Node
runtime, no Selenium, no remote-agent socket. The MCP server itself runs inside the
browser, served over a loopback streamable-HTTP listener.

```
MCP client (streamable HTTP, 127.0.0.1:9339, bearer token)
  └─ extension background (src/mcp.ts — protocol, registry from ../src/tools)
       └─ upstream tool handlers (../src/tools/** — bundled verbatim)
            └─ src/client.ts (ExtensionFirefoxClient — drop-in facade)
                 └─ experiment/api.js (browser.bidi — in-process WebDriver BiDi)
```

## Quick start

```sh
cd extension
npm install        # toolchain only (esbuild, web-ext) — root package.json untouched
npm start          # build + headed Nightly with the extension; MCP on :9339
npm test           # build + full parity harness (headless)
npm run xpi        # package web-ext-artifacts/firefox-devtools-mcp-extension.xpi
```

The xpi is unsigned: load it via about:debugging ("Load Temporary Add-on"), or install
permanently in Nightly with `xpinstall.signatures.required=false`.

Requires Firefox Nightly (WebExtension Experiments; `extensions.experiments.enabled`).
The toolbar button ("BiDi Companion") shows server status with a start/stop toggle.

## Connecting MCP clients

Unlike the Node server (stdio), this is a **streamable-HTTP** server at
`http://127.0.0.1:9339/mcp`, authenticated with `Authorization: Bearer bidi-bridge-dev`.
Start Firefox first (`npm start`), then:

Claude Code:

```bash
claude mcp add --transport http firefox-extension http://127.0.0.1:9339/mcp \
  --header "Authorization: Bearer bidi-bridge-dev"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.firefox-extension]
url = "http://127.0.0.1:9339/mcp"
http_headers = { Authorization = "Bearer bidi-bridge-dev" }
```

Generic JSON config (Cursor, Cline, and similar):

```json
{
  "mcpServers": {
    "firefox-extension": {
      "type": "http",
      "url": "http://127.0.0.1:9339/mcp",
      "headers": { "Authorization": "Bearer bidi-bridge-dev" }
    }
  }
}
```

## How the sharing works

Everything is additive under `extension/`; upstream sources are never edited.

- Tool handlers call `await import('../index.js')` for `getFirefox()`. The esbuild
  config (`build.mjs`) redirects that specifier — only when resolved from `src/tools`
  — to `src/provider.ts`, which returns `src/client.ts` (ExtensionFirefoxClient), a
  reimplementation of the `FirefoxDevTools` facade over a privileged
  `browser.bidi.send(module, command, params)` experiment API.
- Node builtins reachable from the tool sources (`fs`, `path`, …) are aliased to
  `src/node-shims.ts` (throw or no-op; only optional flows like screenshot `savePath`
  use them).
- The experiment (`experiment/api.js`) creates a real `WebDriverSession` in-process and
  dispatches commands through the MessageHandler network, so BiDi behavior (including
  events, prompt handling, and node serialization) matches a socket-connected session.
- The uid protocol reuses upstream's injected snapshot script and selector-based
  `UidEntry` map, so `take_snapshot` output and `*_by_uid` semantics match.

## Parity harness

`test/parity.mjs` launches headless Nightly via web-ext, extracts the expected tool
list from `../src/tools/*.ts` at run time (stays in lockstep with upstream), and
asserts full tool-surface parity plus behavioral flows: snapshot/uid interactions with
trusted-event verification, console/network buffers, dialogs, logpoints via
`moz:debugging`, prefs, navigation, screenshots, and negative paths.

Debug knobs: `FDM_TRACE=1` (Firefox-side BiDi trace + full browser log to
/tmp/fdm-browser-full.log), `FDM_FIREFOX=/path/to/firefox` (binary override, useful for
regression windows), `--headed`.

## Known divergences from the Node transport

- Node-only tools are not served: `restart_firefox`, `get_firefox_output`, and the
  webextension tools (`list_extensions`, `install_extension`, `uninstall_extension` —
  addon management stays a Node-transport concern).
- `get_firefox_prefs` / `set_firefox_prefs`: overridden in `src/mcp.ts` (same
  names/schemas/response text) using experiment privilege; upstream needs Selenium
  chrome-context scripts plus `-remote-allow-system-access`.
- `select_privileged_context` errors with a clear message — it requires Selenium's
  `setContext`. `list_privileged_contexts` errors with the same "system access" message
  the upstream server produces without `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` (the
  in-process session is created without that flag).
- No `--enable-script` / `--enable-privileged-context` gating: the extension serves the
  full surface behind the loopback bearer token. Revisit before any real distribution.
- uid resolution is CSS-only (upstream falls back to XPath and caches WebElements).
- `set_viewport_size` sets the BiDi viewport; upstream resizes the outer window rect.
- `upload_file_by_uid` is broken on macOS (`input.setFiles` platform bug).
- tools/call has a 60s timeout race the upstream server lacks (protects the in-browser
  HTTP connection from a hung handler; the losing handler is not cancelled).

## Security posture (prototype)

Loopback-only listener, static dev bearer token, Origin-header rejection. Good enough
for local development; a real distribution needs per-client tokens, an off-by-default
server, and per-origin permission prompts.
