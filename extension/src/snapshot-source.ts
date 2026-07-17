// The injected snapshot bundle, fetched from the extension package. The moz build
// (build-moz.mjs) redirects this module to snapshot-source-moz.ts, which embeds the
// bundle as a string instead.

declare const browser: any;

export async function getSnapshotSource(): Promise<string> {
  const url = browser.runtime.getURL("dist/snapshot.injected.global.js");
  return (await fetch(url)).text();
}
