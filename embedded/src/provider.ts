// Stand-in for ../../src/index.js: tool handlers do
// `const { getFirefox } = await import('../index.js')` — the build aliases that
// specifier here, so upstream tool sources stay untouched.

import { ExtensionFirefoxClient } from "./client.js";

let client: ExtensionFirefoxClient | null = null;
let connecting: Promise<ExtensionFirefoxClient> | null = null;

export async function getFirefox(): Promise<ExtensionFirefoxClient> {
  if (client) return client;
  connecting ??= (async () => {
    try {
      const c = new ExtensionFirefoxClient();
      await c.connect();
      client = c;
      return c;
    } catch (e) {
      // A failed connect must not brick every later call with the same rejection.
      connecting = null;
      throw e;
    }
  })();
  return connecting;
}

// firefox-management.ts imports these statically; its tools are Node-process-bound and
// not exposed by the extension, but the module must still link.
export const args: Record<string, unknown> = { transport: "extension" };
export function getFirefoxIfRunning(): ExtensionFirefoxClient | null {
  return client;
}
export function resetFirefox(): void {
  client = null;
  connecting = null;
}
export function setNextLaunchOptions(): void {
  throw new Error("Launch options are not applicable in the extension transport");
}
