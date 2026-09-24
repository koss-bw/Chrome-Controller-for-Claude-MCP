// Side-panel controller: chat rendering + streaming for two interchangeable
// backends, model-picker persistence, the Claude Code command palette, the
// recorder button (which messages the service worker — all recorder logic
// stays in background.js), and multi-tab sessions.
//
// Backends:
//   web  — claude.ai session (claudeWeb.js). No local dependencies, text only.
//   code — local Claude Code sidecar (claudeCode.js). Native tool calling,
//          including this extension's own browser tools via the `browse` MCP
//          server; needs server/run.sh to be running.
//
// Sessions:
//   The header's + button opens a new tab rather than resetting the current
//   chat. Each tab is a `Session` — its own backend/model, conversation state,
//   and message DOM — so tabs can be switched between freely, and a turn kept
//   streaming in a background tab keeps rendering into its (hidden) element
//   instead of being interrupted.
import { ClaudeWeb, AuthError, MODELS, CONFIG } from "./claudeWeb.js";
import { ClaudeCode, ServerUnavailableError, CODE_MODELS } from "./claudeCode.js";
import { renderMarkdown } from "./markdown.js";

// --- chrome.storage.local wrapper handed to the clients ---
const store = {
  get: (key) => chrome.storage.local.get(key).then((o) => o[key]),
  set: (key, val) => chrome.storage.local.set({ [key]: val })
};

const webClient = new ClaudeWeb(store);
const codeClient = new ClaudeCode(store);

// --- DOM ---
const $ = (id) => document.getElementById(id);
const els = {
  backend: $("backend"),
  model: $("model"),
  newChat: $("newChat"),
  close: $("close"),
  tabBar: $("tabBar"),
  statusDot: $("statusDot"),
  signedOut: $("signedOut"),
  signedOutMsg: $("signedOutMsg"),
  signInBtn: $("signInBtn"),
  serverDown: $("serverDown"),
  serverDownMsg: $("serverDownMsg"),
  tokenInput: $("tokenInput"),
  retryServer: $("retryServer"),
  cwdBtn: $("cwdBtn"),
  themeToggle: $("themeToggle"),
  minimize: $("minimize"),
  slashMenu: $("slashMenu"),
  palette: $("palette"),
  messagesContainer: $("messagesContainer"),
  input: $("input"),
  send: $("send"),
  recBtn: $("recBtn"),
  recState: $("recState")
};

// --- Sessions (tabs) ---
// Each session owns its own conversation state and message DOM. `sessions`
// holds every open tab; `activeId` is whichever one the composer/pickers are
// currently bound to. Backend/model default to whatever the last-created tab
// used, purely to seed new tabs — see createSession().
let sessions = [];
let activeId = null;
let sessionSeq = 0;
let defaultBackend = "web";

const activeSession = () => sessions.find((s) => s.id === activeId);
const isCode = (session) => session.backend === "code";

function makeSession() {
  const messagesEl = document.createElement("main");
  messagesEl.className = "messages";
  messagesEl.setAttribute("aria-live", "polite");
  messagesEl.hidden = true;
  els.messagesContainer.appendChild(messagesEl);
  return {
    id: `s${++sessionSeq}`,
    title: "New chat",
    backend: defaultBackend,
    webModel: null,
    codeModel: null,
    codeCwd: null, // code: null means "use the server's default directory"
    convUuid: null, // web: created lazily on first send
    parentMessageUuid: null, // web: links each turn to the prior assistant message
    codeSessionId: null, // code: null until the sidecar assigns one
    streaming: false,
    abortController: null,
    // Turns submitted while one is already streaming wait here instead of
    // being rejected — the composer stays live and each queued bubble renders
    // right away, then runs in order as the active turn finishes.
    pendingQueue: [],
    inputValue: "", // draft text, restored when switching back to this tab
    messagesEl
  };
}

// Entry point for both "spawn a fresh tab at boot" and the header's + button.
// New tabs clone the backend/model of whichever tab was active, since a new
// chat is usually meant to run alongside the one you're already in.
//
// codeCwd is deliberately NOT cloned and never restored from storage. A working
// directory is a property of one piece of work, not a preference: inheriting it
// means a new tab silently points at whatever directory the last one happened
// to use, and the difference only shows up after the agent has already acted
// there. Every new tab starts at the server default, visible in the header
// tooltip and the empty-state line.
async function createSession(cloneFrom) {
  const session = makeSession();
  if (cloneFrom) {
    session.backend = cloneFrom.backend;
    session.webModel = cloneFrom.webModel;
    session.codeModel = cloneFrom.codeModel;
  }
  sessions.push(session);
  activeId = session.id;
  renderTabs();
  await enterSession(session);
  els.input.focus();
  return session;
}

async function switchToSession(id) {
  if (id === activeId) return;
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  activeId = id;
  renderTabs();
  await enterSession(session);
}

async function closeSession(id) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const session = sessions[idx];
  if (session.streaming) stopStreaming(session);
  session.messagesEl.remove();
  sessions.splice(idx, 1);

  if (sessions.length === 0) {
    await createSession();
    return;
  }
  if (activeId === id) {
    const next = sessions[Math.min(idx, sessions.length - 1)];
    activeId = next.id;
    renderTabs();
    await enterSession(next);
  } else {
    renderTabs();
  }
}

// Flashes in the header whenever any session — active or backgrounded — has a
// turn in flight, so "is Claude still working" is answerable at a glance
// without checking each tab.
function updateStatusDot() {
  const working = sessions.some((s) => s.streaming);
  els.statusDot.classList.toggle("on", working);
  els.statusDot.title = working ? "Claude is working…" : "";
}

function renderTabs() {
  updateStatusDot();
  els.tabBar.replaceChildren();
  // A single tab is the common case; the bar only earns its keep once there's
  // something to switch between.
  if (sessions.length < 2) return;
  for (const session of sessions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab" + (session.id === activeId ? " active" : "") + (session.streaming ? " streaming" : "");
    btn.title = session.title;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(session.id === activeId));

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = session.title;
    btn.appendChild(label);

    const closeBtn = document.createElement("span");
    closeBtn.className = "tab-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Close chat";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(session.id);
    });
    btn.appendChild(closeBtn);

    btn.addEventListener("click", () => switchToSession(session.id));
    els.tabBar.appendChild(btn);
  }
}

// The tab label starts as "New chat" and locks in on the first message sent.
function updateTabTitle(session, text) {
  if (session.title !== "New chat" || !text) return;
  session.title = text.length > 28 ? text.slice(0, 28) + "…" : text;
  renderTabs();
}

function resetSessionConversation(session) {
  session.convUuid = null;
  session.parentMessageUuid = null;
  session.codeSessionId = null;
}

// ==========================================================================
// Minimize / restore
// ==========================================================================
// Chrome exposes no way for an extension to collapse or shrink its own side
// panel — the panel is browser UI, and setOptions/open are the only levers. So
// "minimize" is close-and-remember: park every open chat, close the panel, and
// rehydrate on the next open. From the user's side that is the difference they
// actually care about, and the × button stays a real close that discards.
//
// The snapshot lives in chrome.storage.session on purpose. Parked chats should
// outlive the panel and a service-worker eviction, but not the browser: a code
// session id only resumes while its transcript is on disk, and a month-old
// transcript reappearing in a fresh window is a bug, not a feature.
const PARKED_KEY = "panel_parked_v1";

// Transcripts are stored as rendered HTML. The message DOM carries no JS
// listeners — tool chips are native <details> — so innerHTML round-trips it
// exactly, and re-deriving it would mean keeping a second event log purely to
// replay through the same renderer.
function appendNotice(session, text) {
  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = text;
  session.messagesEl.appendChild(div);
}

function snapshotOf(session) {
  // A turn aborted mid-stream never runs finish(), so its blinking caret is
  // still in the DOM. Drop it — restored, it would claim Claude is still typing.
  for (const caret of session.messagesEl.querySelectorAll(".cursor")) caret.remove();
  return {
    id: session.id,
    title: session.title,
    backend: session.backend,
    webModel: session.webModel,
    codeModel: session.codeModel,
    codeCwd: session.codeCwd,
    convUuid: session.convUuid,
    parentMessageUuid: session.parentMessageUuid,
    codeSessionId: session.codeSessionId,
    inputValue: session.inputValue,
    html: session.messagesEl.innerHTML
  };
}

// A turn in flight cannot be parked: the request lives in this document and
// dies with it. Stop it and say so in the transcript rather than restoring a
// chat with a half-written answer and no way to tell it was cut off. Code
// sessions keep their context either way — the session id resumes.
async function parkSessions() {
  for (const session of sessions) {
    if (!session.streaming) continue;
    stopStreaming(session);
    clearQueue(session);
    appendNotice(session, "Turn stopped — the panel was minimized.");
  }
  await chrome.storage.session.set({
    [PARKED_KEY]: {
      activeId,
      sessionSeq,
      defaultBackend,
      sessions: sessions.map(snapshotOf)
    }
  });
  await paintParkedBadge(sessions.length);
}

async function clearParked() {
  await chrome.storage.session.remove(PARKED_KEY);
  await paintParkedBadge(0);
}

// Restores the parked tabs and returns true, or returns false so boot falls
// through to a fresh session. Anything malformed is treated as "nothing
// parked": a bad snapshot must not be able to wedge the panel shut.
async function restoreParked() {
  let parked;
  try {
    parked = (await chrome.storage.session.get(PARKED_KEY))[PARKED_KEY];
  } catch {
    return false;
  }
  if (!parked || !Array.isArray(parked.sessions) || parked.sessions.length === 0) return false;

  sessionSeq = parked.sessionSeq || parked.sessions.length;
  if (parked.defaultBackend === "code" || parked.defaultBackend === "web") {
    defaultBackend = parked.defaultBackend;
  }
  for (const snap of parked.sessions) {
    const session = makeSession();
    Object.assign(session, {
      id: snap.id || session.id,
      title: snap.title || "New chat",
      backend: snap.backend === "code" ? "code" : "web",
      webModel: snap.webModel ?? null,
      codeModel: snap.codeModel ?? null,
      codeCwd: snap.codeCwd ?? null,
      convUuid: snap.convUuid ?? null,
      parentMessageUuid: snap.parentMessageUuid ?? null,
      codeSessionId: snap.codeSessionId ?? null,
      inputValue: snap.inputValue || ""
    });
    session.messagesEl.innerHTML = snap.html || "";
    sessions.push(session);
  }
  activeId = sessions.some((s) => s.id === parked.activeId) ? parked.activeId : sessions[0].id;
  renderTabs();
  await enterSession(activeSession());
  // Consumed: from here the live `sessions` array is the truth, and leaving the
  // snapshot behind would resurrect these tabs after a real close.
  await clearParked();
  return true;
}

// The toolbar icon is the only way back into a minimized panel, so it has to
// say that something is waiting there.
async function paintParkedBadge(count) {
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    if (count > 0) await chrome.action.setBadgeBackgroundColor({ color: "#c96442" });
  } catch {
    // Badge is decoration; never let it break minimize.
  }
}

// ==========================================================================
// Theme (light/dark)
// ==========================================================================
// Dark is the default. A persisted explicit choice (from the header toggle)
// overrides that default (see panel.css); no stored value → dark.
const THEME_KEY = "panel_theme";
const DEFAULT_THEME = "dark";

function paintTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === "dark";
  els.themeToggle.textContent = isDark ? "☀" : "☽"; // sun / crescent moon
  els.themeToggle.title = isDark ? "Switch to light theme" : "Switch to dark theme";
}

async function initTheme() {
  const saved = await store.get(THEME_KEY);
  paintTheme(saved === "light" || saved === "dark" ? saved : DEFAULT_THEME);
}

async function toggleTheme() {
  const current = document.documentElement.dataset.theme || DEFAULT_THEME;
  const next = current === "dark" ? "light" : "dark";
  await store.set(THEME_KEY, next);
  paintTheme(next);
}

// ==========================================================================
// Backend + model pickers
// ==========================================================================
// These are shared widgets that always reflect the active session; switching
// tabs repaints them (see enterSession), and edits here only affect that tab.
async function initBackendPicker() {
  const saved = await store.get("panel_backend");
  defaultBackend = saved === "code" ? "code" : "web";

  els.backend.addEventListener("change", async () => {
    const session = activeSession();
    if (session.streaming) stopStreaming(session);
    session.backend = els.backend.value;
    defaultBackend = session.backend;
    await store.set("panel_backend", defaultBackend);
    // Switching backends mid-tab starts that tab's chat over — web and code
    // are different threads entirely, there's no shared context to carry.
    resetSessionConversation(session);
    session.messagesEl.replaceChildren();
    session.title = "New chat";
    renderTabs();
    await enterSession(session);
  });
}

// Model lists are per backend: claude.ai model ids and Claude Code aliases are
// different namespaces, so each is persisted under its own storage key and
// each session remembers its own choice per backend.
async function populateModelsFor(session) {
  const list = isCode(session) ? CODE_MODELS : MODELS;
  const key = isCode(session) ? "code_model" : "claude_model";
  els.model.replaceChildren();
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id ?? "";
    opt.textContent = m.label;
    els.model.appendChild(opt);
  }
  let value = isCode(session) ? session.codeModel : session.webModel;
  if (value === null) value = await store.get(key); // brand-new tab: fall back to last global default
  if (value !== undefined && [...els.model.options].some((o) => o.value === value)) {
    els.model.value = value;
  }
  if (isCode(session)) session.codeModel = els.model.value;
  else session.webModel = els.model.value;
}

els.model.addEventListener("change", () => {
  const session = activeSession();
  if (isCode(session)) session.codeModel = els.model.value;
  else session.webModel = els.model.value;
  store.set(isCode(session) ? "code_model" : "claude_model", els.model.value);
});

function selectedModel(session) {
  const m = isCode(session) ? session.codeModel : session.webModel;
  return m || null; // "" → null → backend default
}

// ==========================================================================
// Working directory (Code backend only)
// ==========================================================================
// Per-tab and per-session: each session sends its own `codeCwd` with every turn
// (see streamCode), so switching directory in one tab never affects another and
// nothing is written to storage — closing the panel forgets the choice, and the
// next tab starts at the server default rather than somewhere inherited.
function refreshCwdButton(session, health) {
  const shown = session.codeCwd || health?.cwd || "(server default)";
  els.cwdBtn.title = `Working directory: ${shown}\nClick to change · Option/Alt-click to reset to server default`;
}

// Repaints whatever depends on the directory: the button tooltip and, if it's
// still showing, the empty-hint line that names the directory.
async function applyCwd(session) {
  const health = await codeClient.health();
  refreshCwdButton(session, health);
  if (session.messagesEl.querySelector(".empty-hint")) {
    clearEmptyHint(session);
    showEmptyHint(session, health);
  }
}

async function changeCwd(session) {
  let path;
  try {
    // Opens a native folder picker on the sidecar's machine, not a browser
    // dialog — the browser sandbox can't hand back a real filesystem path.
    path = await codeClient.browseDirectory(session.codeCwd);
  } catch (e) {
    showServerDown(e.message);
    return;
  }
  if (!path) return; // cancelled
  session.codeCwd = path;
  await applyCwd(session);
}

async function resetCwd(session) {
  session.codeCwd = null;
  await applyCwd(session);
}

els.cwdBtn.addEventListener("click", (e) => {
  const session = activeSession();
  if (e.altKey) resetCwd(session);
  else changeCwd(session);
});

// Switch the whole UI to a session: pickers, visible message DOM, composer
// draft/state, palette, and (for code) a health check that decides whether
// the composer is usable. Called when a tab is created or switched to.
async function enterSession(session) {
  hideSignedOut();
  hideServerDown();
  closeSlashMenu();
  await populateModelsFor(session);
  els.backend.value = session.backend;
  for (const s of sessions) s.messagesEl.hidden = s !== session;
  els.input.value = session.inputValue;
  autoGrow();
  refreshComposerButton(session);

  els.cwdBtn.hidden = !isCode(session);

  if (!isCode(session)) {
    els.palette.hidden = true;
    els.palette.replaceChildren();
    showEmptyHint(session);
    setComposerEnabled(true);
    return;
  }

  const health = await codeClient.health();
  if (!health.ok) {
    showServerDown(health.error);
    setComposerEnabled(false);
    return;
  }
  setComposerEnabled(true);
  refreshCwdButton(session, health);
  showEmptyHint(session, health);
  try {
    await loadPalette();
  } catch (e) {
    showServerDown(e.message);
    setComposerEnabled(false);
  }
}

// ==========================================================================
// Command palette (Code backend only)
// ==========================================================================
async function loadPalette() {
  els.palette.replaceChildren();
  let commands = [];
  try {
    commands = await codeClient.commands();
  } catch (e) {
    els.palette.hidden = true;
    // A missing token is worth surfacing now — otherwise the first message is
    // wasted discovering it. Anything else is non-fatal; the composer works.
    if (e instanceof ServerUnavailableError) throw e;
    return;
  }
  for (const cmd of commands) {
    const btn = document.createElement("button");
    btn.className = "palette-btn";
    btn.type = "button";
    btn.textContent = cmd.label || cmd.id;
    if (cmd.prompt) btn.title = cmd.prompt;
    btn.addEventListener("click", () => submitTurn(activeSession(), { command: cmd.id, label: cmd.label || cmd.id }));
    els.palette.appendChild(btn);
  }
  els.palette.hidden = commands.length === 0;
}

// ==========================================================================
// Slash commands (Code backend only)
// ==========================================================================
// The composer sends whatever the user typed straight to `claude -p`, and the
// CLI dispatches a leading slash command itself — so support here is entirely a
// discovery problem, not an execution one. This is the discovery half: a menu
// over the commands that session can actually run.
//
// The list comes from the CLI (GET /slash-commands, which reads the init event),
// so it covers builtins, bundled skills, and the user's and project's own
// commands, and it excludes the REPL-only ones — the panel never offers a
// command that would answer "isn't available in this environment".
//
// Cached per working directory, since that is what the answer depends on. Turn
// init events refresh it for free (see handleCodeEvent), so a command file added
// mid-session shows up after the next turn without another probe.
const slashCache = new Map(); // cwd key -> [{name, skill, description}]
// Stands in for "the server's default directory" as a cache key. Not a path,
// and cannot collide with one, since every real cwd is absolute.
const CWD_DEFAULT = "(default)";

// Plumbing the CLI exposes but nobody types. Mirrors _SLASH_HIDDEN in
// server/app.py, so the init-event refresh below cannot reintroduce what the
// probe filtered out.
const SLASH_HIDDEN = new Set(["__remote-workflow", "workflow-launch-exec"]);

let slashItems = []; // what the menu is currently showing
let slashIndex = 0; // keyboard selection within it

const cwdKey = (session) => session.codeCwd || CWD_DEFAULT;

// Only the command name is being typed while there is no whitespace yet. After
// the first space the user is writing arguments, and a menu would be in the way.
function slashPrefix() {
  const value = els.input.value;
  const m = /^\/([^\s]*)$/.exec(value);
  return m ? m[1] : null;
}

async function loadSlashCommands(session) {
  const key = cwdKey(session);
  if (slashCache.has(key)) return slashCache.get(key);
  // Cache the promise, not just the result: the probe takes a couple of seconds
  // and a fast typist can trigger several before the first returns.
  const pending = codeClient
    .slashCommands(session.codeCwd)
    .catch(() => []) // autocomplete is a convenience; typing still works
    .then((list) => {
      slashCache.set(key, list);
      return list;
    });
  slashCache.set(key, pending);
  return pending;
}

// Fold a turn's init event into the cache. The init event names commands but
// carries no descriptions, so descriptions already known from the probe are kept
// for names that survive.
function noteSlashCommands(session, names, skills) {
  const key = cwdKey(session);
  const known = slashCache.get(key);
  const byName = new Map(
    (Array.isArray(known) ? known : []).map((c) => [c.name, c])
  );
  const skillSet = new Set(skills);
  slashCache.set(
    key,
    names
      .filter((n) => !n.startsWith("__") && !SLASH_HIDDEN.has(n))
      .sort()
      .map((name) => ({
        name,
        skill: skillSet.has(name),
        description: byName.get(name)?.description ?? null
      }))
  );
}

function closeSlashMenu() {
  els.slashMenu.hidden = true;
  els.slashMenu.replaceChildren();
  slashItems = [];
  slashIndex = 0;
}

function renderSlashMenu() {
  els.slashMenu.replaceChildren();
  if (slashItems.length === 0) {
    const p = document.createElement("div");
    p.className = "slash-empty";
    p.textContent = "No matching command";
    els.slashMenu.appendChild(p);
    els.slashMenu.hidden = false;
    return;
  }
  slashItems.forEach((cmd, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-item" + (i === slashIndex ? " sel" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(i === slashIndex));

    const name = document.createElement("span");
    name.className = "slash-name";
    name.textContent = `/${cmd.name}`;
    btn.appendChild(name);

    if (cmd.description) {
      const desc = document.createElement("span");
      desc.className = "slash-desc";
      desc.textContent = cmd.description;
      btn.appendChild(desc);
    }
    if (cmd.skill) {
      const tag = document.createElement("span");
      tag.className = "slash-tag";
      tag.textContent = "skill";
      btn.appendChild(tag);
    }

    // mousedown, not click: the textarea loses focus first on click, and the
    // blur handler would have already closed the menu.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptSlash(i);
    });
    els.slashMenu.appendChild(btn);
  });
  els.slashMenu.hidden = false;
  els.slashMenu.children[slashIndex]?.scrollIntoView({ block: "nearest" });
}

// Fills the name in and leaves a trailing space, so arguments can be typed
// straight away and the menu closes because the prefix no longer matches.
function acceptSlash(i) {
  const cmd = slashItems[i];
  if (!cmd) return;
  els.input.value = `/${cmd.name} `;
  activeSession().inputValue = els.input.value;
  closeSlashMenu();
  autoGrow();
  els.input.focus();
}

function moveSlashSelection(delta) {
  if (slashItems.length === 0) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashMenu();
}

async function refreshSlashMenu() {
  const session = activeSession();
  if (!session || !isCode(session)) return closeSlashMenu();
  const prefix = slashPrefix();
  if (prefix === null) return closeSlashMenu();

  const all = await loadSlashCommands(session);
  // The composer may have moved on while the first probe was in flight.
  const current = slashPrefix();
  if (current === null || activeSession() !== session) return;

  const lower = current.toLowerCase();
  slashItems = all.filter((c) => c.name.toLowerCase().startsWith(lower));
  // Nothing typed after the slash yet, or the filter changed: start at the top
  // rather than keeping an index that now points somewhere unrelated.
  slashIndex = 0;
  renderSlashMenu();
}

// ==========================================================================
// Chat rendering
// ==========================================================================
function clearEmptyHint(session) {
  const hint = session.messagesEl.querySelector(".empty-hint");
  if (hint) hint.remove();
}

function showEmptyHint(session, health) {
  if (session.messagesEl.children.length) return;
  const p = document.createElement("p");
  p.className = "empty-hint";
  if (isCode(session)) {
    const tools = health?.allowed_tools?.length ? ` Tools: ${health.allowed_tools.join(", ")}.` : "";
    const cwd = session.codeCwd || health?.cwd || "the server's directory";
    p.textContent = `Ask Claude Code. Runs in ${cwd}.${tools}`;
  } else {
    p.textContent = "Ask Claude anything. This chat uses your claude.ai session.";
  }
  session.messagesEl.appendChild(p);
}

function addBubble(session, role, text) {
  clearEmptyHint(session);
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  session.messagesEl.appendChild(div);
  scrollToBottom(session);
  return div;
}

function scrollToBottom(session) {
  session.messagesEl.scrollTop = session.messagesEl.scrollHeight;
}

// One assistant turn. Text and tool calls interleave in the order they arrive,
// so the turn is a container that opens a fresh text bubble after each tool
// rather than a single bubble that gets rewritten.
//
// Text is appended to a Text node instead of reassigning textContent, which the
// previous version did on every token — that re-rendered the whole message per
// delta and got slower as the answer grew.
function startTurn(session) {
  clearEmptyHint(session);
  const turn = document.createElement("div");
  turn.className = "turn";
  session.messagesEl.appendChild(turn);

  const caret = document.createElement("span");
  caret.className = "cursor";
  caret.textContent = "▋";

  let textEl = null;
  let textNode = null;
  let textRaw = ""; // markdown source, rendered when the bubble closes
  const chips = new Map(); // tool_use id -> <details>
  let anyText = false;

  function openTextBubble() {
    textEl = document.createElement("div");
    textEl.className = "msg assistant";
    textNode = document.createTextNode("");
    textRaw = "";
    textEl.appendChild(textNode);
    textEl.appendChild(caret);
    turn.appendChild(textEl);
  }

  function closeTextBubble() {
    if (!textEl) return;
    caret.remove();
    if (!textNode.data) {
      textEl.remove(); // never leave an empty bubble behind
    } else {
      // Markdown is rendered once, when the bubble is complete — not per token.
      // Re-parsing on every delta would be O(n²) over the message and would
      // flicker through half-written syntax (an unclosed ** or code fence).
      textEl.replaceChildren(renderMarkdown(textRaw));
      textEl.classList.add("md");
    }
    textEl = null;
    textNode = null;
    textRaw = "";
  }

  return {
    appendText(chunk) {
      if (!chunk) return;
      if (!textEl) openTextBubble();
      textNode.appendData(chunk);
      textRaw += chunk;
      anyText = true;
      scrollToBottom(session);
    },

    addTool(id, name) {
      if (chips.has(id)) return;
      closeTextBubble();
      const chip = document.createElement("details");
      chip.className = "tool-chip running";
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.className = "tool-name";
      // mcp__browse__read_page is unreadable in a 300px panel; keep the full
      // name in the tooltip.
      label.textContent = (name || "tool").replace(/^mcp__[^_]+__/, "");
      label.title = name || "";
      const status = document.createElement("span");
      status.className = "tool-status";
      status.textContent = "running…";
      summary.append(label, status);
      chip.appendChild(summary);
      turn.appendChild(chip);
      chips.set(id, chip);
      scrollToBottom(session);
    },

    setToolInput(id, name, input) {
      if (!chips.has(id)) this.addTool(id, name);
      const chip = chips.get(id);
      if (chip.querySelector(".tool-args")) return;
      const pre = document.createElement("pre");
      pre.className = "tool-args";
      pre.textContent = JSON.stringify(input ?? {}, null, 2);
      chip.appendChild(pre);
    },

    setToolResult(id, { is_error, text }) {
      const chip = chips.get(id);
      if (!chip) return;
      chip.classList.remove("running");
      chip.classList.toggle("failed", !!is_error);
      const status = chip.querySelector(".tool-status");
      if (status) status.textContent = is_error ? "failed" : "done";
      const pre = document.createElement("pre");
      pre.className = "observation";
      // Tool output can be a whole file; the chip is collapsed by default, but
      // cap it so expanding one doesn't lock up the panel.
      const body = text || "(no output)";
      pre.textContent = body.length > 8000 ? body.slice(0, 8000) + "\n… (truncated)" : body;
      chip.appendChild(pre);
      scrollToBottom(session);
    },

    addNotice(text) {
      closeTextBubble();
      const div = document.createElement("div");
      div.className = "notice";
      div.textContent = text;
      turn.appendChild(div);
    },

    // Close out the turn. `fallback` is shown only if nothing was ever rendered.
    finish(fallback) {
      closeTextBubble();
      caret.remove();
      if (!anyText && !chips.size && fallback) {
        const div = document.createElement("div");
        div.className = "msg assistant";
        div.textContent = fallback;
        turn.appendChild(div);
      }
      if (!turn.childNodes.length) turn.remove();
      scrollToBottom(session);
    },

    remove() {
      turn.remove();
    },

    get isEmpty() {
      return !anyText && !chips.size;
    }
  };
}

// ==========================================================================
// Send / stream
// ==========================================================================
function setComposerEnabled(on) {
  els.input.disabled = !on;
  els.send.disabled = !on;
}

// Paints the composer's send/stop button and the backend picker's disabled
// state from `session`'s streaming flag. Only call this when `session` is the
// active tab — a background tab's streaming state shows on its tab chip
// instead (see renderTabs), not on the shared composer.
function refreshComposerButton(session) {
  const on = session.streaming;
  els.send.textContent = on ? "■" : "↑";
  els.send.title = on ? "Stop" : "Send";
  els.send.classList.toggle("stopping", on);
  els.backend.disabled = on;
}

function stopStreaming(session) {
  if (session.abortController) session.abortController.abort();
  if (isCode(session) && session.codeSessionId) codeClient.interrupt(session.codeSessionId);
}

function clearQueue(session) {
  session.pendingQueue = [];
}

// Called when the active turn hits a blocking error (signed out, server
// down): anything still queued behind it would only fail the same way, so
// drop it and mark it rather than let it retry silently against a session
// that needs the user to act first.
function dropQueue(session, hint) {
  for (const item of session.pendingQueue) {
    item.bubble?.classList.remove("queued");
    item.bubble?.classList.add("dropped");
    if (item.bubble) item.bubble.title = `Not sent — ${hint}`;
  }
  session.pendingQueue = [];
}

function onSendClick() {
  const session = activeSession();
  // Empty box + streaming = the button is showing "Stop"; text present means
  // the click is a send (queued if a turn is already in flight).
  if (session.streaming && !els.input.value.trim()) stopStreaming(session);
  else submitTurn(session, {});
}

// Entry point for both the composer and palette buttons. A turn is either
// free-form text or a palette command. If nothing is streaming for `session`
// it runs right away; otherwise it's queued and runs when the current turn
// finishes. `session` is captured at submit time, so a turn keeps rendering
// into the right tab even if the user switches away before it completes.
function submitTurn(session, { command, label }) {
  const text = els.input.value.trim();
  if (!command && !text) return;

  if (!command) {
    els.input.value = "";
    session.inputValue = "";
    autoGrow();
  }
  const bubble = addBubble(session, "user", command ? `▸ ${label}` : text);
  updateTabTitle(session, text || label);

  if (session.streaming) {
    bubble.classList.add("queued");
    session.pendingQueue.push({ command, label, text, bubble });
    return;
  }
  executeTurn(session, { command, label, text, bubble });
}

async function executeTurn(session, { command, label, text, bubble }) {
  bubble?.classList.remove("queued");
  session.streaming = true;
  session.abortController = new AbortController();
  if (session === activeSession()) refreshComposerButton(session);
  renderTabs();
  const turn = startTurn(session);

  try {
    if (isCode(session)) {
      await streamCode(session, { prompt: text, command, turn });
    } else {
      await streamWeb(session, { prompt: text, turn });
    }
  } catch (e) {
    const active = session === activeSession();
    if (e?.name === "AbortError") {
      turn.finish("(stopped)");
    } else if (e instanceof AuthError) {
      turn.remove();
      dropQueue(session, "sign in, then resend.");
      if (active) showSignedOut(e.status);
      else addBubble(session, "error", "Signed out of claude.ai — sign in, then resend.");
    } else if (e instanceof ServerUnavailableError) {
      turn.remove();
      dropQueue(session, "retry the server, then resend.");
      if (active) showServerDown(e.message);
      else addBubble(session, "error", e.message || "Claude Code server unavailable.");
    } else {
      turn.finish();
      addBubble(session, "error", e.message || "Something went wrong.");
    }
  } finally {
    session.abortController = null;
    session.streaming = false;
    if (session === activeSession()) {
      refreshComposerButton(session);
      if (!els.input.disabled) els.input.focus();
    }
    renderTabs();
    const next = session.pendingQueue.shift();
    if (next) executeTurn(session, next);
  }
}

async function streamWeb(session, { prompt, turn }) {
  if (!session.convUuid) session.convUuid = await webClient.createConversation();
  const result = await webClient.sendMessage(
    {
      convUuid: session.convUuid,
      prompt,
      model: selectedModel(session),
      parentMessageUuid: session.parentMessageUuid,
      signal: session.abortController.signal
    },
    (chunk) => turn.appendText(chunk)
  );
  turn.finish("(no response)");
  // Thread the next turn onto this assistant message (captured from the SSE
  // message_start), so the server keeps conversation context.
  session.parentMessageUuid = result?.messageUuid || null;
}

async function streamCode(session, { prompt, command, turn }) {
  const done = await codeClient.sendMessage(
    {
      prompt,
      command,
      model: selectedModel(session),
      sessionId: session.codeSessionId,
      cwd: session.codeCwd,
      signal: session.abortController.signal
    },
    (ev) => handleCodeEvent(session, ev, turn)
  );
  if (done?.t === "done" && done.is_error) {
    turn.finish();
    addBubble(session, "error", done.result || "Claude Code reported an error.");
    return;
  }
  turn.finish("(no response)");
}

function handleCodeEvent(session, ev, turn) {
  switch (ev.t) {
    case "accepted":
      // Captured before any output so Stop has something to interrupt.
      session.codeSessionId = ev.session_id;
      break;
    case "init":
      // The CLI reports its command list on every turn. Free refresh: a command
      // file added mid-session is offered from the next turn onward, and the
      // descriptions already cached for it are kept.
      if (Array.isArray(ev.slash_commands) && ev.slash_commands.length) {
        noteSlashCommands(session, ev.slash_commands, ev.skills || []);
      }
      break;
    case "text":
      turn.appendText(ev.text);
      break;
    case "tool":
      turn.addTool(ev.id, ev.name);
      break;
    case "tool_input":
      if (ev.nested) break; // subagent internals, not this transcript
      for (const t of ev.tools) turn.setToolInput(t.id, t.name, t.input);
      break;
    case "tool_result":
      if (ev.nested) break;
      for (const r of ev.results) turn.setToolResult(r.id, r);
      break;
    case "notice":
      turn.addNotice(ev.text);
      break;
    case "error":
      turn.addNotice(ev.text);
      break;
    default:
      break; // init/done are handled by the caller
  }
}

// ==========================================================================
// Signed-out (web) and server-down (code) states
// ==========================================================================
function showSignedOut(status) {
  els.signedOutMsg.textContent =
    status === 403
      ? "Your claude.ai session needs a refresh. Open claude.ai in a tab, then try again."
      : "Sign in to claude.ai to use this panel.";
  els.signedOut.hidden = false;
}

function hideSignedOut() {
  els.signedOut.hidden = true;
}

function showServerDown(detail) {
  els.serverDownMsg.textContent = detail || "The local Claude Code server isn't running.";
  els.serverDown.hidden = false;
}

function hideServerDown() {
  els.serverDown.hidden = true;
}

els.signInBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: CONFIG.loginUrl });
});

els.retryServer.addEventListener("click", async () => {
  // Only used when the server has bootstrap disabled; otherwise the field is
  // left blank and the panel fetches the token itself.
  const pasted = els.tokenInput.value.trim();
  if (pasted) {
    await codeClient.setToken(pasted);
    els.tokenInput.value = "";
  }
  hideServerDown();
  await enterSession(activeSession());
});

// ==========================================================================
// Recorder button — messages the service worker; all logic lives there.
// ==========================================================================
function paintRecState(state) {
  els.recState.textContent = state;
  els.recState.className = `rec-state ${state}`;
  els.recBtn.textContent = state === "recording" ? "Stop recording" : "Record";
  els.recBtn.disabled = state === "working"; // a transition is in flight
}

async function toggleRecorder() {
  paintRecState("working"); // optimistic; SW confirms via response + broadcast
  try {
    const res = await chrome.runtime.sendMessage({ __ocic: "recorder_toggle" });
    if (res && res.state) paintRecState(res.state);
  } catch {
    // SW asleep/unreachable — resync from authoritative state.
    syncRecState();
  }
}

async function syncRecState() {
  try {
    const res = await chrome.runtime.sendMessage({ __ocic: "recorder_state_get" });
    if (res && res.state) paintRecState(res.state);
  } catch {
    paintRecState("idle");
  }
}

// Live updates broadcast from the SW at each recorder transition. Also the
// inbound half of the dev probe (see runProbeOps).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.__ocic === "recorder_state" && msg.state) paintRecState(msg.state);
  if (msg && msg.__ocic === "panel_probe") {
    sendResponse(runProbeOps(msg.ops || []));
    return true;
  }
});

// Backstop: if the SW is evicted mid-recording, the broadcast is lost, but the
// state it rehydrates from (recorder_state_v1 in session storage) still changes
// — mirror it so the panel survives eviction while open.
chrome.storage.session.onChanged.addListener((changes) => {
  const c = changes["recorder_state_v1"];
  if (c && c.newValue) paintRecState(c.newValue.active ? "recording" : "idle");
});

// ==========================================================================
// Dev probe — reached only from background.js's __panel_probe dev handler
// ==========================================================================
// Test-only, and it lives here because it has to: the panel is an extension
// page, so CDP cannot attach to it and chrome.scripting refuses to inject into
// it. Runtime messaging is the only way in, which means the receiving end must
// ship with the panel.
//
// Ops are a fixed vocabulary rather than evaluated code — the extension CSP
// blocks new Function/eval on extension pages anyway, and a fixed vocabulary
// cannot be turned into an arbitrary-code channel by a page that manages to
// send this message.
function runProbeOps(ops) {
  const q = (sel) => document.querySelector(sel);
  return ops.map((op) => {
    try {
      if (op.count !== undefined) return document.querySelectorAll(op.count).length;
      if (op.exists !== undefined) return !!q(op.exists);
      if (op.text !== undefined) return q(op.text)?.textContent ?? null;
      if (op.html !== undefined) return q(op.html)?.innerHTML ?? null;
      if (op.value !== undefined) return q(op.value)?.value ?? null;
      if (op.sessions !== undefined) {
        return { count: sessions.length, activeId, titles: sessions.map((s) => s.title) };
      }
      if (op.click !== undefined) {
        const el = q(op.click);
        if (!el) return `no element: ${op.click}`;
        el.click();
        return "clicked";
      }
      if (op.setInput !== undefined) {
        const [sel, val] = op.setInput;
        const el = q(sel);
        if (!el) return `no element: ${sel}`;
        el.value = val;
        // The draft is recorded on "input", not on assignment.
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "set";
      }
      if (op.setSelect !== undefined) {
        const [sel, val] = op.setSelect;
        const el = q(sel);
        if (!el) return `no element: ${sel}`;
        el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "selected";
      }
      if (op.key !== undefined) {
        // A real keydown, so the composer's own handler decides what it means —
        // testing the menu's key handling by calling its functions directly
        // would skip the part most likely to be wrong.
        const [sel, key] = op.key;
        const el = q(sel);
        if (!el) return `no element: ${sel}`;
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        return "keyed";
      }
      if (op.classOf !== undefined) return q(op.classOf)?.className ?? null;
      if (op.textsOf !== undefined) return [...document.querySelectorAll(op.textsOf)].map((e) => e.textContent);
      if (op.appendMessage !== undefined) {
        const session = activeSession();
        if (!session) return "no active session";
        addBubble(session, "user", op.appendMessage);
        return "appended";
      }
      return `unknown op: ${JSON.stringify(op)}`;
    } catch (e) {
      return `error: ${e.message}`;
    }
  });
}

// ==========================================================================
// Input UX
// ==========================================================================
function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

els.input.addEventListener("input", () => {
  autoGrow();
  activeSession().inputValue = els.input.value;
  refreshSlashMenu();
});
els.input.addEventListener("keydown", (e) => {
  // While the slash menu is open it owns these keys: Enter must complete the
  // command rather than send a half-typed one, and Escape must dismiss the menu
  // rather than do nothing.
  if (!els.slashMenu.hidden && slashItems.length > 0) {
    if (e.key === "ArrowDown") return e.preventDefault(), moveSlashSelection(1);
    if (e.key === "ArrowUp") return e.preventDefault(), moveSlashSelection(-1);
    if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), acceptSlash(slashIndex);
  }
  if (e.key === "Escape" && !els.slashMenu.hidden) {
    e.preventDefault();
    closeSlashMenu();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitTurn(activeSession(), {}); // queues automatically if a turn is already streaming
  }
});
// Leaving the composer should not leave a menu floating over the transcript.
// Deferred, because clicking an item blurs the textarea before mousedown lands.
els.input.addEventListener("blur", () => setTimeout(closeSlashMenu, 120));
els.send.addEventListener("click", onSendClick);
els.newChat.addEventListener("click", () => createSession(activeSession()));
els.themeToggle.addEventListener("click", toggleTheme);
els.minimize.addEventListener("click", async () => {
  await parkSessions();
  window.close();
});
// Close is the discarding one: drop any earlier snapshot so a close after a
// minimize doesn't reopen the chats the user just dismissed.
els.close.addEventListener("click", async () => {
  await clearParked();
  window.close();
});
els.recBtn.addEventListener("click", toggleRecorder);

// ==========================================================================
// Boot
// ==========================================================================
(async function init() {
  // The working directory used to be persisted here. Nothing reads it now, so
  // drop it rather than leaving a key that looks live to the next reader — and
  // so an already-stored path can't come back if that seeding is ever restored.
  chrome.storage.local.remove("code_cwd");
  await initTheme();
  await initBackendPicker();
  // Minimized chats come back first; only a panel with nothing parked opens on
  // a blank chat. initBackendPicker has to run before this, since restoring
  // sets defaultBackend from the snapshot and would otherwise be overwritten.
  if (!(await restoreParked())) await createSession();
  syncRecState();
})();
