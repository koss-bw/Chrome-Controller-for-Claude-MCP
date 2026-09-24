// Speech-to-text at the OCIC level. Runs in the offscreen document (which can
// fetch) at stop-time, over the saved audio. Batch, not streaming: v1 never
// needs live text, and a 10-min opus file (~1.8MB) is one API call under
// OpenAI's 25MB cap.
//
// Dependency-free (uses fetch + FormData, present in the offscreen document
// and in Node 18+), so it is unit-testable outside the browser.

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Validate an OpenAI key before a recording is allowed to start. A recording
 * with no usable transcript path is a poor outcome, so we fail fast up front.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function validateOpenAiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "No API key provided." };
  }
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` }
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: "Invalid API key." };
    return { ok: false, error: `OpenAI returned ${res.status}.` };
  } catch (e) {
    return { ok: false, error: `Network error reaching OpenAI: ${e.message}` };
  }
}

/**
 * Transcribe an audio Blob/Buffer with word + segment timestamps.
 * @returns {Promise<{ text, duration, words, segments }>}
 * Throws on failure so the caller can retry later (the audio is already saved).
 */
export async function transcribe(audio, apiKey, { filename = "audio.webm" } = {}) {
  const form = new FormData();
  const blob =
    audio instanceof Blob ? audio : new Blob([audio], { type: "audio/webm" });
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
    body: form
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.text || "",
    duration: data.duration ?? null,
    words: data.words || [],
    segments: data.segments || []
  };
}
