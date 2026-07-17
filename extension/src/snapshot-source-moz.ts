// moz-build variant of snapshot-source.ts: the snapshot bundle is embedded as text
// (build-moz.mjs copies it to dist/snapshot.injected.txt and loads it with esbuild's
// text loader).

// @ts-expect-error generated at build time, imported via esbuild text loader
import source from "../dist/snapshot.injected.txt";

export async function getSnapshotSource(): Promise<string> {
  return source as string;
}
