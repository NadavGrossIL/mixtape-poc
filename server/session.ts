// Signed per-browser identity cookie for multi-user Spotify login.
//
// The cookie value is `<base64url(userId)>.<iat>.<hmac>` — the Spotify user id
// in the clear (it is not a secret), the issue time in ms since epoch, and an
// HMAC over BOTH of them joined, so a visitor can neither claim someone else's
// id nor edit their own timestamp. Pure and parameterized by key, and by `now`
// where time matters, so the tamper and expiry cases are testable without a
// server and without faking timers.
//
// The iat is what stops a leaked cookie being a permanent credential. It used
// to sign the id alone against a one-year cookie: nothing in the value said
// when it was minted, so the only revocation was rotating the key for
// everybody. Now it ages out on its own after SESSION_MAX_AGE_MS.
//
// Cookies in the old 2-part shape are rejected outright. That costs one
// re-login per browser at deploy, and that cost IS the fix — a value carrying
// no issue time can never be aged out, so honouring it would leave every
// pre-existing cookie immortal and revoke nothing.

import crypto from "node:crypto";

// How long a signed cookie stays good. Exported so the Set-Cookie Max-Age in
// index.ts tracks the signed window instead of drifting from it — a cookie the
// browser keeps for a year but the server stopped honouring reads to the user
// as a random logout.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// An iat slightly in the future is a clock, not an attack: the signer and the
// verifier are one process today but need not stay that way, and container
// clocks drift between NTP syncs. A couple of minutes covers that. Anything
// further ahead is a forged timestamp buying itself extra life, and is
// rejected — the skew is deliberately far smaller than the max age, so it can
// never meaningfully extend a session.
const CLOCK_SKEW_MS = 2 * 60 * 1000;

function hmac(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function signUser(userId: string, key: string, now: number = Date.now()): string {
  const payload = Buffer.from(userId, "utf8").toString("base64url");
  const iat = String(Math.floor(now));
  // The MAC covers payload AND iat — signing the payload alone would let an
  // attacker slide the timestamp forward and keep a stolen cookie alive.
  return `${payload}.${iat}.${hmac(`${payload}.${iat}`, key)}`;
}

function verifyUser(
  cookieValue: unknown,
  key: string,
  opts: { maxAgeMs?: number; now?: number } = {}
): string | null {
  const parts = String(cookieValue || "").split(".");
  // 3 parts only: the legacy 2-part cookie lands here and is refused.
  if (parts.length !== 3) return null;
  const [payload, iatRaw, mac] = parts as [string, string, string];
  const expected = Buffer.from(hmac(`${payload}.${iatRaw}`, key));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    return null;
  }

  // Past the MAC check the iat is ours, but parse it defensively anyway —
  // garbage in, null out, never a throw, is the rule for the whole module.
  const iat = Number(iatRaw);
  if (!iatRaw || !Number.isFinite(iat) || iat < 0) return null;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? SESSION_MAX_AGE_MS;
  if (iat > now + CLOCK_SKEW_MS) return null; // future-dated beyond drift
  if (now - iat > maxAgeMs) return null; // expired; exactly at the age is still good

  const userId = Buffer.from(payload, "base64url").toString("utf8");
  return userId.length > 0 ? userId : null;
}

// Visitors who never connect a Spotify account still need an identity —
// for the daily caps and the usage ledger. Same signed cookie, a random
// id under the `anon:` prefix so it can never collide with a Spotify id.
const ANON_PREFIX = "anon:";

function newAnonId(): string {
  return ANON_PREFIX + crypto.randomBytes(8).toString("hex");
}

function isAnon(userId: string | null | undefined): boolean {
  return typeof userId === "string" && userId.startsWith(ANON_PREFIX);
}

export { signUser, verifyUser, newAnonId, isAnon, SESSION_MAX_AGE_MS };
