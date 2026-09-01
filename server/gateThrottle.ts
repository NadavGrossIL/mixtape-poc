// Per-IP backoff for the shared-secret gate — pure, parameterized, no clock and
// no server, so the thing standing between a script and APP_SECRET is testable
// (ADR 0003).
//
// Why it has to exist: the gate is a single shared secret checked before
// anything else, including the daily caps, and both spellings (`POST /gate` and
// `GET /?key=…`) were unlimited. A guessing loop cost nothing and left no mark
// except log lines nobody watches. The caps do not help — they are counted per
// identity AFTER the gate opens.
//
// The shape is attempt-count then exponential backoff rather than a flat rate
// limit, because the two populations differ enormously: a real visitor who
// mistypes the key needs two or three tries and never notices, while a guesser
// needs thousands and gets doubled into uselessness after the first handful.
// Refusals do NOT extend the block — otherwise a locked-out attacker's own
// hammering keeps a shared NAT'd office locked out, and the retry-after we
// hand back would never come true.
//
// In-memory, like the caps: it resets on redeploy, which at this scale is the
// right trade (a restart is rare, and losing a guesser's counter costs them
// only the seconds they had already burned).

interface GateThrottleLimits {
  // failures tolerated before any delay is imposed — so the first maxAttempts
  // guesses are free and the one after them waits
  maxAttempts: number;
  // failures this far apart are unrelated people, not one guessing loop; also
  // the ceiling on the backoff, so a block always has an end a human can wait
  // out
  windowMs: number;
  // the first delay, doubled per extra failure
  baseDelayMs: number;
}

interface GateVerdict {
  allowed: boolean;
  // 0 when allowed; otherwise how long until the next guess is accepted
  retryAfterMs: number;
}

interface GateEntry {
  fails: number;
  lastFailAt: number;
  blockedUntil: number;
}

// Above this many tracked IPs we sweep expired entries. The map is keyed by a
// client-influenced value (X-Forwarded-For behind a proxy), so it must not be
// allowed to grow forever; sweeping only when it is already large keeps the
// common path O(1).
const SWEEP_ABOVE = 1000;

function makeGateThrottle({ maxAttempts, windowMs, baseDelayMs }: GateThrottleLimits) {
  const entries = new Map<string, GateEntry>();

  // An entry whose last failure is older than the window is a different
  // episode: forget it rather than counting an honest typo from last week
  // towards today's lockout.
  const live = (ip: string, now: number): GateEntry | null => {
    const entry = entries.get(ip);
    if (!entry) return null;
    if (now - entry.lastFailAt >= windowMs && entry.blockedUntil <= now) {
      entries.delete(ip);
      return null;
    }
    return entry;
  };

  const sweep = (now: number) => {
    if (entries.size <= SWEEP_ABOVE) return;
    for (const [ip, entry] of entries) {
      if (now - entry.lastFailAt >= windowMs && entry.blockedUntil <= now) entries.delete(ip);
    }
  };

  return {
    // May this IP make a guess right now?
    check(ip: string, now: number): GateVerdict {
      const entry = live(ip, now);
      if (entry && entry.blockedUntil > now) {
        return { allowed: false, retryAfterMs: entry.blockedUntil - now };
      }
      return { allowed: true, retryAfterMs: 0 };
    },

    // A wrong key. The (fails - maxAttempts) exponent means the first few
    // failures cost nothing at all, and the delay only starts once the count
    // reaches what a human mistyping would no longer plausibly produce.
    fail(ip: string, now: number) {
      sweep(now);
      const entry = live(ip, now) || { fails: 0, lastFailAt: now, blockedUntil: 0 };
      entry.fails += 1;
      entry.lastFailAt = now;
      if (entry.fails >= maxAttempts) {
        const delay = baseDelayMs * 2 ** (entry.fails - maxAttempts);
        entry.blockedUntil = now + Math.min(delay, windowMs);
      }
      entries.set(ip, entry);
    },

    // The right key. Forget everything about this IP — the person who just
    // proved they know the secret must not inherit a block from whoever else
    // shares their NAT.
    succeed(ip: string, now: number) {
      entries.delete(ip);
    },

    // for tests and for reasoning about memory
    size: () => entries.size,
  };
}

export type { GateThrottleLimits, GateVerdict };
export { makeGateThrottle };
