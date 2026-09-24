#!/usr/bin/env node
// Smoke test: spawn server-codemode.js, list tools, run a couple of code
// snippets through it. Does NOT require the Chrome extension to be running
// for the first checks — only the third check exercises the upstream proxy
// path and may fail gracefully if the extension isn't connected.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server-codemode.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: "inherit"
});

const client = new Client(
  { name: "codemode-smoketest", version: "0.0.1" },
  { capabilities: {} }
);

try {
  console.error("\n--- connecting ---");
  await client.connect(transport);

  console.error("\n--- tools/list ---");
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.error(`got ${tools.length} tools:`, names);
  const expected = ["execute_code", "screenshot", "zoom"].sort();
  if (names.length !== expected.length || !names.every((n, i) => n === expected[i])) {
    throw new Error(`expected tools ${expected.join(",")}; got ${names.join(",")}`);
  }
  const execTool = tools.find((t) => t.name === "execute_code");
  console.error("execute_code description length:", execTool.description.length);
  console.error("execute_code description head:\n" + execTool.description.slice(0, 600) + "...");

  console.error("\n--- execute_code (no tool calls) ---");
  const r1 = await client.callTool({
    name: "execute_code",
    arguments: { code: "async () => 42" }
  });
  console.error("result:", JSON.stringify(r1, null, 2));

  console.error("\n--- execute_code (chrome.tabs_context_mcp) ---");
  const r2 = await client.callTool({
    name: "execute_code",
    arguments: {
      code: "async () => { const ctx = await chrome.tabs_context_mcp({ createIfEmpty: true }); return { tabCount: ctx.availableTabs?.length, firstTabId: ctx.availableTabs?.[0]?.tabId, tabGroupId: ctx.tabGroupId }; }"
    }
  });
  console.error("result:", JSON.stringify(r2, null, 2));

  console.error("\n--- screenshot sibling tool ---");
  // Pull a tabId from the previous result so the screenshot has a target.
  let tabId;
  try {
    const text = r2.content?.[0]?.text ?? "";
    const m = text.match(/"firstTabId"\s*:\s*(\d+)/);
    if (m) tabId = Number(m[1]);
  } catch {}
  if (tabId) {
    const r3 = await client.callTool({
      name: "screenshot",
      arguments: { tabId }
    });
    const types = (r3.content ?? []).map((b) => b.type);
    console.error("screenshot content block types:", types);
    if (!types.includes("image")) {
      throw new Error("screenshot did not return an image content block");
    }
  } else {
    console.error("(no tabId available, skipping screenshot live test)");
  }
} finally {
  await client.close();
}
