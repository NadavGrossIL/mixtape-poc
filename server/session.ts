// Signed per-browser identity cookie for multi-user Spotify login.
//
// The cookie value is `<base64url(userId)>.<hmac>` — the Spotify user id in
// the clear (it is not a secret) plus an HMAC so a visitor cannot claim
// someone else's id. Pure and parameterized by key so the tamper cases are
// testable without a server.

import crypto from "node:crypto";

function hmac(payload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function signUser(userId: string, key: string): string {
  const payload = Buffer.from(userId, "utf8").toString("base64url");
  return `${payload}.${hmac(payload, key)}`;
}

function verifyUser(cookieValue: unknown, key: string): string | null {
  const parts = String(cookieValue || "").split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  const expected = Buffer.from(hmac(payload, key));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    return null;
  }
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

export { signUser, verifyUser, newAnonId, isAnon };
