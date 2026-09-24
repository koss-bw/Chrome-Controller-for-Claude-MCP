// Shared SSE framing for the panel's two backends (claude.ai and the local
// Claude Code sidecar). Framing only — each client interprets its own payloads,
// so the two backends can't drift in how they read a stream.

// Yield the raw `data:` payload of each complete SSE event.
//
// Events are separated by a blank line; a partial event at a chunk boundary
// stays buffered until the rest arrives. Only the first `data:` line of an
// event is used, matching what both backends emit.
export async function* readSseEvents(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop(); // trailing partial event stays buffered
      for (const ev of events) {
        const payload = payloadOf(ev);
        if (payload) yield payload;
      }
    }
    // A final event with no trailing blank line would otherwise be dropped.
    const tail = payloadOf(buf);
    if (tail) yield tail;
  } finally {
    // The consumer may break early (abort, message_stop); don't leave the
    // reader locked to a stream nobody will drain.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function payloadOf(event) {
  const line = event.split("\n").find((l) => l.startsWith("data:"));
  return line ? line.slice(5).trim() : "";
}
