// Background service worker for the Chrome Controller for Claude extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

// The api_* tools (capture, crawl, source mining, spec synthesis) live in their
// own file — it is a large subsystem, and keeping it separate lets its pure
// functions be unit-tested without a chrome mock. This is a classic script, not
// a module, so importScripts is the only way in, and apimap.js gets its
// dependencies injected below rather than reaching for globals declared here.
importScripts("apimap.js");

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.chrome_controller.claude_mcp";

// --- State ---
let nativePort = null;
// Tabs this session opened. Reading, screenshots and input work on ANY open
// tab; this set exists only to gate the one destructive operation, closing.
// Backed by chrome.storage.session so it survives service-worker eviction but
// not a browser restart — the same lifetime as the tabs it refers to.
let createdTabs = new Set();
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
const screenshotStore = new Map(); // imageId -> base64
// api_write round trips to the native host, which is the only thing in this
// system that can touch the filesystem. Keyed by request id, resolved when the
// api_written reply comes back — the same shape as recorder.pendingSaves.
const pendingApiWrites = new Map(); // id -> {resolve, reject}
let apiWriteSeq = 0;

let heartbeatTimer = null;

// switch_browser releases this browser's hold on the shared runtime by
// dropping the native port; this window keeps us from immediately re-grabbing
// it so a target browser (extension enabled) can become primary.
let suspendReconnectUntil = 0;
const SWITCH_RELEASE_MS = 15000;

async function detectBrowser() {
  try {
    if (navigator.brave && (await navigator.brave.isBrave?.())) return "Brave";
  } catch (e) {}
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "Edge";
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(" ");
  if (/Brave/i.test(brands)) return "Brave";
  if (/OPR\//.test(ua)) return "Opera";
  return "Chrome";
}

// --- Keep-alive alarm ---
// Backstop wake-up for the MV3 service worker. The proactive heartbeat
// inside connectNativeHost (~15s) is the primary mechanism; this alarm
// covers cases where the SW is fully evicted between heartbeats.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
function connectNativeHost() {
  if (nativePort) return;
  // Honor a switch_browser release window: stay disconnected so another
  // browser can take the primary connection, then resume.
  if (Date.now() < suspendReconnectUntil) {
    setTimeout(connectNativeHost, 500);
    return;
  }
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      // Heartbeat acks (and any other non-request server-originated messages)
      // are intentionally ignored here — only tool_request kicks work.
      if (msg.type === "tool_request" && msg.id) {
        handleToolRequest(msg.id, msg.tool, msg.args || {});
      } else if (msg.type === "api_written") {
        // Reply from the native host after writing an API bundle's files.
        const entry = pendingApiWrites.get(String(msg.id));
        if (entry) {
          pendingApiWrites.delete(String(msg.id));
          if (msg.ok) entry.resolve(msg);
          else entry.reject(new Error(msg.error || "api_write failed"));
        }
      } else if (msg.type === "recording_saved") {
        // Reply from the native host after writing a recording bundle to disk.
        const resolve = recorder.pendingSaves.get(String(msg.recording_id));
        if (resolve) {
          recorder.pendingSaves.delete(String(msg.recording_id));
          resolve(msg.ok ? msg.path : null);
        }
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      stopHeartbeat();
      // Retry quickly. Reconnect latency dominates per-call wall-clock when
      // the SW just slept; 250ms is the right floor — fast enough to be
      // invisible to a single tool call, slow enough not to busy-spin on a
      // genuinely dead host (which will be retried again on next alarm).
      setTimeout(connectNativeHost, 250);
    });

    startHeartbeat();
  } catch (e) {
    nativePort = null;
    stopHeartbeat();
    setTimeout(connectNativeHost, 250);
  }
}

// Proactive heartbeat: send a small message every ~15s while the native
// port is alive. Two effects:
//   1) The SW stays alive between alarm fires (postMessage resets the
//      ~30s idle timer Chrome uses to evict MV3 service workers).
//   2) The native-host TCP socket stays warm — no chance of Chrome
//      garbage-collecting the connection because it's been idle.
// 15s is well under both Chrome's SW idle timeout and the alarm period.
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!nativePort) return;
    try {
      nativePort.postMessage({ type: "heartbeat", t: Date.now() });
    } catch {
      // Port disconnected; the onDisconnect handler will reconnect.
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

// --- API bundle writes ---
//
// Write one or more files into custom_apis/<slug>/. The browser cannot write
// files at all, so this hands them to the native host and waits for the ack;
// the extension->host direction has no practical size cap, so a whole batch
// goes in one message.
function apiWrite(slug, files) {
  if (!nativePort) return Promise.reject(new Error("native host not connected"));
  const id = String(++apiWriteSeq);
  return new Promise((resolve, reject) => {
    // A write that never gets answered must not wedge the caller forever; the
    // tool call itself is capped at 60s upstream, so fail well inside that. The
    // timer is cleared on the reply, because a pending timer keeps the service
    // worker alive and a capture makes a great many of these.
    const timer = setTimeout(() => {
      if (pendingApiWrites.has(id)) {
        pendingApiWrites.delete(id);
        reject(new Error("timed out waiting for the native host to write the bundle"));
      }
    }, 30000);
    const settle = (fn) => (v) => {
      clearTimeout(timer);
      fn(v);
    };
    pendingApiWrites.set(id, { resolve: settle(resolve), reject: settle(reject) });
    try {
      nativePort.postMessage({ type: "api_write", id, slug, files });
    } catch (e) {
      pendingApiWrites.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// apimap.js is deliberately ignorant of this file: it gets what it needs handed
// to it, which is what makes it loadable (and testable) on its own.
self.ApiMap.init({
  cdp: (tabId, method, params) => cdp(tabId, method, params),
  ensureAttached: (tabId) => ensureAttached(tabId),
  ensureDomain: (tabId, domain) => ensureDomain(tabId, domain),
  apiWrite
});

// --- Tab targeting ---
//
// There is deliberately no ownership model. Earlier versions corralled tabs
// into a tab group titled "MCP" and gated every tool on membership, which
// meant a session could not see the tabs the user actually had open, and a
// stale group from a previous session would hijack the next one. Any open tab
// is now a valid target; the only genuinely destructive operation, closing, is
// limited to tabs we opened ourselves (see createdTabs / tabs_close_mcp).

const CREATED_TABS_KEY = "ocic_created_tabs";

async function loadCreatedTabs() {
  try {
    const stored = await chrome.storage.session.get(CREATED_TABS_KEY);
    const ids = stored && stored[CREATED_TABS_KEY];
    if (Array.isArray(ids)) createdTabs = new Set(ids);
  } catch {}
}

async function saveCreatedTabs() {
  try {
    await chrome.storage.session.set({ [CREATED_TABS_KEY]: Array.from(createdTabs) });
  } catch {}
}

async function markCreated(tabId) {
  await loadCreatedTabs();
  createdTabs.add(tabId);
  await saveCreatedTabs();
}

async function wasCreatedByUs(tabId) {
  await loadCreatedTabs();
  return createdTabs.has(tabId);
}

// Every tab we could drive, across all normal windows. Browser-internal pages
// are left out: CDP cannot attach to them, so offering them as targets would
// only produce failures further down.
async function listOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    return tabs.filter((t) => isDrivableUrl(t.url));
  } catch {
    return [];
  }
}

// The tab the user is working in. Window preference: last-focused, then
// current, then any normal window. Within a window: the active tab, or — when
// that is a page CDP cannot attach to, e.g. chrome://extensions right after a
// reload, or the new-tab page — the most recently viewed tab we CAN drive.
async function activeUserTab() {
  const scopes = [
    { lastFocusedWindow: true, windowType: "normal" },
    { currentWindow: true, windowType: "normal" },
    { windowType: "normal" }
  ];
  for (const scope of scopes) {
    let tabs;
    try {
      tabs = await chrome.tabs.query(scope);
    } catch {
      continue;
    }
    const drivable = tabs.filter((t) => isDrivableUrl(t.url));
    if (!drivable.length) continue;
    const active = drivable.find((t) => t.active);
    if (active) return active;
    // A real page beats an empty tab, then most-recently-viewed wins.
    // lastAccessed is Chrome 121+; where it is missing every value is
    // undefined and that half of the comparison is a no-op.
    return drivable.sort((a, b) => {
      const aBlank = BLANK_URL.test(a.url) ? 1 : 0;
      const bBlank = BLANK_URL.test(b.url) ? 1 : 0;
      if (aBlank !== bBlank) return aBlank - bBlank;
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    })[0];
  }
  return null;
}

const BLANK_URL = /^about:blank([?#].*)?$/i;

// CDP cannot attach to browser-internal pages. about:blank is the exception:
// it is an ordinary empty document, it is what a freshly created tab shows,
// and excluding it would hide the very tab tabs_create_mcp just opened.
function isDrivableUrl(url) {
  if (!url) return false;
  if (BLANK_URL.test(url)) return true;
  return !/^(chrome|chrome-untrusted|chrome-extension|edge|brave|opera|vivaldi|about|devtools|view-source):/i.test(
    url
  );
}

// The gate every automation tool runs before touching a tab. Returns an error
// string, or null when the tab is usable.
async function tabProblem(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return `Tab ${tabId} no longer exists. Call tabs_context_mcp for the current tab list.`;
  }
  if (!isDrivableUrl(tab.url)) {
    return `Tab ${tabId} is a browser-internal page (${tab.url}) and cannot be automated. Pick another tab from tabs_context_mcp.`;
  }
  return null;
}

function formatTabContext(tabs, currentTabId = null) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    windowId: t.windowId,
    title: t.title || "Untitled",
    url: t.url || "",
    openedByYou: createdTabs.has(t.id)
  }));

  let text = `Tab Context:\n- Open tabs you can use:\n`;
  for (const t of available) {
    const marks = [
      t.tabId === currentTabId ? "\u2190 the tab the user is viewing" : "",
      t.openedByYou ? "(you opened this one)" : ""
    ]
      .filter(Boolean)
      .join(" ");
    text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})${marks ? " " + marks : ""}\n`;
  }
  if (currentTabId !== null) {
    text += `- The user is looking at tabId ${currentTabId}. Work in that tab unless told otherwise.\n`;
  }

  return {
    content: [
      {
        type: "text",
        text:
          JSON.stringify({ availableTabs: available, currentTab: currentTabId }) +
          "\n\n" +
          text
      }
    ]
  };
}

// --- CDP helpers ---
// Chrome (and Chromium generally) throttle a non-visible tab: its compositor
// stops committing frames, so Input.dispatchMouseEvent to it stalls ~5s. We
// make a tab the active/selected tab of its window ONLY when it is created —
// that is the moment the tab we are about to drive must be foreground. We do
// NOT re-activate on every action, and we NEVER focus/raise the window (that
// would steal OS focus, which is disruptive when the browser is shared). If a
// tab is later backgrounded (e.g. the user selects another tab), its input
// pays the throttle cost until it is foreground again — an accepted tradeoff.
async function activateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.warn("activateTab:", e.message);
  }
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  // Force devicePixelRatio to 1 so screenshots match CSS coordinate space.
  // Without this, Retina displays produce 2x screenshots and all coordinates are wrong.
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: win.width,
    height: win.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

// A single CDP command must never hang a tool call to the 60s MCP timeout.
// On a heavy page mid-reflow, Page.captureScreenshot (and other commands) can
// block indefinitely; bound every command so a stuck one fails fast and
// surfaces as a tool error the agent can react to, instead of a silent stall.
const CDP_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    CDP_TIMEOUT_MS,
    `CDP ${method}`
  );
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (createdTabs.delete(tabId)) saveCreatedTabs();
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
});

// Handle user dismissing debugger bar
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
  // A capture on this tab just lost its network event stream. Let it re-arm.
  try { self.ApiMap.onDebuggerDetach(source.tabId); } catch (e) {}
});

// --- CDP event listeners for console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  // The api_capture session, if any, wants the full firehose — it correlates
  // requests by requestId and pulls bodies, which the coarse buffers below do
  // not. It is a no-op when no capture is running on this tab.
  self.ApiMap.onDebuggerEvent(tabId, method, params);

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.response.url,
      method: params.response.requestHeaders ? "?" : "GET",
      status: params.response.status,
      statusText: params.response.statusText,
      type: params.type || "Other",
      mimeType: params.response.mimeType,
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.request.url,
      method: params.request.method,
      status: 0,
      type: params.type || "Other",
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
});

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Retry
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId) {
  await ensureAttached(tabId);

  // With deviceScaleFactor: 1 set in ensureAttached, screenshots are captured
  // at CSS pixel dimensions (e.g., 1080x746), matching the coordinate space
  // used by Input.dispatchMouseEvent. No scaling tricks needed.
  const result = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 55,
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  });
  let base64 = result.data;

  // If still too large (>500KB base64 ≈ ~375KB binary), reduce quality further
  if (base64.length > 500000) {
    const smaller = await cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 30,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    base64 = smaller.data;
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId };
}

// --- Mouse helpers ---
// Brave withholds the debugger ack for synthesized mouse events (a constant
// ~5s flush for move/press/release; mouseWheel is never acked at all) while
// applying the event itself immediately. Chrome acks instantly. The ack
// carries no data we need, so give real protocol errors a short grace window
// and then proceed; a late ack (or late failure) is logged, not awaited.
// Brave's debugger input pipeline (verified empirically, 2026-07-15):
// the FIRST Input.dispatchMouseEvent of a burst acks after a constant ~5s
// cold-start; commands issued while an earlier one is still un-acked are
// NOT queued for press/release types, they are silently DROPPED (mouseMoved
// queues and applies late; mousePressed/Released vanish). mouseWheel is
// never acked at all but its scroll effect applies immediately.
// Consequences: move/press/release MUST be dispatched serially with each
// ack awaited (correctness over speed); ONLY mouseWheel may use a bounded
// race, because its effect is verified to apply without the ack and nothing
// depends on it inside the same action. Chrome acks everything instantly,
// so the awaits cost nothing there.
const INPUT_ACK_WAIT_MS = 250;

async function sendMouseEvent(tabId, params, { awaitAck = true } = {}) {
  await ensureAttached(tabId);
  const send = withTimeout(
    chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", params),
    CDP_TIMEOUT_MS,
    "CDP Input.dispatchMouseEvent",
  );
  if (awaitAck) {
    await send;
    return;
  }
  await Promise.race([
    send.catch((e) => console.warn("Input.dispatchMouseEvent late ack/failure:", e.message)),
    sleep(INPUT_ACK_WAIT_MS),
  ]);
}

async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await sendMouseEvent(tabId, {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Reply helpers for the browser-UI tools ---
// A refusal is an ordinary result, not a thrown error: the model has to be able
// to read the reason and either ask the user or move on.
function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function text(value) {
  return { content: [{ type: "text", text: String(value) }] };
}

function refuse(text) {
  return { content: [{ type: "text", text }] };
}

function bookmarkOf(node) {
  return {
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    url: node.url || null,
    folder: !node.url,
    index: node.index
  };
}

// --- Tool handlers ---
const toolHandlers = {
  // Dev/test handlers. Deliberately NOT in host/tool-definitions.js, so they
  // are invisible to MCP clients and only reachable over the native-host
  // socket (see host/ocic-call.mjs). __reload_extension exists so a code
  // change can be picked up without a manual visit to chrome://extensions;
  // __dump_browser_state reports real window/tab/group state so a test can
  // assert on what the browser actually did instead of inferring it.
  async __reload_extension() {
    setTimeout(() => chrome.runtime.reload(), 50);
    return { content: [{ type: "text", text: "Reloading extension." }] };
  },

  // Test setup only. tabs_create_mcp deliberately forces about:blank, and the
  // page a panel test needs to open is the panel itself — an extension URL,
  // which isDrivableUrl rightly refuses for the automation tools.
  async __open_tab(args) {
    const tab = await chrome.tabs.create({ url: args.url, active: args.active !== false });
    return { content: [{ type: "text", text: JSON.stringify({ tabId: tab.id, windowId: tab.windowId }) }] };
  },

  // Plants a history entry so the delete path in history_mcp can be tested
  // end to end without erasing anything the user actually visited.
  async __history_seed(args) {
    await chrome.history.addUrl({ url: args.url });
    return { content: [{ type: "text", text: `Seeded ${args.url}.` }] };
  },

  async __close_tab(args) {
    // Test cleanup only. Unlike tabs_close_mcp this is not gated on group
    // membership, because a test needs to remove a tab it deliberately
    // stranded outside the group.
    await chrome.tabs.remove(args.tabId);
    return { content: [{ type: "text", text: `Closed tab ${args.tabId}.` }] };
  },

  async __move_tab(args) {
    await chrome.tabs.ungroup([args.tabId]).catch(() => {});
    await chrome.tabs.move(args.tabId, {
      windowId: args.windowId,
      index: args.index ?? -1
    });
    return { content: [{ type: "text", text: `Moved tab ${args.tabId} to window ${args.windowId}.` }] };
  },

  // Reads and writes chrome.storage.session from outside the browser, so a
  // test can assert on what the side panel actually parked (panel_parked_v1)
  // rather than trusting the panel's own account of it — and can plant a
  // corrupt snapshot to prove a bad one doesn't wedge the panel.
  async __session_storage(args) {
    if (args?.remove) {
      await chrome.storage.session.remove(args.key);
      return { content: [{ type: "text", text: `Removed ${args.key}.` }] };
    }
    if ("value" in (args || {})) {
      await chrome.storage.session.set({ [args.key]: args.value });
      return { content: [{ type: "text", text: `Set ${args.key}.` }] };
    }
    const got = await chrome.storage.session.get(args.key);
    return { content: [{ type: "text", text: JSON.stringify(got[args.key] ?? null, null, 2) }] };
  },

  // The unpacked extension id is derived from the install path, so a test can't
  // hardcode the panel URL and stay correct across checkouts.
  async __panel_url() {
    return { content: [{ type: "text", text: chrome.runtime.getURL("sidepanel/panel.html") }] };
  },

  async __action_badge() {
    const text = await chrome.action.getBadgeText({});
    return { content: [{ type: "text", text: JSON.stringify({ text }) }] };
  },

  // Drives the side panel's DOM so a test can type, press and read back.
  //
  // Two routes were tried. chrome.scripting.executeScript is the obvious one
  // and does not work: injecting into the extension's own page is refused with
  // "Extension manifest must request permission to access this host", and no
  // host permission grants it. So this goes over runtime messaging instead, to
  // the probe listener in sidepanel/panel.js — the same channel the recorder
  // button already uses.
  //
  // Ops are declarative rather than a string of code because the extension CSP
  // forbids new Function/eval on extension pages, so an eval-style probe would
  // fail exactly where it was needed. sendMessage returns the FIRST responder,
  // so a test must keep only one panel page open at a time.
  async __panel_probe(args) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ __ocic: "panel_probe", ops: args.ops || [] });
    } catch (e) {
      // Clicking minimize or close ends with window.close(), which can tear the
      // message port down before the reply lands. That is the op working, not
      // failing — report it so a test can tell the two apart.
      res = { closed: true, error: e.message };
    }
    return { content: [{ type: "text", text: JSON.stringify(res ?? null, null, 2) }] };
  },

  async __dump_browser_state() {
    const windows = await chrome.windows.getAll({ populate: true });
    const groups = await chrome.tabGroups.query({});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              createdTabs: Array.from(createdTabs),
              attachedTabs: Array.from(attachedTabs.keys()),
              groups,
              windows: windows.map((w) => ({
                id: w.id,
                type: w.type,
                focused: w.focused,
                tabs: (w.tabs || []).map((t) => ({
                  id: t.id,
                  active: t.active,
                  groupId: t.groupId,
                  lastAccessed: t.lastAccessed,
                  url: t.url,
                  title: t.title
                }))
              }))
            },
            null,
            2
          )
        }
      ]
    };
  },

  async tabs_context_mcp(args) {
    await loadCreatedTabs();

    // newWindow is the ONLY path that opens a window. Everything else just
    // reports what is already open — no window, no tab, no regrouping.
    if (args?.newWindow === true) {
      const win = await chrome.windows.create({ focused: true, url: "about:blank" });
      const tab = win.tabs[0];
      await markCreated(tab.id);
      const result = formatTabContext(await listOpenTabs(), tab.id);
      result.content[0].text = `Opened a new window. Tab ID: ${tab.id}\n\n` + result.content[0].text;
      return result;
    }

    const tabs = await listOpenTabs();
    if (tabs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No automatable tabs are open — every window is on a browser-internal page. Open a normal page, or call tabs_context_mcp with newWindow: true if the user asked for a new window."
          }
        ]
      };
    }
    const current = await activeUserTab();
    return formatTabContext(tabs, current?.id ?? null);
  },

  async tabs_create_mcp(args) {
    await loadCreatedTabs();

    if (args?.newWindow === true) {
      const win = await chrome.windows.create({ focused: true, url: "about:blank" });
      const tab = win.tabs[0];
      await markCreated(tab.id);
      const result = formatTabContext(await listOpenTabs(), tab.id);
      result.content[0].text = `Created new window. Tab ID: ${tab.id}\n\n` + result.content[0].text;
      return result;
    }

    // Open in the window the user is working in, so no new window appears.
    const current = await activeUserTab();
    // url must be set explicitly: chrome.tabs.create() with no url opens the
    // New Tab Page (chrome://newtab/), which CDP cannot attach to — the tab
    // would be created and then be unusable.
    const tab = await chrome.tabs.create({
      active: true,
      url: "about:blank",
      ...(current ? { windowId: current.windowId } : {})
    });
    await markCreated(tab.id);
    // Foreground the freshly created tab. This is the ONLY place we activate a
    // tab — no per-action re-activation, no window focus-stealing.
    await activateTab(tab.id);
    const result = formatTabContext(await listOpenTabs(), tab.id);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async tabs_close_mcp(args) {
    await loadCreatedTabs();

    // Accept either a single tabId (most common) or a tabIds array for batch
    // close. Closing is the one irreversible action here, so by default it is
    // limited to tabs we opened; `force: true` is for when the user has
    // explicitly asked for one of their own tabs to be closed.
    const requested = (
      Array.isArray(args?.tabIds)
        ? args.tabIds
        : args?.tabId !== undefined
          ? [args.tabId]
          : []
    ).map((id) => (typeof id === "string" ? Number(id) : id));

    if (requested.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No tabId provided. Pass `tabId: <number>` or `tabIds: [<number>, ...]`."
          }
        ]
      };
    }

    const force = args?.force === true;
    const toClose = [];
    const refused = [];
    for (const id of requested) {
      if (force || (await wasCreatedByUs(id))) toClose.push(id);
      else refused.push(id);
    }

    if (toClose.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `Refused to close [${refused.join(", ")}]: you did not open ${refused.length === 1 ? "that tab" : "those tabs"}, ` +
              `so ${refused.length === 1 ? "it is" : "they are"} the user's. If the user explicitly asked for ${refused.length === 1 ? "it" : "them"} to be closed, ` +
              `call again with force: true.`
          }
        ]
      };
    }

    // chrome.tabs.remove force-closes — no beforeunload prompt. Detach any
    // CDP debuggers proactively so the onRemoved handler doesn't race.
    for (const id of toClose) {
      if (attachedTabs.has(id)) {
        try { await chrome.debugger.detach({ tabId: id }); } catch {}
        attachedTabs.delete(id);
      }
    }
    try {
      await chrome.tabs.remove(toClose);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to close [${toClose.join(", ")}]: ${e.message}` }] };
    }
    for (const id of toClose) createdTabs.delete(id);
    await saveCreatedTabs();

    const summary =
      `Closed ${toClose.length} tab(s): [${toClose.join(", ")}]` +
      (refused.length
        ? `. Refused [${refused.join(", ")}] — the user opened ${refused.length === 1 ? "that one" : "those"}; pass force: true only if the user asked.`
        : "") +
      `.`;

    const tabs = await listOpenTabs();
    if (tabs.length === 0) {
      return { content: [{ type: "text", text: `${summary} No automatable tabs remain open.` }] };
    }
    const current = await activeUserTab();
    const result = formatTabContext(tabs, current?.id ?? null);
    result.content[0].text = `${summary}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // Strip any malformed protocol prefix before normalizing
      if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:") && !targetUrl.startsWith("chrome:") && !targetUrl.startsWith("brave:")) {
        // Remove any partial/broken protocol prefix (e.g., "hps://", "http:/", "ht://")
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl); // Validate URL before passing to Chrome
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    const tabs = await listOpenTabs();
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    let coordinate = args.coordinate;
    // Resolve ref to coordinates if provided
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        // Get viewport dimensions for the response message
        let dims = "";
        try {
          const vp = await cdp(tabId, "Runtime.evaluate", {
            expression: "window.innerWidth + 'x' + window.innerHeight",
          });
          if (vp?.result?.value) dims = vp.result.value;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      // Hidden diagnostic (not in the tool schema): serially times every CDP
      // input variant at the given coordinate so we can hunt for a dispatch
      // path Brave acks fast (keyboard-style) instead of the ~5s mouse path.
      case "diag_input": {
        const dx = coordinate ? coordinate[0] : 200;
        const dy = coordinate ? coordinate[1] : 200;
        const r = {};
        const t = async (label, fn) => {
          const t0 = Date.now();
          try { await fn(); r[label] = (Date.now() - t0) / 1000; }
          catch (e) { r[label] = (Date.now() - t0) / 1000; r[label + "_err"] = String(e.message || e).slice(0, 80); }
        };
        await t("mouse_moved", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: dx, y: dy }));
        await t("mouse_pressed", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: dx, y: dy, button: "left", clickCount: 1 }));
        await t("mouse_released", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: dx, y: dy, button: "left", clickCount: 1 }));
        await t("touch_start", () => cdp(tabId, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dx, y: dy }] }));
        await t("touch_end", () => cdp(tabId, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
        await t("synthesize_tap", () => cdp(tabId, "Input.synthesizeTapGesture", { x: dx, y: dy }));
        await t("synthesize_scroll", () => cdp(tabId, "Input.synthesizeScrollGesture", { x: dx, y: dy, yDistance: -100 }));
        await t("insert_text_noop", () => cdp(tabId, "Input.insertText", { text: "" }));
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }

      case "right_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await ensureAttached(tabId);
        // Type character by character for better compatibility
        for (const char of args.text) {
          await cdp(tabId, "Input.insertText", { text: char });
          await sleep(10);
        }
        return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      }

      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        // Parse space-separated key combos
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const resolvedKey = key.length === 1 ? key : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
              windowsVirtualKeyCode: resolvedKey.charCodeAt ? resolvedKey.charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await sendMouseEvent(tabId, {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        }, { awaitAck: false });
        await sleep(300);
        // The scroll already happened; the confirmation screenshot is best-effort.
        // On a heavy page still re-rendering after the scroll, the capture can
        // block, so bound it and degrade to a text-only result rather than
        // stalling the whole scroll (and the agent's retries) to the 60s cap.
        const scrollContent = [
          { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
        ];
        try {
          const { base64 } = await withTimeout(takeScreenshot(tabId), 6000, "scroll screenshot");
          scrollContent.push({ type: "image", data: base64, mimeType: "image/jpeg" });
        } catch (e) {
          scrollContent[0].text += ` (post-scroll screenshot unavailable: ${e.message}; take a screenshot to see the result)`;
        }
        return { content: scrollContent };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, {
            type: "scrollToRef",
            ref: args.ref,
          });
        }
        // Scroll target element into view via JS
        if (coordinate) {
          await cdp(tabId, "Runtime.evaluate", {
            expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})`,
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return { content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }] };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // Capture full screenshot then crop region
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        // Return the full screenshot with region info — client can crop
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            { type: "image", data: fullBase64, mimeType: "image/png" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    // Append viewport dimensions so Claude knows the coordinate space
    try {
      await ensureAttached(tabId);
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.innerWidth + 'x' + window.innerHeight",
      });
      if (vp?.result?.value) tree += `\n\nViewport: ${vp.result.value}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    await ensureAttached(tabId);
    try {
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}` }],
        };
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    await ensureAttached(tabId);
    const tab = await chrome.tabs.get(tabId);
    // A maximized/fullscreen window silently ignores width/height (notably on
    // macOS), so normalize the state first, then size it.
    try { await chrome.windows.update(tab.windowId, { state: "normal" }); } catch (e) {}
    await chrome.windows.update(tab.windowId, { width, height });
    // The page's layout viewport and every screenshot are pinned by the CDP
    // device-metrics override (set at attach to dpr=1 at the old size). Without
    // repointing it, the OS window moves but window.innerWidth, the rendered
    // viewport, and captures never change — which is why resize looked like a
    // no-op. Re-apply the override at the requested size.
    await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, coordinate, filename = "image.png" } = args;
    { const problem = await tabProblem(tabId); if (problem) return { content: [{ type: "text", text: problem }] }; }

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    // Use CDP to set file input
    if (ref) {
      // Find the element and set its files via CDP
      await ensureAttached(tabId);
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = window.__unblockedChrome?.resolveRef?.("${ref}");
          if (!el) return null;
          return el.tagName.toLowerCase();
        })()`,
        returnByValue: true,
      });

      if (result.result?.value === "input") {
        // For file inputs, we need DOM.setFileInputFiles via CDP
        // First get the node
        const doc = await cdp(tabId, "DOM.getDocument", {});
        const nodeResult = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const el = window.__unblockedChrome?.resolveRef?.("${ref}");
            if (el) el.scrollIntoView();
            return true;
          })()`,
          returnByValue: true,
        });
        return { content: [{ type: "text", text: `Upload via file input requires a temporary file. Use the file input directly.` }] };
      }
    }

    return { content: [{ type: "text", text: `Image upload for ref=${ref}, coordinate=${coordinate} — use drag & drop or file input.` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    const current = await detectBrowser();
    // Release AFTER this reply is delivered — it goes out over the very native
    // port we are about to drop. Suspending reconnect lets a target browser
    // whose extension is enabled bind the shared runtime and become primary;
    // if none takes over, this browser reconnects when the window elapses.
    setTimeout(() => {
      suspendReconnectUntil = Date.now() + SWITCH_RELEASE_MS;
      if (nativePort) {
        try { nativePort.disconnect(); } catch (e) {}
        nativePort = null;
        stopHeartbeat();
      }
    }, 300);
    return {
      content: [{
        type: "text",
        text:
          `Releasing the connection from ${current}. Enable this extension in the ` +
          `target browser (no restart needed) — for the next ~${SWITCH_RELEASE_MS / 1000}s it can take over ` +
          `the shared runtime automatically. Only one browser drives automation at a ` +
          `time. If nothing takes over, ${current} reconnects when the window elapses. ` +
          `Re-run tabs_context_mcp after a few seconds to confirm the active browser.`,
      }],
    };
  },

  // --- Browser UI, outside the page ---
  //
  // Everything above this point drives web content. These drive the browser
  // itself: the bookmarks bar, history, the download shelf, the installed
  // extensions, the window frame.
  //
  // None of it goes through CDP, because CDP cannot see browser chrome. A tab's
  // debugger target renders the page and nothing else, so Page.captureScreenshot
  // and chrome.tabs.captureVisibleTab both stop at the viewport edge — the tab
  // strip, the omnibox and the bookmarks bar are not in any target an extension
  // may attach to, and chrome:// pages refuse both scripting and CDP. The way to
  // "see" the bookmarks bar is therefore to read the bookmarks, not to
  // photograph them, which is what these tools do.
  //
  // Mutating actions that a user would not want done speculatively — deleting a
  // bookmark, erasing history, disabling or uninstalling an extension, killing a
  // download — are refused without force: true, the same convention
  // tabs_close_mcp uses.

  async browser_chrome_mcp() {
    // One read of everything cheap, so the model can orient in a single call
    // rather than probing five tools to find out what exists.
    const out = {};

    const windows = await chrome.windows.getAll({ populate: true });
    out.windows = windows.map((w) => ({
      windowId: w.id,
      type: w.type,
      state: w.state, // "normal" | "minimized" | "maximized" | "fullscreen"
      focused: w.focused,
      bounds: { left: w.left, top: w.top, width: w.width, height: w.height },
      tabCount: (w.tabs || []).length
    }));

    // The bookmarks bar is a folder, not a widget: whatever is on it lives under
    // the tree node titled "Bookmarks Bar" (id "1" in every Chrome build so far,
    // but matched by title as well so a rename or a locale doesn't break it).
    try {
      const [root] = await chrome.bookmarks.getTree();
      const bar =
        (root.children || []).find((c) => c.id === "1") ||
        (root.children || []).find((c) => /bookmarks bar|bookmarks toolbar/i.test(c.title || ""));
      out.bookmarksBar = bar
        ? (bar.children || []).map((c) => ({
            id: c.id,
            title: c.title,
            url: c.url || null,
            folder: !c.url,
            childCount: c.children ? c.children.length : undefined
          }))
        : null;
    } catch (e) {
      out.bookmarksBar = `unavailable: ${e.message}`;
    }

    try {
      out.topSites = (await chrome.topSites.get()).slice(0, 15);
    } catch (e) {
      out.topSites = `unavailable: ${e.message}`;
    }

    try {
      const recent = await chrome.sessions.getRecentlyClosed({ maxResults: 10 });
      out.recentlyClosed = recent.map((s) => ({
        sessionId: s.tab?.sessionId || s.window?.sessionId,
        kind: s.tab ? "tab" : "window",
        title: s.tab?.title || `${s.window?.tabs?.length ?? 0} tabs`,
        url: s.tab?.url || null
      }));
    } catch (e) {
      out.recentlyClosed = `unavailable: ${e.message}`;
    }

    // Chrome 120+. Guarded rather than assumed so an older browser reports a
    // missing surface instead of failing the whole call.
    try {
      out.readingList = chrome.readingList
        ? (await chrome.readingList.query({})).map((e) => ({
            title: e.title,
            url: e.url,
            hasBeenRead: e.hasBeenRead
          }))
        : "unavailable: needs Chrome 120+";
    } catch (e) {
      out.readingList = `unavailable: ${e.message}`;
    }

    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },

  async bookmarks_mcp(args) {
    const action = args?.action || "list";

    if (action === "search") {
      if (!args.query) return refuse("bookmarks_mcp action 'search' needs a query.");
      const hits = await chrome.bookmarks.search(args.query);
      return json(hits.slice(0, args.limit || 50).map(bookmarkOf));
    }

    if (action === "list") {
      // A whole tree is enormous and mostly noise. Default to one level of the
      // folder asked for, so the model walks down deliberately.
      const id = args.folderId || "0";
      const children = await chrome.bookmarks.getChildren(id);
      return json({ folderId: id, children: children.map(bookmarkOf) });
    }

    if (action === "create") {
      if (!args.title && !args.url) return refuse("bookmarks_mcp action 'create' needs a title, a url, or both.");
      const node = await chrome.bookmarks.create({
        parentId: args.folderId || "1", // default to the bookmarks bar
        title: args.title || args.url,
        ...(args.url ? { url: args.url } : {})
      });
      return json({ created: bookmarkOf(node) });
    }

    if (action === "move") {
      if (!args.id || !args.folderId) return refuse("bookmarks_mcp action 'move' needs both id and folderId.");
      const node = await chrome.bookmarks.move(args.id, { parentId: args.folderId, index: args.index });
      return json({ moved: bookmarkOf(node) });
    }

    if (action === "remove") {
      if (!args.id) return refuse("bookmarks_mcp action 'remove' needs an id.");
      if (args.force !== true) {
        const node = (await chrome.bookmarks.get(args.id))[0];
        return refuse(
          `Refusing to delete the bookmark "${node?.title || args.id}" without force: true. ` +
            `Deleting a bookmark is not undoable from here. Ask the user first, then retry with force: true.`
        );
      }
      // A folder needs removeTree; remove() throws on a non-empty one.
      const node = (await chrome.bookmarks.get(args.id))[0];
      if (node && !node.url) await chrome.bookmarks.removeTree(args.id);
      else await chrome.bookmarks.remove(args.id);
      return json({ removed: args.id });
    }

    return refuse(`Unknown bookmarks_mcp action "${action}".`);
  },

  async history_mcp(args) {
    const action = args?.action || "search";

    if (action === "search") {
      const days = args.days ?? 7;
      const results = await chrome.history.search({
        text: args.query || "",
        startTime: Date.now() - days * 86400000,
        maxResults: args.limit || 50
      });
      return json(
        results.map((h) => ({
          url: h.url,
          title: h.title,
          lastVisit: h.lastVisitTime ? new Date(h.lastVisitTime).toISOString() : null,
          visitCount: h.visitCount
        }))
      );
    }

    if (action === "delete") {
      if (!args.url) return refuse("history_mcp action 'delete' needs a url.");
      if (args.force !== true) {
        return refuse(
          `Refusing to erase history for ${args.url} without force: true. Ask the user first, then retry with force: true.`
        );
      }
      await chrome.history.deleteUrl({ url: args.url });
      return json({ deleted: args.url });
    }

    return refuse(`Unknown history_mcp action "${action}".`);
  },

  async downloads_mcp(args) {
    const action = args?.action || "list";

    if (action === "list") {
      const items = await chrome.downloads.search({
        limit: args.limit || 25,
        orderBy: ["-startTime"],
        ...(args.query ? { query: [args.query] } : {})
      });
      return json(
        items.map((d) => ({
          id: d.id,
          filename: d.filename,
          url: d.url,
          state: d.state, // in_progress | interrupted | complete
          paused: d.paused,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          startTime: d.startTime
        }))
      );
    }

    if (!args?.id) return refuse(`downloads_mcp action '${action}' needs an id (get one from action 'list').`);

    if (action === "pause") {
      await chrome.downloads.pause(args.id);
      return json({ paused: args.id });
    }
    if (action === "resume") {
      await chrome.downloads.resume(args.id);
      return json({ resumed: args.id });
    }
    if (action === "show") {
      // Opens the OS file manager at the file. Nothing is deleted or run.
      chrome.downloads.show(args.id);
      return json({ shown: args.id });
    }
    if (action === "cancel") {
      if (args.force !== true) {
        return refuse(
          `Refusing to cancel download ${args.id} without force: true — a partial file is lost. Ask the user first.`
        );
      }
      await chrome.downloads.cancel(args.id);
      return json({ cancelled: args.id });
    }

    return refuse(`Unknown downloads_mcp action "${action}".`);
  },

  async extensions_mcp(args) {
    const action = args?.action || "list";

    if (action === "list") {
      const all = await chrome.management.getAll();
      return json(
        all
          .filter((e) => e.type === "extension")
          .map((e) => ({
            id: e.id,
            name: e.name,
            version: e.version,
            enabled: e.enabled,
            installType: e.installType, // "development" for unpacked
            mayDisable: e.mayDisable,
            hostPermissions: e.hostPermissions,
            permissions: e.permissions
          }))
      );
    }

    if (!args?.id) return refuse(`extensions_mcp action '${action}' needs an id (get one from action 'list').`);
    if (args.id === chrome.runtime.id && action !== "list") {
      // Disabling ourselves severs the native port mid-reply and leaves the user
      // with no automation and no obvious cause.
      return refuse("Refusing to act on this extension itself — that would cut the connection you are talking over.");
    }

    const target = await chrome.management.get(args.id).catch(() => null);
    if (!target) return refuse(`No extension with id ${args.id}.`);

    if (action === "enable") {
      await chrome.management.setEnabled(args.id, true);
      return json({ enabled: target.name });
    }
    if (action === "disable") {
      if (args.force !== true) {
        return refuse(`Refusing to disable "${target.name}" without force: true. Ask the user first.`);
      }
      if (!target.mayDisable) return refuse(`"${target.name}" is policy-installed and cannot be disabled.`);
      await chrome.management.setEnabled(args.id, false);
      return json({ disabled: target.name });
    }
    if (action === "uninstall") {
      if (args.force !== true) {
        return refuse(`Refusing to uninstall "${target.name}" without force: true. This is not undoable. Ask the user first.`);
      }
      // showConfirmDialog leaves the final say with the user even after force.
      await chrome.management.uninstall(args.id, { showConfirmDialog: true });
      return json({ uninstallRequested: target.name });
    }

    return refuse(`Unknown extensions_mcp action "${action}".`);
  },

  async window_control_mcp(args) {
    const windows = await chrome.windows.getAll({ populate: false });
    const windowId = args?.windowId ?? windows.find((w) => w.focused)?.id ?? windows[0]?.id;
    if (windowId === undefined) return refuse("No browser window to control.");

    const update = {};
    if (args?.state) update.state = args.state;
    if (args?.focused === true) update.focused = true;
    for (const k of ["left", "top", "width", "height"]) {
      if (args?.[k] !== undefined) update[k] = args[k];
    }
    if (Object.keys(update).length === 0) {
      return refuse("window_control_mcp needs at least one of state, focused, left, top, width or height.");
    }
    // Bounds are ignored while a window is maximized or fullscreen, so drop that
    // state first when a move or resize was asked for (same trap resize_window
    // documents).
    const movingOrSizing = ["left", "top", "width", "height"].some((k) => k in update);
    if (movingOrSizing && !update.state) {
      try { await chrome.windows.update(windowId, { state: "normal" }); } catch (e) {}
    }
    const win = await chrome.windows.update(windowId, update);
    return json({
      windowId: win.id,
      state: win.state,
      bounds: { left: win.left, top: win.top, width: win.width, height: win.height }
    });
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },

  // --- API discovery and reverse engineering ---
  // Thin wrappers: the work is in apimap.js. Each returns a text block, and
  // returns errors as text rather than throwing, matching every handler above.

  async api_capture(args) {
    if (args?.tabId) {
      const problem = await tabProblem(args.tabId);
      if (problem) return { content: [{ type: "text", text: problem }] };
    }
    return text(await self.ApiMap.capture(args || {}));
  },

  async api_fetch_source(args) {
    if (args?.tabId) {
      const problem = await tabProblem(args.tabId);
      if (problem) return { content: [{ type: "text", text: problem }] };
    }
    return text(await self.ApiMap.fetchSource(args || {}));
  },

  async api_scan_source(args) {
    return text(await self.ApiMap.scanSource(args || {}));
  },

  async api_crawl(args) {
    if (args?.action === "stop") return text(await self.ApiMap.crawlStop(args.slug));
    const problem = await tabProblem(args?.tabId);
    if (problem) return { content: [{ type: "text", text: problem }] };
    // Clicking things in a live app under the user's own session is the one
    // genuinely state-changing thing these tools do, so it is gated the same
    // way every other destructive action here is.
    if (args?.interact === true && args?.force !== true) {
      return refuse(
        "Refusing to crawl with interact: true without force: true. Interaction clicks buttons and " +
          "controls in the user's real, logged-in session, which can change data on the site. Ask the " +
          "user first, then retry with force: true. Crawling without interact is navigation only and needs no force."
      );
    }
    return text(await self.ApiMap.crawl(args || {}));
  },

  async api_spec(args) {
    return text(await self.ApiMap.spec(args || {}));
  },

  async api_probe(args) {
    const method = String(args?.method || "GET").toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].indexOf(method) === -1 && args?.force !== true) {
      return refuse(
        `Refusing to probe with ${method} without force: true. Replaying a ${method} against a live ` +
          "application can create, change or destroy real data. Ask the user first, then retry with force: true."
      );
    }
    if (args?.tabId) {
      const problem = await tabProblem(args.tabId);
      if (problem) return { content: [{ type: "text", text: problem }] };
    }
    return text(await self.ApiMap.probe(args || {}));
  },

  async api_hosts(args) {
    if (args?.tabId) {
      const problem = await tabProblem(args.tabId);
      if (problem) return { content: [{ type: "text", text: problem }] };
    }
    return text(await self.ApiMap.hosts(args || {}));
  },

  async api_wellknown(args) {
    if (args?.tabId) {
      const problem = await tabProblem(args.tabId);
      if (problem) return { content: [{ type: "text", text: problem }] };
    }
    return text(await self.ApiMap.wellKnown(args || {}));
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  // recording_ack arrives from the MCP server when Claude confirms receipt of
  // a recording_complete event. Mark it delivered so stopRecording() can
  // report the "delivered to Claude Code" state (§4).
  if (tool === "recording_ack") {
    if (args && args.recording_id) recorder.deliveredIds.add(String(args.recording_id));
    sendResponse(id, { content: [{ type: "text", text: "ack received" }] });
    return;
  }

  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// ===========================================================================
// Imitation-learning recorder (NEEDS LIVE TESTING)
// ---------------------------------------------------------------------------
// The service worker is a THIN ROUTER only: it toggles recording on the icon,
// owns the offscreen document (the durable buffer that survives SW eviction),
// forwards behavior events from content scripts to it, segments the cross-tab
// timeline, and on stop ships the bundle to disk + notifies Claude Code.
// The heavy state lives in the offscreen doc, never in SW globals.
// ===========================================================================
const recorder = {
  active: false,
  recordingId: null,
  startedAt: null,
  deliveredIds: new Set(), // recording_ids Claude has acked
  pendingSaves: new Map(), // recording_id -> resolve (native-host disk write)
  imgSeq: 0, // frame counter for the images/ dir
  lastCapture: 0, // ts of last frame, to throttle to ≤1/sec
  lastVw: 0, // last viewport size seen (from content-script events), stamped
  lastVh: 0, // onto each frame so the viewer can map cursor x/y onto it
  // True while booting the mic or processing a stop (transcribe/save/copy).
  // Icon clicks are IGNORED while busy. In-memory on purpose: a dead SW has
  // no in-flight pipeline, so busy must never survive a restart.
  busy: false,
  // Badge epoch: bumped on every start/stop transition. Every DELAYED badge
  // writer (the post-copy delivery update, the 4s result-clear timer) captures
  // the epoch and is discarded if a newer transition happened — a previous
  // recording's stragglers must never repaint the current recording's badge.
  epoch: 0
};

// MV3 evicts this service worker after ~30s idle, which zeroes the globals
// above. Before this guard, a mid-recording eviction made the next icon click
// START a new recording (active had reset to false) whose offscreen "start"
// cleared the buffers — destroying the in-flight demo and shipping a 4-second
// shell instead. The cure: the toggle/forwarding state lives in
// chrome.storage.session (survives SW eviction, dies with the browser), and
// every gate hydrates from it before trusting `recorder`.
const REC_STATE_KEY = "recorder_state_v1";

function persistRecorderState() {
  chrome.storage.session
    .set({
      [REC_STATE_KEY]: {
        active: recorder.active,
        recordingId: recorder.recordingId,
        startedAt: recorder.startedAt,
        imgSeq: recorder.imgSeq,
        lastVw: recorder.lastVw,
        lastVh: recorder.lastVh
      }
    })
    .catch(() => {});
}

async function hydrateRecorderState() {
  try {
    const { [REC_STATE_KEY]: s } = await chrome.storage.session.get(REC_STATE_KEY);
    if (s && s.active && !recorder.active) {
      recorder.active = true;
      recorder.recordingId = s.recordingId;
      recorder.startedAt = s.startedAt;
      recorder.imgSeq = s.imgSeq || 0;
      recorder.lastVw = s.lastVw || 0;
      recorder.lastVh = s.lastVh || 0;
      setBadge(true); // restore REC after an eviction mid-recording
      chrome.action.setTitle({ title: "Recording… (stop in the Claude panel)" });
    }
  } catch {}
}
// Kicked off at every SW (re)start; gates await it before reading `recorder`.
const recorderReady = hydrateRecorderState();

// Capture a 240p frame anchored to an event, at most once per second. The SW
// grabs the visible tab; the offscreen doc resizes + stores it for the viewer;
// the native host writes the file. The reference goes in the images track. All
// best-effort — a dropped frame just means no file at that ref.
async function maybeCapture(t) {
  if (!recorder.active || !nativePort) return;
  const now = Date.now();
  if (now - recorder.lastCapture < 1000) return;
  recorder.lastCapture = now;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 60 });
  } catch {
    return; // not capturable (chrome:// page, no active tab, etc.)
  }
  const name = String(++recorder.imgSeq).padStart(5, "0") + ".jpg";
  persistRecorderState(); // keep frame numbering monotonic across SW evictions
  try {
    const res = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "image",
      t: t || now,
      ref: "images/" + name,
      vw: recorder.lastVw, // viewport this frame was captured at
      vh: recorder.lastVh,
      dataUrl
    });
    if (res && res.ok && res.dataUrl && nativePort) {
      nativePort.postMessage({
        type: "save_screenshot",
        recording_id: recorder.recordingId,
        name,
        dataUrl: res.dataUrl
      });
    }
  } catch {}
}

// The id doubles as the recording's folder name on disk (see
// handleSaveRecording in host/native-host.js), so it is built to be read by a
// human browsing that folder: when, and on what site. "rec_a8f3k2p1" told you
// neither. Local time, not UTC — the folder is opened on this machine. Sorts
// chronologically by name, and carries nothing a path would choke on.
function newRecordingId(startedAt, url0) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let host = "";
  try {
    host = new URL(url0).hostname.replace(/^www\./, "");
  } catch {
    // about:blank, a chrome:// page, or no tab — fall back below.
  }
  const site = host.replace(/[^a-zA-Z0-9.-]/g, "-") || "local";
  return `${stamp}_${site}`;
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "recorder/offscreen.html",
    reasons: ["USER_MEDIA", "CLIPBOARD"],
    justification:
      "Capture microphone narration, buffer the recording durably, and copy the recording reference to the clipboard on stop."
  });
}

async function getApiKey() {
  const { openai_api_key } = await chrome.storage.local.get("openai_api_key");
  return openai_api_key || "";
}

// Validate the key BEFORE any recording — a recording with no transcript path
// is a poor outcome, so we fail fast (§5).
async function validateKey(apiKey) {
  if (!apiKey) return { ok: false, error: "No OpenAI API key set. Add one in the extension options." };
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: "OpenAI API key is invalid." };
    return { ok: false, error: `OpenAI returned ${res.status}.` };
  } catch (e) {
    return { ok: false, error: `Could not reach OpenAI: ${e.message}` };
  }
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#d23b2e" });
}

// The "..." processing state: shown while the mic boots and while a stopped
// recording is transcribed, saved, and copied. Clicks are ignored throughout.
function setProcessingBadge(title) {
  chrome.action.setBadgeText({ text: "\u2026" });
  chrome.action.setBadgeBackgroundColor({ color: "#a5701a" });
  chrome.action.setTitle({ title });
}

// A paste-able reference to a saved recording — the same text the Options
// "Copy reference" button produces. Copied to the clipboard on stop so you can
// paste it straight into Claude Code, regardless of any channel.
function buildRecordingReference(path) {
  return (
    `Read the browser recording at ${path} — an imitation-learning rollout of an expert doing a task. ` +
    `trace.json holds four tracks on one shared clock (behavior, cursor, images, narration); ` +
    `SCHEMA_v0.md in that folder is the field reference, and images/ holds the frames.`
  );
}

async function copyToClipboard(text) {
  // The service worker has no clipboard; the offscreen document (created with
  // the CLIPBOARD reason) does it via a textarea + execCommand. Awaited so the
  // busy gate releases exactly when the reference is on the clipboard.
  try {
    const r = await chrome.runtime.sendMessage({ __ocic_offscreen: true, cmd: "copy", text });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

// Post-recording icon — same idea as REC while recording, so you see the
// outcome without hovering (icon AND tooltip). On success the icon is a
// clipboard (📋): the reference was copied to your clipboard. Delivery to
// Claude, if any, is appended to the tooltip. Auto-clears a few seconds after
// the last update; a new recording cancels the clear (see startRecording).
let resultClearTimer = null;
function scheduleBadgeClear() {
  if (resultClearTimer) clearTimeout(resultClearTimer);
  const ep = recorder.epoch; // this timer belongs to THIS result only
  resultClearTimer = setTimeout(() => {
    resultClearTimer = null;
    if (recorder.epoch === ep && !recorder.active && !recorder.busy) {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Chrome Controller for Claude" });
    }
  }, 4000);
}
function showResultBadge(kind) {
  if (kind === "failed") {
    chrome.action.setBadgeText({ text: "✗" });
    chrome.action.setBadgeBackgroundColor({ color: "#d23b2e" });
    chrome.action.setTitle({
      title: "Could not save the recording — is the native host installed? Run ./install.sh."
    });
  } else {
    // "copied" — the reference is on your clipboard. Delivery-to-Claude info
    // arrives later and updates the TOOLTIP only (see stopRecording).
    chrome.action.setBadgeText({ text: "📋" });
    chrome.action.setBadgeBackgroundColor({ color: "#0e8a5f" });
    chrome.action.setTitle({
      title: "Recording saved · reference copied to clipboard — paste it into Claude Code."
    });
  }
  scheduleBadgeClear();
}

async function broadcastRecordingState(on) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null)
      chrome.tabs
        .sendMessage(t.id, { __ocic: "recording_state", on })
        .catch(() => {});
  }
}

async function startRecording() {
  // New transition: stale writers from any previous stop are dead from here.
  recorder.epoch++;
  if (resultClearTimer) {
    clearTimeout(resultClearTimer);
    resultClearTimer = null;
  }
  // Boot feedback at the INSTANT of the click — before the key validation
  // network call — so the icon never looks dead after a press.
  setProcessingBadge("Starting… validating key and warming up the microphone");
  broadcastRecorderStateToPanel(); // busy → "working"
  const apiKey = await getApiKey();
  const v = await validateKey(apiKey);
  if (!v.ok) {
    // Surface via badge + a notification-free options nudge.
    chrome.action.setTitle({ title: `Cannot record: ${v.error}` });
    setBadge(false);
    broadcastRecorderStateToPanel();
    return { ok: false, error: v.error };
  }
  await ensureOffscreen();
  // url0 is resolved before the id because the id is named after it (and after
  // the start time), and because frames streamed during the recording go
  // straight into <id>/images/ — the name has to be final from the first frame.
  const url0 = await activeTabUrl();
  recorder.startedAt = Date.now();
  recorder.recordingId = newRecordingId(recorder.startedAt, url0);
  recorder.imgSeq = 0;
  recorder.lastCapture = 0;
  // Warm-up continues: REC appears only when the offscreen doc reports the
  // mic ready (~2.5s later § muffled start).
  chrome.action.setTitle({ title: "Starting microphone… wait for REC before talking" });
  const startRes = await chrome.runtime.sendMessage({
    __ocic_offscreen: true,
    cmd: "start",
    recording_id: recorder.recordingId,
    started_at: recorder.startedAt,
    apiKey,
    url0
  });
  // Split-brain heal: the offscreen doc already has a live session (we lost
  // track of it, e.g. session-state loss this hydration couldn't cover).
  // ADOPT it — never clobber a recording in progress.
  if (startRes && startRes.already && startRes.session) {
    recorder.active = true;
    recorder.recordingId = startRes.session.recording_id;
    recorder.startedAt = startRes.session.started_at;
    setBadge(true);
    chrome.action.setTitle({ title: "Recording… (stop in the Claude panel)" });
    persistRecorderState();
    broadcastRecorderStateToPanel();
    return { ok: true, adopted: true };
  }
  // If the mic didn't start (permission not granted), fail LOUDLY — voice is
  // core to a recording. Guide the operator to enable it in Options rather
  // than silently capturing behavior with no narration.
  if (!startRes || !startRes.ok) {
    recorder.active = false;
    persistRecorderState();
    setBadge(false);
    const err = (startRes && startRes.error) || "microphone unavailable";
    chrome.action.setTitle({ title: `Can't record: ${err}` });
    broadcastRecorderStateToPanel();
    chrome.runtime.openOptionsPage();
    return { ok: false, error: err };
  }
  recorder.active = true;
  setBadge(true);
  chrome.action.setTitle({ title: "Recording… (stop in the Claude panel)" });
  persistRecorderState();
  broadcastRecorderStateToPanel();
  await broadcastRecordingState(true);
  return { ok: true };
}

async function stopRecording() {
  const ep = ++recorder.epoch; // stale writers below check this before painting
  const live = () => recorder.epoch === ep;
  const tProc = Date.now();
  recorder.active = false;
  persistRecorderState();
  setProcessingBadge("Processing recording\u2026 (transcribing, saving, copying)");
  broadcastRecorderStateToPanel(); // active off, busy on \u2192 "working"
  await broadcastRecordingState(false);
  const res = await chrome.runtime.sendMessage({
    __ocic_offscreen: true,
    cmd: "stop"
  });
  if (!res || !res.ok) {
    if (live()) chrome.action.setTitle({ title: "Recording failed to save." });
    return { ok: false, error: res && res.error };
  }
  const { bundle } = res;
  // 1) Persist to disk FIRST (reliability). Show the SAVE result immediately —
  // it must not wait on the up-to-12s Claude ack below.
  const path = await saveBundleToDisk(bundle).catch((e) => {
    console.error("save failed", e);
    return null;
  });
  if (!path) {
    if (live()) showResultBadge("failed");
    return { ok: false, error: "save failed" };
  }
  // 2) Copy the reference to the clipboard immediately — the primary, channel-
  // independent feedback. Then show the clipboard icon.
  await copyToClipboard(buildRecordingReference(path));
  // Hold the "…" long enough to be SEEN even when the pipeline was instant
  // (no audio -> no transcription): the stages must read consistently.
  const hold = 800 - (Date.now() - tProc);
  if (hold > 0) await sleep(hold);
  if (live()) showResultBadge("copied");
  recorder.busy = false; // reference on the clipboard: the icon is live again
  broadcastRecorderStateToPanel(); // busy cleared, active off → "idle"
  // Record the on-disk path on the session so the Options viewer can copy it too.
  chrome.runtime
    .sendMessage({ __ocic_offscreen: true, cmd: "set_path", recording_id: bundle.recording_id, path })
    .catch(() => {});
  // 3) Notify Claude (best-effort); append delivery to the tooltip when it resolves.
  // Delivery confirmation can arrive up to ~12s later. It must NEVER repaint
  // the badge (a new recording may be underway by then) — tooltip only, and
  // only while this stop is still the latest transition.
  const connectionState = await notifyClaude(bundle, path);
  if (live() && !recorder.active && !recorder.busy) {
    const deliv =
      connectionState === "delivered"
        ? " Also delivered to Claude Code."
        : connectionState === "sent_unconfirmed"
          ? " Sent to Claude — delivery not confirmed."
          : " No Claude Code session connected.";
    chrome.action.setTitle({
      title: "Recording saved · reference copied to clipboard — paste it into Claude Code." + deliv
    });
  }
  return { ok: true, path, connectionState };
}

// Disk write goes through the NATIVE HOST (a Node process with fs), not
// chrome.downloads — the browser download path pops an OS "save as" dialog on
// some setups even with saveAs:false, and this writes to a stable location
// (the recordings dir resolved in host/native-host.js) the agent can open.
// trace.json is small text; audio stays in IndexedDB. Returns the absolute
// directory, or null if the native host isn't reachable.
async function saveBundleToDisk(bundle) {
  if (!nativePort) return null;
  const schemaMd = await getSchemaMd();
  const done = new Promise((resolve) => {
    recorder.pendingSaves.set(String(bundle.recording_id), resolve);
    setTimeout(() => {
      if (recorder.pendingSaves.delete(String(bundle.recording_id))) resolve(null);
    }, 8000);
  });
  try {
    nativePort.postMessage({
      type: "save_recording",
      recording_id: bundle.recording_id,
      schema: bundle.schema || "v0",
      schema_md: schemaMd,
      trace: bundle.trace
    });
  } catch {
    recorder.pendingSaves.delete(String(bundle.recording_id));
    return null;
  }
  return await done;
}

// The versioned schema descriptor, shipped into each bundle so the agent knows
// how to read the trace. Read once from the packaged file, then cached.
let _schemaMd = null;
async function getSchemaMd() {
  if (_schemaMd != null) return _schemaMd;
  try {
    const res = await fetch(chrome.runtime.getURL("recorder/SCHEMA_v0.md"));
    _schemaMd = await res.text();
  } catch {
    _schemaMd = "";
  }
  return _schemaMd;
}

// Fire recording_complete upstream (→ native host → TCP → MCP server → channel
// notification). Then wait briefly for Claude's recording_ack to know delivery
// (§4). The native-host heartbeat tells us if any session is connected at all.
async function notifyClaude(bundle, path) {
  if (!nativePort) return "no_session"; // native host not connected
  try {
    nativePort.postMessage({
      type: "recording_complete",
      recording_id: bundle.recording_id,
      path: path || "",
      schema: bundle.schema,
      summary: bundle.summary
    });
  } catch {
    return "no_session";
  }
  // Await ack up to ~12s.
  const acked = await waitForAck(bundle.recording_id, 12000);
  return acked ? "delivered" : "sent_unconfirmed";
}

function waitForAck(recordingId, timeoutMs) {
  if (recorder.deliveredIds.has(recordingId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (recorder.deliveredIds.has(recordingId)) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 250);
  });
}


async function activeTabUrl() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t?.url || null;
  } catch {
    return null;
  }
}

// The recorder toggle used to live on the icon click, but the icon now opens
// the side panel (see setPanelBehavior below — with openPanelOnActionClick on,
// chrome.action.onClicked no longer fires). Start/stop moved to a button in the
// panel, which messages the SW (recorder_toggle). The logic is unchanged:
// hydrate first, because after an SW eviction the in-memory flag is a lie and
// acting on it destroys the in-flight recording; and respect the busy gate.
function toggleRecorder() {
  return recorderReady
    .then(() => {
      // Busy = booting the mic or processing a stop: the toggle is IGNORED.
      // It is live only when idle, recording, or showing a result.
      if (recorder.busy) return;
      recorder.busy = true;
      const op = recorder.active ? stopRecording() : startRecording();
      return op.finally(() => {
        recorder.busy = false; // safety net; the copied-path clears it earlier
        broadcastRecorderStateToPanel(); // final sync, incl. failure early-returns
      });
    })
    .catch((e) => console.error("recorder toggle failed", e));
}

// The single string the panel's record button renders. Busy wins (a transition
// is in flight), then active. Mirrors the badge: working → amber, recording →
// red, idle → neutral.
function derivePanelState() {
  if (recorder.busy) return "working";
  if (recorder.active) return "recording";
  return "idle";
}

// Push the current recorder state to an open panel. No-op (the sendMessage just
// rejects) when no panel is listening — the panel also polls on load via
// recorder_state_get, so a missed broadcast is self-healing.
function broadcastRecorderStateToPanel() {
  chrome.runtime
    .sendMessage({ __ocic: "recorder_state", state: derivePanelState() })
    .catch(() => {});
}

// Behavior events from content scripts → offscreen buffer. Tab segmentation.
// Every gate awaits hydration: an event arriving right after SW wake-up must
// still be forwarded to the (still-recording) offscreen buffer.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.__ocic === "behavior_event") {
    recorderReady.then(() => {
      if (!recorder.active) return;
      if (msg.vw) { recorder.lastVw = msg.vw; recorder.lastVh = msg.vh; }
      const evt = { ...msg, tab: sender.tab?.id ?? -1, frame: sender.frameId ?? 0 };
      chrome.runtime
        .sendMessage({ __ocic_offscreen: true, cmd: "event", event: evt })
        .catch(() => {});
      maybeCapture(msg.t); // frame anchored to this action (throttled ≤1/sec)
    });
    return;
  }
  if (msg.__ocic === "cursor_batch") {
    recorderReady.then(() => {
      if (!recorder.active) return;
      if (msg.vw) { recorder.lastVw = msg.vw; recorder.lastVh = msg.vh; }
      chrome.runtime
        .sendMessage({ __ocic_offscreen: true, cmd: "cursor", points: msg.points })
        .catch(() => {});
      maybeCapture(); // frame during cursor activity (throttled ≤1/sec)
    });
    return;
  }
  if (msg.__ocic === "recorder_hello") {
    recorderReady.then(() => sendResponse({ on: recorder.active }));
    return true; // async response
  }
  // Side-panel record button → run the same toggle the icon used to. The panel
  // paints optimistically; the authoritative state comes back via the
  // recorder_state broadcasts fired at each real transition in start/stop.
  if (msg.__ocic === "recorder_toggle") {
    toggleRecorder().finally(() => sendResponse({ state: derivePanelState() }));
    return true; // async response
  }
  // Panel syncs on load (and after an SW wake) — hydrate before reporting so we
  // never tell a freshly-woken panel "idle" while a recording is in progress.
  if (msg.__ocic === "recorder_state_get") {
    recorderReady.then(() => sendResponse({ state: derivePanelState() }));
    return true; // async response
  }
});

// Tab + navigation events, captured in the SW so the trace has one-to-one
// parity with OCIC's own commands (navigate, tab focus/create) — not just the
// computer-tool primitives. Each carries the tab's URL so the trace records
// what tab we're in and what the current URL is.
async function recordSwEvent(action, tabId, extra = {}) {
  await recorderReady; // SW may have just woken mid-recording
  if (!recorder.active) return;
  let url = extra.url;
  if (url === undefined && tabId != null && tabId >= 0) {
    try {
      const t = await chrome.tabs.get(tabId);
      url = t && t.url;
    } catch {
      url = undefined;
    }
  }
  chrome.runtime
    .sendMessage({
      __ocic_offscreen: true,
      cmd: "event",
      event: {
        t: Date.now(),
        tab: tabId ?? -1,
        frame: 0,
        action,
        // The core `command` key: the exact OCIC tool input (plus the event's
        // tab as tabId). tab_activated has NO OCIC verb — tools select tabs
        // via their tabId param — so it carries no command, only context.
        command:
          action === "navigate"
            ? { tool: "navigate", input: { url } }
            : action === "tab_opened"
              ? { tool: "tabs_create_mcp", input: {} }
              : action === "tab_closed"
                ? { tool: "tabs_close_mcp", input: {} }
                : undefined,
        url: url || undefined // context enrichment (what URL the tab shows)
      }
    })
    .catch(() => {});
  maybeCapture(); // frame on navigation / tab change (throttled ≤1/sec)
}

// Focus/select a tab → tab_activated (with the URL now showing).
chrome.tabs.onActivated.addListener((info) => recordSwEvent("tab_activated", info.tabId));
// Open a tab → tab_opened.
chrome.tabs.onCreated.addListener((tab) =>
  recordSwEvent("tab_opened", tab.id, { url: tab.url || tab.pendingUrl })
);
// Close a tab → tab_closed.
chrome.tabs.onRemoved.addListener((tabId) => recordSwEvent("tab_closed", tabId, { url: null }));
// URL change in a tab (address bar, link, redirect, SPA history) → navigate.
// This is what captures "the current state of the URL" as it changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) recordSwEvent("navigate", tabId, { url: changeInfo.url });
});

// --- Init ---

// Reload the created-tabs set after a service-worker restart, so closing a tab
// we opened still works once Chrome has evicted and revived this worker.
loadCreatedTabs();
connectNativeHost();

// The toolbar icon opens the side panel (the Claude chat UI). With this on,
// chrome.action.onClicked no longer fires — which is why the recorder toggle
// moved to a button inside the panel (see toggleRecorder / recorder_toggle).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("sidePanel behavior", e));
