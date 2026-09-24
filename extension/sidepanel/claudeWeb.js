// claude.ai web-API client — reuses the browser's logged-in claude.ai session.
//
// This runs IN THE PANEL PAGE (not the service worker) on purpose:
//   - an extension page with host permission for claude.ai (covered by the
//     manifest's <all_urls>) gets the CORS bypass and sends the session cookie
//     with credentials:"include";
//   - SSE needs an incrementally-readable body (res.body.getReader()), which
//     runtime.sendMessage can't carry;
//   - the SW can be evicted mid-stream; an open panel can't.
// The code never reads the sessionKey cookie — the browser attaches it.
//
// CAVEAT: claude.ai's web endpoints are undocumented and may change. Every URL,
// body field, and SSE shape below is a best-effort assumption gathered from the
// public web app and MUST be verified against the Network tab (see the plan's
// Verification section). Everything mutable lives in CONFIG so corrections are
// one-line.

import { readSseEvents } from "./sse.js";

export const CONFIG = {
  base: "https://claude.ai/api",
  loginUrl: "https://claude.ai/login",
  endpoints: {
    // Try these in order to resolve the org list; first that returns orgs wins.
    orgs: ["/organizations", "/bootstrap", "/account"],
    // {org} / {conv} are substituted at call time.
    createConversation: "/organizations/{org}/chat_conversations",
    completion: "/organizations/{org}/chat_conversations/{conv}/completion"
  },
  // Body field names for the completion request (isolated so a rename is 1 line).
  fields: {
    prompt: "prompt",
    parentMessageUuid: "parent_message_uuid",
    timezone: "timezone",
    model: "model"
  }
};

// "Default" (null → let claude.ai pick) plus ids VERIFIED to be accepted by the
// completion endpoint against a real enterprise account (the default resolved to
// claude-opus-4-8). The /models endpoint is 403 for this seat and the SPA loads
// its model list from JS chunks, so ids can't be enumerated at runtime — to add
// a model, switch it in claude.ai and read the `model` field of the completion
// request body in the Network tab, then paste that exact string here.
export const MODELS = [
  { id: null, label: "Default" },
  { id: "claude-opus-4-8", label: "Opus 4.8" }
];

// Raised on an unauthenticated / challenged session so the UI can show the
// sign-in state instead of a generic error.
export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function isAuthStatus(status) {
  return status === 401 || status === 403;
}

async function apiFetch(path, init = {}) {
  const res = await fetch(CONFIG.base + path, {
    credentials: "include",
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) }
  });
  if (isAuthStatus(res.status)) {
    throw new AuthError(`Not signed in to claude.ai (HTTP ${res.status}).`, res.status);
  }
  return res;
}

// Pull an org uuid out of whatever shape the endpoint returns. /organizations
// is an array of orgs; /bootstrap and /account nest them under `account`.
// VERIFIED against a real account: each org has `capabilities` as an ARRAY of
// strings, e.g. ["raven_enterprise","chat","raven"] for the enterprise chat org
// vs ["api","api_individual"] for the developer/Console org. We MUST prefer the
// chat-capable one — picking the api-only org would make every completion 403.
function extractOrgUuid(data) {
  const list = Array.isArray(data)
    ? data
    : data?.organizations || data?.account?.memberships?.map((m) => m.organization) || [];
  if (!Array.isArray(list) || !list.length) return null;
  const caps = (o) => (Array.isArray(o?.capabilities) ? o.capabilities : []);
  const chatOrg = list.find((o) => o?.uuid && caps(o).includes("chat"));
  if (chatOrg) return chatOrg.uuid;
  // No explicit chat capability seen — fall back to the first non-API org,
  // then to any org with a uuid.
  const nonApi = list.find((o) => o?.uuid && !caps(o).includes("api"));
  return (nonApi || list.find((o) => o?.uuid))?.uuid || null;
}

// --- Public client -------------------------------------------------------

export class ClaudeWeb {
  constructor(store) {
    // store: { get(key), set(key, val) } backed by chrome.storage.local.
    this.store = store;
    this.orgUuid = null;
  }

  async getOrgUuid() {
    if (this.orgUuid) return this.orgUuid;
    const cached = await this.store.get("claude_org_uuid");
    if (cached) return (this.orgUuid = cached);
    let lastErr = null;
    for (const path of CONFIG.endpoints.orgs) {
      try {
        const res = await apiFetch(path);
        if (!res.ok) continue;
        const uuid = extractOrgUuid(await res.json());
        if (uuid) {
          this.orgUuid = uuid;
          await this.store.set("claude_org_uuid", uuid);
          return uuid;
        }
      } catch (e) {
        if (e instanceof AuthError) throw e;
        lastErr = e;
      }
    }
    throw new Error("Could not resolve a claude.ai organization." + (lastErr ? ` (${lastErr.message})` : ""));
  }

  async createConversation() {
    const org = await this.getOrgUuid();
    const path = CONFIG.endpoints.createConversation.replace("{org}", org);
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid: crypto.randomUUID(), name: "" })
    });
    if (!res.ok) throw new Error(`Create conversation failed (HTTP ${res.status}).`);
    const data = await res.json();
    const uuid = data?.uuid || data?.conversation?.uuid;
    if (!uuid) throw new Error("Create conversation returned no uuid.");
    return uuid;
  }

  // Send `prompt` to conversation `convUuid`, streaming assistant text to
  // onDelta(textChunk). `model` is the selected id or null for the default.
  // parentMessageUuid links the turn to the prior assistant message; on the
  // first turn it's the empty-uuid sentinel the web app uses.
  async sendMessage({ convUuid, prompt, model, parentMessageUuid, signal }, onDelta) {
    const org = await this.getOrgUuid();
    const path = CONFIG.endpoints.completion
      .replace("{org}", org)
      .replace("{conv}", convUuid);
    const f = CONFIG.fields;
    const body = {
      [f.prompt]: prompt,
      [f.parentMessageUuid]: parentMessageUuid || "00000000-0000-4000-8000-000000000000",
      [f.timezone]: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      attachments: [],
      files: [],
      rendering_mode: "messages"
    };
    if (model) body[f.model] = model;

    const res = await fetch(CONFIG.base + path, {
      method: "POST",
      credentials: "include",
      signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body)
    });
    if (isAuthStatus(res.status)) {
      throw new AuthError(`Not signed in to claude.ai (HTTP ${res.status}).`, res.status);
    }
    if (!res.ok || !res.body) throw new Error(`claude.ai completion failed (HTTP ${res.status}).`);

    return await this._readSse(res.body, onDelta);
  }

  // Parse the SSE stream. VERIFIED event flow from claude.ai:
  //   message_start   → carries message.uuid (the assistant turn's id)
  //   content_block_delta → {delta:{type:"text_delta",text:"…"}}   (the tokens)
  //   message_stop    → end of turn
  // We also accept the older {"type":"completion","completion":"…"} delta shape
  // defensively. Returns { messageUuid } so the caller can thread the next turn.
  async _readSse(stream, onDelta) {
    let messageUuid = null;
    for await (const payload of readSseEvents(stream)) {
      if (payload === "[DONE]") return { messageUuid };
      let d;
      try {
        d = JSON.parse(payload);
      } catch {
        continue;
      }
      if (d?.type === "message_start") messageUuid = d?.message?.uuid || messageUuid;
      if (d?.type === "message_stop") return { messageUuid };
      const chunk = d?.completion ?? d?.delta?.text ?? "";
      if (chunk) onDelta(chunk);
    }
    return { messageUuid };
  }
}
