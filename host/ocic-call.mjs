#!/usr/bin/env node
// Dev/test client: call any extension handler directly over the runtime's TCP
// port, with exactly the args you pass.
//
//   node host/ocic-call.mjs <tool> '<json-args>'
//   node host/ocic-call.mjs __dump_browser_state
//   node host/ocic-call.mjs tabs_context_mcp '{"newWindow":true}'
//
// Why this exists: the MCP path validates args with zod and strips unknown
// keys, so a newly-added parameter is invisible until every Claude Code
// session restarts its MCP server. This connects as a plain runtime client
// (same `client_hello` handshake host/tool-runtime.js uses for multiplexing),
// which means new parameters and the dev-only __ handlers are reachable
// immediately, against the browser that is already attached.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PORT = 18765;
function getPort() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".config", "chrome-controller-mcp", "config.json"),
        "utf-8"
      )
    );
    return cfg.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

export function call(tool, args = {}, { timeoutMs = 30000, port = getPort() } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, "127.0.0.1");
    let buf = "";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn(v);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`timeout after ${timeoutMs}ms calling ${tool}`)),
      timeoutMs
    );

    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "client_hello" }) + "\n");
      sock.write(JSON.stringify({ id: "1", type: "tool_request", tool, args }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "client_ack" || msg.type === "heartbeat") continue;
        if (msg.id !== "1") continue;
        if (msg.type === "tool_error") return finish(reject, new Error(msg.error));
        return finish(resolve, msg.result);
      }
    });
    sock.on("error", (e) => finish(reject, e));
    sock.on("close", () => finish(reject, new Error("socket closed before a response")));
  });
}

// Text of the first content block, which is where every handler puts its payload.
export function textOf(result) {
  if (typeof result === "string") return result;
  return result?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tool, rawArgs] = process.argv.slice(2);
  if (!tool) {
    console.error("usage: node host/ocic-call.mjs <tool> '<json-args>'");
    process.exit(2);
  }
  try {
    const result = await call(tool, rawArgs ? JSON.parse(rawArgs) : {});
    console.log(textOf(result));
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
