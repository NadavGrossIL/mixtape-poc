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
}

interface HealthBody {
  ok: boolean;
  uptime: number;
  checks: HealthChecks;
}

// Takes the raw `process.uptime()` float, not the clock, so the caller owns
// the only impure bit. A monitor graphing uptime must never be handed a
// `NaN` or a negative — both mean "we don't know", and the honest floor for
// "how long have we been up" is 0. Same clamp as specs/0000, same reason.
function healthBody(checks: HealthChecks, uptimeSeconds: number): HealthBody {
  const ok = checks.spotifyCredentials && checks.anthropicKey && checks.ownerToken;
  const uptime =
    Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? Math.floor(uptimeSeconds) : 0;
  return { ok, uptime, checks };
}

export type { HealthChecks, HealthBody };
export { healthBody };
