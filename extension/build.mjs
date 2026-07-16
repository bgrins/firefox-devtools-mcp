#!/usr/bin/env node
// Direct esbuild build (tsup's node-builtin externalization races custom shims).

import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const extDir = dirname(fileURLToPath(import.meta.url));
const shim = join(extDir, "src", "node-shims.ts");

// The integration seam: upstream tool handlers import '../index.js' for getFirefox();
// redirect to the extension provider without touching upstream sources.
const redirectPlugin = {
  name: "extension-redirects",
  setup(b) {
    b.onResolve({ filter: /^\.\.\/index\.js$/ }, (args) => {
      if (args.resolveDir.endsWith(join("src", "tools"))) {
        return { path: join(extDir, "src", "provider.ts") };
      }
      return undefined;
    });
  },
};

await build({
  entryPoints: { background: join(extDir, "src", "background.ts") },
  outfile: join(extDir, "dist", "background.global.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox128",
  sourcemap: true,
  plugins: [redirectPlugin],
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
});

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

console.log("extension bundles built");
