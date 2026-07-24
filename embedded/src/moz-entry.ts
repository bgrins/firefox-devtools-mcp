// Entry point for the moz (in-tree) bundle: the MCP protocol layer and tool registry
// over an embedder-supplied BiDi bridge. Call configure(env) first, then
// startMcp(port).

export { configure } from "./moz-shim.js";
export { startMcp, DEFAULT_PORT } from "./mcp.js";
