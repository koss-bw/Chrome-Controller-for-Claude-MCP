#!/usr/bin/env node

// MCP Server for Chrome Controller for Claude extension.
// Started by Claude Code via stdio MCP transport.
//
// All of the actual runtime logic (TCP port, native messaging, primary/client
// multiplexing) lives in host/tool-runtime.js so the codemode + hybrid
// servers can reuse it without spawning a child process. This file is the
// stdio MCP front-end: it registers the 33 tools and pipes them to the
// shared runtime.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { init, callTool, shutdown, coerceArgs } from "./tool-runtime.js";
import { TOOLS } from "./tool-definitions.js";

function exitClean(code = 0) {
  try {
    shutdown();
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => exitClean());
process.on("SIGINT", () => exitClean());
process.on("SIGHUP", () => exitClean());
process.stdin.on("end", () => exitClean());
process.stdin.resume();

await init();

const server = new McpServer({
  name: "chrome-controller-mcp",
  version: "1.0.0"
});

// Coerce stringified args (tabId, coordinate, etc.) before zod validation
// runs on tool-call requests. Some MCP clients serialize numbers/arrays
// as strings; the extension expects the real types.
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(
    server.server
  );
  server.server.setRequestHandler = function (schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      if (request?.params?.arguments) coerceArgs(request.params.arguments);
      return handler(request, extra);
    });
  };
}

for (const t of TOOLS) {
  server.tool(
    t.name,
    t.description,
    t.paramShape,
    async (args) => callTool(t.name, args)
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
