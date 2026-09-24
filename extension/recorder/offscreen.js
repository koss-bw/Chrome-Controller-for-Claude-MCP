// Offscreen buffer + mic capture + stop pipeline.
//
// Reliability (§3):
//   - behavior events: appended to IndexedDB as they arrive (100%, local).
//   - audio: MediaRecorder timeslice → each chunk appended to IndexedDB
//     (~90%: only the final un-flushed slice is at risk on a crash).
//   - transcript: produced at stop from the saved audio (needs internet;
//     never blocks the bundle).
//
// The service worker forwards behavior events here and sends start/stop
// commands. This document owns the durable state so it survives SW eviction.
//
// NEEDS LIVE TESTING (Chrome): mic permission, MediaRecorder, IndexedDB.

import { transcribe } from "./transcribe.js";
import {
  newTrace,
  segmentsToCognitive,
  cursorToTrack,
  imagesToTrack,
  SCHEMA_VERSION
} from "./schema.js";

const AUDIO_TIMESLICE_MS = 3000; // flush an audio chunk to disk every 3s
const WARMUP_MS = 2500; // hold "ready" until the mic input settles (muffled start)

let db = null;
let mediaRecorder = null;
let micStream = null;
let session = null; // { recording_id, started_at, audioStartedAt, apiKey, url0 }

// ---- IndexedDB (durable buffer) -------------------------------------------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ocic-recorder", 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("events"))
        d.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("audio"))
        d.createObjectStore("audio", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("sessions"))
        d.createObjectStore("sessions", { keyPath: "recording_id" });
      if (!d.objectStoreNames.contains("cursor"))
        d.createObjectStore("cursor", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("images"))
        d.createObjectStore("images", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function put(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).add(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function getAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function clearStore(store) {
  return new Promise((resolve) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    tx.oncomplete = resolve;
  });
}
function patchSession(recording_id, patch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const get = store.get(recording_id);
    get.onsuccess = () => {
      const rec = get.result;
      if (rec) {
        Object.assign(rec, patch);
        store.put(rec);
      }
      resolve(!!rec);
    };
    get.onerror = () => reject(get.error);
  });
}

// ---- lifecycle -------------------------------------------------------------
async function startRecording(cmd) {
  // NEVER clobber a recording in progress. If the service worker lost track of
  // us (MV3 eviction wiped its globals) and asks to start again, refuse and
  // report the live session so the SW can adopt it instead. Without this
  // guard, the clearStore calls below silently destroyed in-flight demos.
  if (session) {
    return {
      ok: false,
      already: true,
      session: { recording_id: session.recording_id, started_at: session.started_at }
    };
  }
  db = db || (await openDb());
  await clearStore("events");
  await clearStore("audio");
  await clearStore("cursor");
  await clearStore("images");
  session = {
    recording_id: cmd.recording_id,
    started_at: cmd.started_at, // epoch ms — shared clock zero
    audioStartedAt: null,
    apiKey: cmd.apiKey,
    url0: cmd.url0 || null
  };

  // Mic → MediaRecorder → audio chunks to IndexedDB.
  // An offscreen document CANNOT show a permission prompt, so the mic grant
  // must already exist (granted via the Options page). If it doesn't, fail
  // with a clear message the service worker surfaces to the operator.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    session = null;
    const msg =
      e && e.name === "NotAllowedError"
        ? "Microphone permission not granted. Open the extension Options and click Enable microphone."
        : `Microphone error: ${e && e.message}`;
    return { ok: false, error: msg };
  }
  mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
  session.audioStartedAt = Date.now();
  mediaRecorder.ondataavailable = async (e) => {
    if (e.data && e.data.size) {
      const buf = await e.data.arrayBuffer();
      await put("audio", { bytes: buf, at: Date.now() });
    }
  };
  mediaRecorder.start(AUDIO_TIMESLICE_MS);
  // Warm-up: the first couple of seconds of mic audio are often muffled while
  // the input settles. Hold the "ready" reply until then, and set the trace
  // zero to the post-warm-up moment, so the operator isn't cued to talk early
  // and the clock starts on clean audio. (The SW shows REC only after this
  // reply, and behavior capture starts then too, so no events land in warm-up.)
  await new Promise((r) => setTimeout(r, WARMUP_MS));
  session.started_at = Date.now();
  return { ok: true };
}

async function addEvent(evt) {
  if (!session) return;
  // Convert epoch to ms-since-start (the shared clock) at ingest.
  const e = { ...evt };
  delete e.__ocic;
  e.t = evt.t - session.started_at;
  await put("events", e);
}

// Raw cursor points arrive in batches; stored as-is (epoch t), converted to
// the shared clock at stop.
async function addCursor(points) {
  if (!session || !points || !points.length) return;
  await put("cursor", { points });
}

// Downscale a captured frame to 240p JPEG (small enough to keep in IndexedDB
// for the viewer). Runs here because the offscreen document has canvas + Image;
// the service worker does not. Returns { dataUrl, w, h }.
function resize240(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const h = 240;
      const w = Math.max(1, Math.round(img.width * (h / img.height)));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: c.toDataURL("image/jpeg", 0.6), w, h });
    };
    img.onerror = () => resolve({ dataUrl, w: 0, h: 0 });
    img.src = dataUrl;
  });
}

// A captured frame: resize, store (blob-as-dataURL + ref + t) for the viewer,
// and return the resized dataURL so the SW can write the file to disk.
async function addImage(msg) {
  if (!session) return { ok: false };
  const { dataUrl, w, h } = await resize240(msg.dataUrl);
  await put("images", { t: msg.t, ref: msg.ref, dataUrl, w, h, vw: msg.vw, vh: msg.vh });
  return { ok: true, dataUrl, w, h };
}

async function stopRecording() {
  if (!session) return { ok: false, error: "no active session" };
  const s = session;

  // Flush + stop the recorder.
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve;
      mediaRecorder.stop();
    });
  }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());

  // Assemble audio from chunks (Tier: ~90% — everything flushed is here).
  const audioRows = await getAll("audio");
  const audioBlob = new Blob(audioRows.map((r) => r.bytes), { type: "audio/webm" });

  // Track A from the durable event log (Tier: 100%).
  const eventRows = await getAll("events");
  const trace = newTrace(s.started_at, { recording_id: s.recording_id, url0: s.url0 });
  trace.behavior = eventRows.sort((a, b) => a.t - b.t);
  // Track C: the raw cursor trajectory, flattened from batches, on the clock.
  const cursorRows = await getAll("cursor");
  trace.cursor = cursorToTrack(cursorRows.flatMap((r) => r.points || []), s.started_at);
  // Track D: frame references into images/ (the files are already on disk).
  const imageRows = await getAll("images");
  trace.images = imagesToTrack(imageRows, s.started_at);
  trace.ended_at = Date.now();

  // Track B: transcribe (Tier: reliable-if-internet; never blocks the bundle).
  let transcriptStatus = "ok";
  try {
    if (audioBlob.size > 0) {
      const r = await transcribe(audioBlob, s.apiKey);
      trace.cognitive = segmentsToCognitive(r.segments, s.audioStartedAt, s.started_at);
    }
  } catch (err) {
    transcriptStatus = `deferred: ${err.message}`;
    // Audio is saved; transcription can be retried later. Bundle still ships.
  }

  const bundle = {
    recording_id: s.recording_id,
    schema: SCHEMA_VERSION,
    trace,
    audio: audioBlob, // handed to the SW → native host for disk write
    transcriptStatus,
    summary: buildSummary(trace)
  };

  // Persist a session record for the sessions viewer (progressive disclosure).
  // The full trace (text, small) is kept so the viewer can drill from metadata
  // into the two tracks and per-action anchors. Audio (large) stays on disk.
  await put("sessions", {
    recording_id: s.recording_id,
    started_at: s.started_at,
    ended_at: trace.ended_at,
    url0: s.url0,
    events: trace.behavior.length,
    utterances: trace.cognitive.length,
    transcriptStatus,
    trace,
    audio: audioBlob, // kept for playback in the Options viewer
    // 240p frames (dataURL) on the shared clock — the viewer can't read the
    // on-disk images/ dir, so it shows these; the agent uses the disk files.
    images: imageRows.map((r) => ({
      t: r.t - s.started_at,
      ref: r.ref,
      dataUrl: r.dataUrl,
      w: r.w,
      h: r.h,
      vw: r.vw,
      vh: r.vh
    }))
  });

  session = null;
  return { ok: true, bundle };
}

function buildSummary(trace) {
  const dur = Math.round(((trace.ended_at || 0) - trace.started_at) / 1000);
  const tabs = new Set(trace.behavior.map((e) => e.tab)).size;
  const host = (() => {
    try { return new URL(trace.url0).host; } catch { return "a site"; }
  })();
  return `Recording ready: ${dur}s across ${tabs || 1} tab(s) on ${host}.`;
}

// Copy text to the clipboard on the SW's behalf (the SW has no clipboard).
// Uses the textarea + execCommand pattern, which works in an offscreen
// document created with the CLIPBOARD reason + the clipboardWrite permission.
function copyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text || "";
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return { ok };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
}

// ---- message bridge with the service worker -------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__ocic_offscreen !== true) return;
  (async () => {
    try {
      if (msg.cmd === "start") sendResponse(await startRecording(msg));
      else if (msg.cmd === "event") sendResponse(await addEvent(msg.event));
      else if (msg.cmd === "cursor") sendResponse(await addCursor(msg.points));
      else if (msg.cmd === "image") sendResponse(await addImage(msg));
      else if (msg.cmd === "stop") sendResponse(await stopRecording());
      else if (msg.cmd === "copy") sendResponse(copyText(msg.text));
      else if (msg.cmd === "set_path") {
        db = db || (await openDb());
        await patchSession(msg.recording_id, { path: msg.path });
        sendResponse({ ok: true });
      } else sendResponse({ ok: false, error: "unknown cmd" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    }
  })();
  return true; // async response
});
