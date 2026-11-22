// A daily-cap refusal (HTTP 429). Not a failure: the server's line IS the
// message, and "try the same prompt again" would be the wrong advice.
export class CapError extends Error {
  // `detail` is the owner-only upstream message the server attaches to a
  // stream error; a 429 has none.
  detail: string | null;
  constructor(message?: string, detail: string | null = null) {
    super(message || "that’s it for today — come back tomorrow.");
    this.name = "CapError";
    this.detail = detail;
  }
}

// Spotify's app-wide daily quota, arriving mid-stream as an `error` event.
// It is a cap like the 429 above, not a fault — so it must not wear the
// "dropped the needle, try again" line, which contradicts its own detail.
// The server flags it with `quota: true`; the exact message is the fallback
// for a server that predates the flag.
const QUOTA_MESSAGE = "Spotify's daily limit for this app is used up.";
export const QUOTA_COPY = "spotify’s daily limit for this app is used up — come back tomorrow.";
export function isQuotaEvent(data: { message?: string; quota?: boolean } | null) {
  return data?.quota === true || data?.message === QUOTA_MESSAGE;
}

// The stream ended with no card and no error event: the connection was cut
// mid-run (a redeploy, a webview backgrounding the tab). Not the curator's
// fault, and "empty" is not a detail anyone can act on.
export class StreamDroppedError extends Error {
  constructor() {
    super("stream dropped");
    this.name = "StreamDroppedError";
  }
}

// The server's message IS the whole story — shown as the headline, with no
// "dropped the needle, try the same prompt again" over it. Two sources: a
// 400 that names what was wrong with the request ("that prompt is too
// long"), and an `error` event flagged `outage` (the curator is offline or
// busy — our side, not the visitor's). Both used to wear the generic retry
// line, which contradicted them. `detail` is the owner-only upstream message
// when the server sent one (a 400 has none), so the owner can still tell a
// revoked key from an empty balance without opening the log.
export class PlainError extends Error {
  detail: string | null;
  constructor(message: string, detail: string | null = null) {
    super(message);
    this.name = "PlainError";
    this.detail = detail;
  }
}

// Minimal SSE parser over a fetch ReadableStream (native only, no libraries).
// E is the caller's [event, data] tuple union for the stream being read — a
// declared contract, not something the wire can prove.
export async function readSSE<E extends [string, unknown]>(
  response: Response,
  onEvent: (...args: E) => void
) {
  // these endpoints always stream a body; a bodyless response would have
  // thrown here before the migration too
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          // per spec: strip one leading space only, join multi-line data with \n
          const value = line.slice(5);
          dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
        }
      }
      const data = dataLines.join("\n");
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        /* keep null */
      }
      // the one cast at the wire boundary: the server's events are trusted to
      // match the caller's declared union (unknown events fall through the
      // caller's if/else chains unhandled, exactly as before)
      onEvent(...([event, parsed] as E));
    }
  }
}
