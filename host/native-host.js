#!/usr/bin/env node

// Native Messaging Host for Chrome Controller for Claude extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 18765;
const DEFAULT_RECORDINGS_DIR = path.join(REPO_DIR, "recordings");
const DEFAULT_CUSTOM_APIS_DIR = path.join(REPO_DIR, "custom_apis");

const CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "chrome-controller-mcp",
  "config.json"
);

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function getPort() {
  return readConfig().port || DEFAULT_PORT;
}

// Where recording bundles land. Override with `recordings_dir` in config.json
// (the same file getPort reads). Resolved once at startup, like the port — a
// change needs a reconnect, which is when Chrome relaunches this process.
const RECORDINGS_DIR = (() => {
  const dir = readConfig().recordings_dir;
  if (!dir) return DEFAULT_RECORDINGS_DIR;
  return String(dir).replace(/^~(?=\/|$)/, os.homedir());
})();

// The recording id becomes a directory name, and this process is a trust
// boundary — it acts on whatever arrives on stdin. Keep the segment flat so a
// crafted id can never write outside RECORDINGS_DIR.
function recordingDir(recordingId) {
  const safe = String(recordingId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(RECORDINGS_DIR, safe.replace(/^\.+/, "_") || "unknown");
}

// Where reverse-engineered API bundles land, one directory per site. Override
// with `custom_apis_dir` in config.json. Resolved once at startup, same as
// RECORDINGS_DIR.
const CUSTOM_APIS_DIR = (() => {
  const dir = readConfig().custom_apis_dir;
  if (!dir) return DEFAULT_CUSTOM_APIS_DIR;
  return String(dir).replace(/^~(?=\/|$)/, os.homedir());
})();

// Same trust boundary as recordingDir, but API bundles are nested
// (requests/3.json, static/scripts/app.js), so a relative path is allowed —
// one sanitized segment at a time, never a segment that could climb out. The
// resolve check at the end is the actual guarantee; the per-segment scrub just
// keeps filenames sane.
function apiArtifactPath(slug, relPath) {
  const seg = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "_");
  const root = path.join(CUSTOM_APIS_DIR, seg(slug || "unknown") || "unknown");
  const parts = String(relPath || "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
    .map(seg)
    .filter(Boolean);
  if (!parts.length) throw new Error("empty artifact path");
  const full = path.resolve(root, ...parts);
  const rootResolved = path.resolve(CUSTOM_APIS_DIR) + path.sep;
  if (!full.startsWith(rootResolved)) throw new Error("artifact path escapes the bundle root");
  return full;
}

// --- Native messaging protocol (Chrome <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- TCP connection to MCP server ---

let tcpSocket = null;
let tcpBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const TCP_PORT = getPort();

// When the primary rejects us because ANOTHER browser's host already holds
// the native slot, retry slowly (15s) instead of hammering every 1.5s: with
// two browsers running OCIC, the loser otherwise reconnect-spams the primary
// and makes browser selection flap across primary restarts.
let rejectedByPrimary = false;
const RETRY_MS = 1500;
const REJECTED_RETRY_MS = 15000;

function connectTcp() {
  if (tcpSocket) return;

  tcpSocket = new net.Socket();

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  });

  tcpSocket.on("data", (chunk) => {
    // newline-delimited JSON from MCP server
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "error" && /another browser profile/i.test(msg.error || "")) {
          // The primary already has a browser attached; we are the loser of
          // the slot. Back off hard instead of hammering every 1.5s.
          rejectedByPrimary = true;
        }
        // Forward to extension via native messaging
        writeNativeMessage(msg);
      } catch {
        // skip malformed
      }
    }
  });

  tcpSocket.on("error", () => {
    tcpSocket = null;
  });

  tcpSocket.on("close", () => {
    tcpSocket = null;
    if (!reconnectTimer) {
      // Keep retrying indefinitely — do NOT exit when the MCP server is gone.
      // The native host also writes recording bundles to disk (save_recording),
      // which must work with no Claude session connected. Lifetime is tied to
      // the extension (stdin), which ends on browser/extension shutdown below.
      // Rejected-by-primary (another browser holds the slot): slow lane, and
      // re-probe occasionally in case the winner's browser goes away.
      const interval = rejectedByPrimary ? REJECTED_RETRY_MS : RETRY_MS;
      rejectedByPrimary = false;
      reconnectTimer = setInterval(() => {
        if (!tcpSocket) connectTcp();
      }, interval);
    }
  });
}

// --- Recording bundle write ---
// The recorder saves the trace to disk here, in the native host, instead of
// via chrome.downloads — the browser download path shows an OS save dialog on
// some setups, and this also lets us write to a stable location the coding
// agent can open. Returns the absolute directory so the extension can notify
// Claude Code with a real path.
function handleSaveRecording(msg) {
  try {
    const dir = recordingDir(msg.recording_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "trace.json"),
      JSON.stringify(msg.trace ?? {}, null, 2)
    );
    // Ship the schema descriptor alongside so the agent knows how to read it.
    if (typeof msg.schema_md === "string" && msg.schema_md) {
      fs.writeFileSync(path.join(dir, `SCHEMA_${msg.schema || "v0"}.md`), msg.schema_md);
    }
    writeNativeMessage({
      type: "recording_saved",
      recording_id: msg.recording_id,
      path: dir,
      ok: true
    });
  } catch (e) {
    writeNativeMessage({
      type: "recording_saved",
      recording_id: msg.recording_id,
      ok: false,
      error: String(e && e.message)
    });
  }
}

// Write one 240p frame into the recording's images/ dir. Fire-and-forget:
// the reference is already in the trace, so a dropped frame just means the
// agent finds no file at that ref.
function handleSaveScreenshot(msg) {
  try {
    const dir = path.join(recordingDir(msg.recording_id), "images");
    fs.mkdirSync(dir, { recursive: true });
    const b64 = String(msg.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
    // Same reason as recordingDir: the frame name arrives over stdin and must
    // stay a single flat filename.
    const name = String(msg.name || "").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "_");
    if (b64 && name) fs.writeFileSync(path.join(dir, name), Buffer.from(b64, "base64"));
  } catch {
    // best-effort
  }
}

// --- API bundle writes ---
// Same reasoning as the recording writer above: the browser cannot write files,
// and chrome.downloads would show a save dialog and pick its own path. One
// message can carry many files so a crawl flushes in a single round trip, and
// the reply is correlated by id because the extension awaits it (unlike the
// fire-and-forget screenshot path).
function handleApiWrite(msg) {
  const files = Array.isArray(msg.files) ? msg.files : [msg];
  const written = [];
  try {
    for (const f of files) {
      const full = apiArtifactPath(msg.slug, f.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (typeof f.base64 === "string") {
        fs.writeFileSync(full, Buffer.from(f.base64.replace(/^data:[^;]+;base64,/, ""), "base64"));
      } else {
        fs.writeFileSync(full, typeof f.text === "string" ? f.text : JSON.stringify(f.json ?? null, null, 2));
      }
      written.push(full);
    }
    writeNativeMessage({
      type: "api_written",
      id: msg.id,
      ok: true,
      count: written.length,
      // The bundle root, so the extension can tell Claude where to look.
      dir: path.join(CUSTOM_APIS_DIR, String(msg.slug || "unknown").replace(/[^a-zA-Z0-9._-]/g, "-")),
      paths: written
    });
  } catch (e) {
    writeNativeMessage({
      type: "api_written",
      id: msg.id,
      ok: false,
      error: String(e && e.message)
    });
  }
}

// --- Main: bridge stdin (from extension) <-> TCP (to MCP server) ---

let stdinBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    // Handle recording saves locally (write to disk + reply); don't forward.
    if (msg && msg.type === "save_recording") {
      handleSaveRecording(msg);
      continue;
    }
    if (msg && msg.type === "save_screenshot") {
      handleSaveScreenshot(msg);
      continue;
    }
    if (msg && msg.type === "api_write") {
      handleApiWrite(msg);
      continue;
    }
    // Forward everything else to the MCP server via TCP.
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
  }
});

process.stdin.on("end", () => {
  // Extension disconnected
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start TCP connection
connectTcp();
