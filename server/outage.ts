// Upstream failure, classified — so the visitor's copy and the health check
// both say what actually happened instead of "Generation failed."
//
// Why it exists: on 2026-09-02 every generation, local and deployed, failed
// with Anthropic's "credit balance is too low" while /healthz stayed green
// (it only checked that the key was PRESENT) and the visitor was told to
// "try the same prompt again", which cannot help. Two lessons, one module:
//
//  1. An Anthropic auth or billing failure is exactly what /healthz is for —
//     "only what a human has to fix" (index.ts, the health comment) — so it
//     must turn the check red and page the owner, unlike Spotify's daily
//     quota, which clears itself and stays out of the health check.
//  2. The visitor should be told whose problem it is. "Our side, not yours"
//     for a dead key; "busy, try in a minute" for a rate limit or an
//     overloaded model. Neither is "try the same prompt again".
//
// Pure: takes the error's shape, not the SDK class (index.ts decides whether
// the error came from the Anthropic client; Spotify errors carry `status`
// too and must not be mistaken for it). ADR 0003: thin route, pure module.

type UpstreamKind =
  | "anthropic-auth" // 401/403: the key is wrong or revoked — persistent
  | "anthropic-billing" // 400 "credit balance" — persistent until someone pays
  | "anthropic-busy" // 429 / 5xx / 529: transient, retry in a bit
  | null; // not an Anthropic failure we recognise

interface Classified {
  kind: UpstreamKind;
  // What the visitor sees. Lowercase, in the app's voice.
  message: string | null;
  // Persistent failures are remembered (makeOutageTracker) and fail /healthz;
  // transient ones are not.
  persistent: boolean;
}

interface ErrorShape {
  status?: number;
  message?: string;
}

const OFFLINE_COPY = "the curator is offline right now — our side, not yours. try again later.";
const BUSY_COPY = "the curator is busy right now — try again in a minute.";

function classifyUpstream(err: ErrorShape | null | undefined, fromAnthropic: boolean): Classified {
  if (!fromAnthropic || !err) return { kind: null, message: null, persistent: false };
  const status = err.status ?? 0;
  const text = err.message ?? "";
  if (status === 401 || status === 403) {
    return { kind: "anthropic-auth", message: OFFLINE_COPY, persistent: true };
  }
  if (status === 400 && /credit balance|billing|purchase credits/i.test(text)) {
    return { kind: "anthropic-billing", message: OFFLINE_COPY, persistent: true };
  }
  if (status === 429 || status >= 500) {
    return { kind: "anthropic-busy", message: BUSY_COPY, persistent: false };
  }
  return { kind: null, message: null, persistent: false };
}

// Remembers the last persistent failure until a run succeeds. In memory, like
// the caps: a restart forgets it, and the next failed run remembers it again
// within one request, so the monitor is at most one visitor behind.
function makeOutageTracker() {
  let current: { kind: UpstreamKind; since: number; message: string } | null = null;
  return {
    // Call from every upstream catch. Returns the classification so the route
    // can pick the visitor's copy from the same verdict.
    note(err: ErrorShape | null | undefined, fromAnthropic: boolean, now = Date.now()): Classified {
      const c = classifyUpstream(err, fromAnthropic);
      if (c.persistent && c.kind) current = { kind: c.kind, since: now, message: err?.message ?? "" };
      return c;
    },
    // Call after a run that reached the model and came back — the key works.
    clear() {
      current = null;
    },
    // For /healthz: null when the curator is believed reachable.
    current() {
      return current;
    },
  };
}

export type { UpstreamKind, Classified, ErrorShape };
export { classifyUpstream, makeOutageTracker, OFFLINE_COPY, BUSY_COPY };
