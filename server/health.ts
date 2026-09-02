// What /healthz answers, as a pure function — so the one bit that decides
// whether a monitor pages someone at 3am is testable without a server, a
// clock or a token (ADR 0003: thin route, pure module, test the module).
//
// The split that matters is between checks that FAIL the endpoint and checks
// that are merely reported. Only a human-fixable misconfiguration fails it:
// missing Spotify credentials, a missing Anthropic key, a missing owner
// token on a deployed host. Anything that clears itself (Spotify's daily
// quota) or that only degrades the product (no host account — mixtapes press
// into the owner's own library instead) is reported and forgiven, because a
// pager that fires for things nobody can fix tonight is a pager people learn
// to ignore.

interface HealthChecks {
  spotifyCredentials: boolean;
  anthropicKey: boolean;
  // The owner token powers catalog search AND the owner gate, so on a
  // deployed host its absence is an outage. Callers pass `true` for local
  // dev, where it is only a convenience.
  ownerToken: boolean;
  // Reported, never fatal: unset just means mixtapes press into the owner's
  // own account — degraded, not down.
  hostAccount: boolean;
  // Reported, never fatal: is SESSION_SECRET set, or did the signing key fall
  // through to APP_SECRET / SPOTIFY_CLIENT_SECRET / a per-boot random value
  // (index.ts, SESSION_KEY)? The app works either way, which is exactly why
  // nobody notices — the owner reads it here instead of grepping the log.
  sessionSecret: boolean;
}

interface HealthBody {
  ok: boolean;
  uptime: number;
  checks: HealthChecks;
  // The caller's address as Express resolved it through `trust proxy`. The
  // owner curls this from outside to check the hop count: a `100.x` or other
  // private address here means the proxy is more hops than `trust proxy` was
  // told, every request is being attributed to the proxy, and the per-IP
  // caps have collapsed into one shared counter. Owner-only like the rest.
  ip: string | null;
}

// Takes the raw `process.uptime()` float, not the clock, so the caller owns
// the only impure bit. A monitor graphing uptime must never be handed a
// `NaN` or a negative — both mean "we don't know", and the honest floor for
// "how long have we been up" is 0. Same clamp as specs/0000, same reason.
// `ip` is passed in the same spirit: the route reads `req.ip`, this decides
// what it looks like in the body (an unset one is `null`, never `undefined`,
// so the key is always present and a diff against yesterday's reading is
// honest).
function healthBody(
  checks: HealthChecks,
  uptimeSeconds: number,
  ip: string | undefined | null = null
): HealthBody {
  const ok = checks.spotifyCredentials && checks.anthropicKey && checks.ownerToken;
  const uptime =
    Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? Math.floor(uptimeSeconds) : 0;
  return { ok, uptime, checks, ip: ip || null };
}

// What a stranger is allowed to see. The status code (200/503) is the whole
// monitor signal, so nothing a pinger relies on is lost — but the body is not
// nothing to an attacker: `checks` enumerates which of our credentials are
// configured, and `uptime` is worse than it looks. The daily caps are held in
// memory (caps.ts) and reset on restart, so a low uptime is a public
// announcement that today's guest budget just went fresh — watch for a
// redeploy, spend it again. `ip` is the same story from the other side — it
// tells a stranger what our proxy topology looks like. Owner-only, all of
// them; everyone else gets the one bit they came for.
function publicHealthBody(body: HealthBody): { ok: boolean } {
  return { ok: body.ok };
}

export type { HealthChecks, HealthBody };
export { healthBody, publicHealthBody };
