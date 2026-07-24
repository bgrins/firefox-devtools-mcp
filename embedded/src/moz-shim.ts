// Chrome-environment shim for the moz bundle. esbuild injects this module, so free
// references to `browser`, `setTimeout`, and `clearTimeout` throughout the bundle
// resolve to these live bindings; the embedder fills them in via configure() before
// starting the server.

export let browser: any;
export let setTimeout: any;
export let clearTimeout: any;

export interface MozEnv {
  // browser.bidi equivalent: { send, subscribe, unsubscribe, startServer, stopServer,
  // sendHttpResponse, getPref, setPref, onEvent: {addListener}, onHttpRequest: {addListener} }
  bidi: any;
  // Firefox version string ("154.0a1") for compareVersions-based tool gating.
  version: string;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

export function configure(env: MozEnv): void {
  browser = {
    bidi: env.bidi,
    runtime: {
      getBrowserInfo: async () => ({ version: env.version }),
    },
  };
  setTimeout = env.setTimeout;
  clearTimeout = env.clearTimeout;
}
