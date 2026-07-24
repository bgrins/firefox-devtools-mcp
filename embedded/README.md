# Embedded bundle

Builds `dist/fdm-core.mjs`: the repository's tool surface (`../src/tools`),
a `browser.bidi`-style facade (`src/client.ts`), and a minimal MCP
JSON-RPC-over-HTTP layer (`src/mcp.ts`) as a single chrome-consumable ES
module. Firefox vendors the output into
`browser/components/mcp/vendor/fdm-core.mjs` and supplies the actual BiDi
bridge, HTTP socket, and lifecycle via the exported
`configure({ bidi, version, setTimeout, clearTimeout })` before calling
`startMcp(port)`.

```
npm install
npm run build:moz
```

Node-only tools (process restart/output, extension management) are excluded
from the registry at build time; see `NODE_ONLY_TOOLS` in `src/mcp.ts`.
