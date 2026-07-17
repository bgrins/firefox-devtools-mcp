#!/usr/bin/env node
// Builds dist/fdm-core.mjs: the tool surface + facade + MCP protocol as a single
// chrome-consumable ES module for vendoring into mozilla-central
// (browser/components/mcp/vendor/). Free references to `browser`/`setTimeout`/
// `clearTimeout` resolve to live bindings in src/moz-shim.ts, filled in by the
// embedder via the exported configure().

import { build } from "esbuild";
import { copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(fileURLToPath(import.meta.url));
const shim = join(extDir, "src", "node-shims.ts");

const redirectPlugin = {
  name: "moz-redirects",
  setup(b) {
    // The integration seam: tool handlers import '../index.js' for getFirefox().
    b.onResolve({ filter: /^\.\.\/index\.js$/ }, (args) => {
      if (args.resolveDir.endsWith(join("src", "tools"))) {
        return { path: join(extDir, "src", "provider.ts") };
      }
      return undefined;
    });
    // Snapshot source comes from embedded text rather than a packaged file.
    b.onResolve({ filter: /^\.\/snapshot-source\.js$/ }, () => ({
      path: join(extDir, "src", "snapshot-source-moz.ts"),
    }));
  },
};

// The injected snapshot script, embedded as a string.
await build({
  entryPoints: {
    "snapshot.injected": join(extDir, "..", "src", "firefox", "snapshot", "injected", "snapshot.injected.ts"),
  },
  outfile: join(extDir, "dist", "snapshot.injected.global.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  globalName: "__SnapshotInjected",
});
copyFileSync(
  join(extDir, "dist", "snapshot.injected.global.js"),
  join(extDir, "dist", "snapshot.injected.txt")
);

await build({
  entryPoints: { "fdm-core": join(extDir, "src", "moz-entry.ts") },
  outfile: join(extDir, "dist", "fdm-core.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "firefox128",
  plugins: [redirectPlugin],
  inject: [join(extDir, "src", "moz-shim.ts")],
  loader: { ".txt": "text" },
  alias: {
    "node:fs": shim,
    "node:fs/promises": shim,
    "node:path": shim,
    "node:url": shim,
    fs: shim,
    "fs/promises": shim,
    path: shim,
    url: shim,
  },
  define: {
    "process.env.DEBUG": "undefined",
    "process.env.NODE_ENV": '"production"',
  },
  banner: {
    js: `/* Generated file — do not edit. Built from
 * https://github.com/mozilla/firefox-devtools-mcp (extension/build-moz.mjs).
 * Dual-licensed MIT OR Apache-2.0; see LICENSE-MIT / LICENSE-APACHE upstream. */`,
  },
});

console.log("moz bundle built: dist/fdm-core.mjs");
