#!/usr/bin/env node
// Smoke test for the hybrid server: confirms direct tool calls and
// execute_code both work in the same session. The Chrome extension must
// be connected for the live calls to succeed; without it, the upstream
// call returns an error which we surface but don't fail the test on.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server-hybrid.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: "inherit"
});

const client = new Client(
  { name: "hybrid-smoketest", version: "0.0.1" },
  { capabilities: {} }
);

try {
  console.error("\n--- connecting ---");
  await client.connect(transport);

  console.error("\n--- tools/list ---");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  console.error(`got ${tools.length} tools:`, names);
  if (!names.includes("execute_code")) {
    throw new Error("execute_code missing from hybrid tool list");
  }
  if (!names.includes("tabs_context_mcp")) {
    throw new Error("expected upstream tools also exposed (tabs_context_mcp missing)");
  }

  console.error("\n--- direct call: tabs_context_mcp ---");
  const r1 = await client.callTool({
    name: "tabs_context_mcp",
    arguments: {}
  });
  console.error("direct result content[0].text preview:",
    (r1.content?.[0]?.text ?? "").slice(0, 200));

  console.error("\n--- execute_code: no tool calls ---");
  const r2 = await client.callTool({
    name: "execute_code",
    arguments: { code: "async () => ({ ok: true, n: 7 })" }
  });
  console.error("execute_code result:", JSON.stringify(r2, null, 2));

  console.error("\n--- execute_code: chrome.tabs_context_mcp ---");
  const r3 = await client.callTool({
    name: "execute_code",
    arguments: {
      code: "async () => { const ctx = await chrome.tabs_context_mcp({}); return { tabCount: ctx.availableTabs?.length, tabGroupId: ctx.tabGroupId }; }"
    }
  });
  console.error("execute_code result:", JSON.stringify(r3, null, 2));
} finally {
  await client.close();
}
