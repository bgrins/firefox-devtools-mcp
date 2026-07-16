// Browser shims for the node: builtins imported by shared tool sources
// (screenshot.ts: fs/promises + path for the optional savePath flow;
// firefox-management.ts: fs for launcher log files — tool not exposed here).

export async function writeFile(): Promise<never> {
  throw new Error("Saving to a host path is not supported in the extension transport");
}
export async function mkdir(): Promise<never> {
  throw new Error("Saving to a host path is not supported in the extension transport");
}
export function readFileSync(): never {
  throw new Error("Host file access is not supported in the extension transport");
}
export function existsSync(): boolean {
  return false;
}
export function statSync(): never {
  throw new Error("Host file access is not supported in the extension transport");
}
export function resolve(...parts: string[]): string {
  return parts.join("/");
}
export function dirname(p: string): string {
  return p.split("/").slice(0, -1).join("/") || "/";
}
export function join(...parts: string[]): string {
  return parts.join("/");
}
export function fileURLToPath(u: string): string {
  return String(u).replace(/^file:\/\//, "");
}
