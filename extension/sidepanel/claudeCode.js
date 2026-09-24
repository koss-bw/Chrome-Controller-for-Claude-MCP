// Local Claude Code client — talks to the FastAPI sidecar in server/.
//
// Runs in the panel page for the same reasons claudeWeb.js does: SSE needs an
// incrementally-readable body, and the service worker can be evicted mid-stream
// while an open panel can't. The manifest's <all_urls> host permission covers
// http://127.0.0.1, so this fetches localhost with the CORS bypass.
//
// Unlike the claude.ai backend, this one is talking to a server in this repo,
// so the wire format is ours: the sidecar normalizes Claude Code's stream-json
// output into the small vocabulary below and the panel never sees Anthropic
// block shapes.
//
//   { t:"accepted",    session_id }              first frame, always
//   { t:"init",        session_id, model, cwd, permission_mode, mcp_servers }
//   { t:"text",        text }                    assistant token
//   { t:"tool",        id, name }                tool call started
//   { t:"tool_input",  tools:[{id,name,input}] } complete arguments
//   { t:"tool_result", results:[{id,is_error,text}] }
//   { t:"notice",      text }                    e.g. rate limiting
//   { t:"done",        result, is_error, num_turns, duration_ms, cost_usd, … }
//   { t:"error",       text }

import { readSseEvents } from "./sse.js";

export const CONFIG = {
  defaultBase: "http://127.0.0.1:8765",
  endpoints: {
    health: "/health",
    bootstrap: "/auth/bootstrap",
    commands: "/commands",
    slashCommands: "/slash-commands",
    chat: "/chat",
    interrupt: "/interrupt",
    browseDirectory: "/browse-directory"
  },
  tokenHeader: "X-OCIC-Token",
  clientHeader: "X-OCIC-Client"
};

// Model choices for the Code backend. These are Claude Code aliases, resolved
// by the CLI, not claude.ai model ids — the two backends do not share a list.
export const CODE_MODELS = [
  { id: null, label: "Server default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" }
];

// Raised when the sidecar isn't reachable, so the panel can show a "start the
// server" card rather than a generic failure.
export class ServerUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ServerUnavailableError";
    this.cause = cause;
  }
}

export class ClaudeCode {
  constructor(store) {
    // store: { get(key), set(key, val) } backed by chrome.storage.local.
    this.store = store;
    this.token = null;
    this.base = null;
  }

  async getBase() {
    if (this.base) return this.base;
    const saved = await this.store.get("code_server_url");
    return (this.base = saved || CONFIG.defaultBase);
  }

  async setBase(url) {
    this.base = url || CONFIG.defaultBase;
    await this.store.set("code_server_url", this.base);
    // A different server has a different token.
    this.token = null;
    await this.store.set("code_token", "");
  }

  // Cached token, else the one the user pasted, else bootstrap from the server.
  async getToken() {
    if (this.token) return this.token;
    const saved = await this.store.get("code_token");
    if (saved) return (this.token = saved);

    const base = await this.getBase();
    let res;
    try {
      // The custom header is the authorization, not decoration: a web page
      // can't send one cross-origin without a preflight the server refuses,
      // while this request skips preflight thanks to the host permission.
      // Chrome omits Origin on that privileged request, so the server can't
      // gate on it.
      res = await fetch(base + CONFIG.endpoints.bootstrap, {
        headers: { [CONFIG.clientHeader]: "panel" }
      });
    } catch (e) {
      throw new ServerUnavailableError(`Can't reach the sidecar at ${base}.`, e);
    }
    if (!res.ok) {
      // Usually "bootstrap": false. Surfaced as ServerUnavailable so the panel
      // shows the card with the token field rather than a generic error bubble.
      const detail = await res
        .json()
        .then((d) => d?.detail)
        .catch(() => null);
      throw new ServerUnavailableError(
        `The server won't hand out a token (HTTP ${res.status}${detail ? `: ${detail}` : ""}). ` +
          `Paste the contents of ~/.config/chrome-controller-mcp/panel-token below.`
      );
    }
    const { token } = await res.json();
    this.token = token;
    await this.store.set("code_token", token);
    return token;
  }

  async setToken(token) {
    this.token = token || null;
    await this.store.set("code_token", token || "");
  }

  async _headers() {
    return {
      "Content-Type": "application/json",
      [CONFIG.tokenHeader]: await this.getToken()
    };
  }

  // Is the sidecar up and does it have a usable `claude`? Never throws — the
  // panel calls this to decide whether the Code backend is selectable.
  async health() {
    const base = await this.getBase();
    try {
      const res = await fetch(base + CONFIG.endpoints.health);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { ok: false, error: `Can't reach ${base} — is server/run.sh running?` };
    }
  }

  async commands() {
    const base = await this.getBase();
    const res = await fetch(base + CONFIG.endpoints.commands, {
      headers: await this._headers()
    });
    if (!res.ok) throw new Error(`Loading commands failed (HTTP ${res.status}).`);
    return await res.json();
  }

  // Every slash command the CLI can dispatch in `cwd` — builtins, bundled
  // skills, and the user's and project's own — for the composer's autocomplete.
  // The server asks the CLI itself, so the list is already limited to commands
  // that work in print mode; the panel never offers a dead end.
  async slashCommands(cwd) {
    const base = await this.getBase();
    const url = new URL(base + CONFIG.endpoints.slashCommands);
    if (cwd) url.searchParams.set("cwd", cwd);
    const res = await fetch(url, { headers: await this._headers() });
    if (!res.ok) throw new Error(`Loading slash commands failed (HTTP ${res.status}).`);
    return (await res.json()).commands || [];
  }

  // Run one turn. `sessionId` is null for a new conversation and the previously
  // returned id to continue one. `cwd` overrides the server's default working
  // directory for this turn only; omit it to use the server default. Every
  // normalized event is handed to onEvent; returns the final { t:"done" }
  // frame (or the error frame that replaced it).
  async sendMessage({ prompt, command, model, sessionId, cwd, signal }, onEvent) {
    const base = await this.getBase();
    let res;
    try {
      res = await fetch(base + CONFIG.endpoints.chat, {
        method: "POST",
        signal,
        headers: await this._headers(),
        body: JSON.stringify({
          prompt: prompt || "",
          command: command || null,
          model: model || null,
          session_id: sessionId || null,
          cwd: cwd || null
        })
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new ServerUnavailableError(`Can't reach the sidecar at ${base}.`, e);
    }

    if (res.status === 401) {
      // Token rotated (server restarted with a fresh config dir). Drop ours so
      // the next attempt re-bootstraps instead of failing the same way forever.
      await this.setToken("");
      throw new Error("Sidecar rejected the token. Try again to re-authorize.");
    }
    if (!res.ok || !res.body) {
      // A bad `cwd` (see the /chat handler's 400) is worth surfacing verbatim
      // rather than as a bare status code.
      const detail = await res
        .json()
        .then((d) => d?.detail)
        .catch(() => null);
      throw new Error(`Sidecar chat failed (HTTP ${res.status}${detail ? `: ${detail}` : ""}).`);
    }

    let last = null;
    for await (const payload of readSseEvents(res.body)) {
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      last = event;
      onEvent(event);
      if (event.t === "done") return event;
    }
    return last;
  }

  // Pop a native folder picker on the sidecar's machine and return the chosen
  // absolute path, or null if the user cancelled. The dialog runs server-side
  // (see server/app.py) because the browser's own picker can't hand back a
  // real OS path — that's exactly what the File System Access API sandboxes.
  async browseDirectory(start) {
    const base = await this.getBase();
    let res;
    try {
      res = await fetch(base + CONFIG.endpoints.browseDirectory, {
        method: "POST",
        headers: await this._headers(),
        body: JSON.stringify({ start: start || null })
      });
    } catch (e) {
      throw new ServerUnavailableError(`Can't reach the sidecar at ${base}.`, e);
    }
    if (res.status === 401) {
      await this.setToken("");
      throw new Error("Sidecar rejected the token. Try again to re-authorize.");
    }
    if (!res.ok) {
      const detail = await res
        .json()
        .then((d) => d?.detail)
        .catch(() => null);
      throw new Error(`Folder picker failed (HTTP ${res.status}${detail ? `: ${detail}` : ""}).`);
    }
    const { path } = await res.json();
    return path || null;
  }

  // Stop the running turn server-side. Best-effort: aborting the fetch alone
  // also kills it (the sidecar watches for the disconnect), but this is the
  // deterministic path and doesn't wait on a poll interval.
  async interrupt(sessionId) {
    if (!sessionId) return false;
    const base = await this.getBase();
    try {
      const res = await fetch(base + CONFIG.endpoints.interrupt, {
        method: "POST",
        headers: await this._headers(),
        body: JSON.stringify({ session_id: sessionId })
      });
      if (!res.ok) return false;
      return (await res.json())?.stopped === true;
    } catch {
      return false;
    }
  }
}
