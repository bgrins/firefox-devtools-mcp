#!/usr/bin/env node
// Dev launcher: headed Nightly with the extension, quiet startup, MCP on :9339.

import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { QUIET_STARTUP_PREFS, EXTENSION_PREFS, prefArgs } from "./prefs.mjs";

const extDir = dirname(fileURLToPath(import.meta.url));
const localWebExt = join(extDir, "node_modules", ".bin", "web-ext");
const [bin, prefix] = existsSync(localWebExt) ? [localWebExt, []] : ["npx", ["web-ext"]];

const port = process.env.PORT || 9339;
const child = spawn(
  bin,
  [
    ...prefix,
    "run",
    "--firefox=nightly",
    `--source-dir=${extDir}`,
    ...prefArgs(EXTENSION_PREFS(port)),
    ...prefArgs(QUIET_STARTUP_PREFS),
  ],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));
console.log(`[run] MCP will listen on http://127.0.0.1:${port}/mcp (Bearer bidi-bridge-dev)`);
