// The signed session cookie and the token-store shapes — identity must fail
// closed: a forged or tampered cookie is nobody, not somebody.

import test from "node:test";
import assert from "node:assert";
import { signUser, verifyUser, SESSION_MAX_AGE_MS } from "../session.ts";
import { parseTokenStore } from "../spotify.ts";

const KEY = "test-signing-key";

// ── signUser / verifyUser ────────────────────────────────────

test("sign → verify roundtrips the user id, unicode included", () => {
  for (const id of ["nadav", "31k2j...spotify", "משתמש", "a"]) {
    assert.strictEqual(verifyUser(signUser(id, KEY), KEY), id);
  }
});

test("a tampered payload is rejected", () => {
  const cookie = signUser("alice", KEY);
  const [payload, mac] = cookie.split(".") as [string, string];
  const forged = Buffer.from("mallory").toString("base64url");
  assert.strictEqual(verifyUser(`${forged}.${mac}`, KEY), null);
  // tampered mac too
  assert.strictEqual(verifyUser(`${payload}.${mac.slice(0, -2)}xx`, KEY), null);
});

test("a cookie signed with a different key is rejected", () => {
  assert.strictEqual(verifyUser(signUser("alice", "other-key"), KEY), null);
});

test("garbage shapes are rejected, not thrown on", () => {
  for (const junk of ["", "no-dot", "a.b.c", null, undefined, 42, "."]) {
    assert.strictEqual(verifyUser(junk as any, KEY), null);
  }
});

// ── expiry ───────────────────────────────────────────────────
//
// The cookie used to sign the user id alone against a one-year Max-Age, so a
// leaked value was a permanent credential and the only revocation was rotating
// the key for everybody. The signed iat is what makes it age out; these guard
// that it cannot be forged, slid forward, or dropped.

const T0 = 1_700_000_000_000; // fixed clock — no timers faked, `now` is a param

test("sign → verify roundtrips against an explicit clock", () => {
  const cookie = signUser("alice", KEY, T0);
  assert.strictEqual(verifyUser(cookie, KEY, { now: T0 }), "alice");
  // and a day later it is still the same session
  assert.strictEqual(verifyUser(cookie, KEY, { now: T0 + 86_400_000 }), "alice");
});

test("a cookie older than the window is rejected", () => {
  const cookie = signUser("alice", KEY, T0);
  assert.strictEqual(verifyUser(cookie, KEY, { now: T0 + SESSION_MAX_AGE_MS + 1 }), null);
  // and the window is overridable per call, which is how a shorter-lived
  // cookie would be checked without re-signing anything
  assert.strictEqual(verifyUser(cookie, KEY, { now: T0 + 1001, maxAgeMs: 1000 }), null);
});

test("exactly at the boundary is still valid; one millisecond past is not", () => {
  const cookie = signUser("alice", KEY, T0);
  assert.strictEqual(verifyUser(cookie, KEY, { now: T0 + SESSION_MAX_AGE_MS }), "alice");
  assert.strictEqual(verifyUser(cookie, KEY, { now: T0 + SESSION_MAX_AGE_MS + 1 }), null);
});

test("a future-dated cookie is rejected past the clock-skew allowance", () => {
  // a minute of drift between signer and verifier is a clock, not an attack
  assert.strictEqual(verifyUser(signUser("alice", KEY, T0 + 60_000), KEY, { now: T0 }), "alice");
  // an hour ahead is a forged timestamp buying itself extra life
  assert.strictEqual(verifyUser(signUser("alice", KEY, T0 + 3_600_000), KEY, { now: T0 }), null);
});

test("the mac covers the iat: editing the timestamp invalidates the cookie", () => {
  // the attack this closes — keep a stolen cookie alive by sliding its clock
  const [payload, , mac] = signUser("alice", KEY, T0).split(".") as [string, string, string];
  const slid = `${payload}.${T0 + SESSION_MAX_AGE_MS}.${mac}`;
  assert.strictEqual(verifyUser(slid, KEY, { now: T0 + SESSION_MAX_AGE_MS }), null);
  // an unparseable or negative iat fails closed too, never throws
  for (const iat of ["", "abc", "-1", "NaN", "1e999"]) {
    assert.strictEqual(verifyUser(`${payload}.${iat}.${mac}`, KEY, { now: T0 }), null);
  }
  // ...including when the mac over it is genuinely valid, which is the only way
  // to reach the parse itself
  for (const bogus of [NaN, -5, Infinity]) {
    assert.strictEqual(verifyUser(signUser("alice", KEY, bogus), KEY, { now: T0 }), null);
  }
});

test("the legacy 2-part cookie is rejected, on purpose", () => {
  // Deliberate: a value with no issue time can never be aged out, so honouring
  // it would leave every pre-existing cookie immortal. Costs one re-login per
  // browser at deploy.
  const payload = Buffer.from("alice").toString("base64url");
  const legacyMac = signUser("alice", KEY, T0).split(".")[2]!;
  assert.strictEqual(verifyUser(`${payload}.${legacyMac}`, KEY), null);
});

// ── parseTokenStore ──────────────────────────────────────────

test("current {users} shape passes through", () => {
  const store = { users: { alice: { access_token: "a", refresh_token: "r", expires_at: 1 } } };
  assert.deepStrictEqual(parseTokenStore(store), store);
});

test("pre-multi-user flat record becomes the owner entry", () => {
  const legacy = { access_token: "a", refresh_token: "r", expires_at: 1 };
  assert.deepStrictEqual(parseTokenStore(legacy), { users: { owner: legacy } });
});

test("garbage parses to an empty store (reads as everyone-logged-out)", () => {
  for (const junk of [null, undefined, "text", 42, [], {}, { refresh_token: 7 }]) {
    assert.deepStrictEqual(parseTokenStore(junk), { users: {} });
  }
});

// ── guest identities ─────────────────────────────────────────

import { newAnonId, isAnon } from "../session.ts";

test("guest ids are prefixed, random, and survive the cookie roundtrip", () => {
  const a = newAnonId();
  const b = newAnonId();
  assert.ok(isAnon(a));
  assert.notStrictEqual(a, b);
  assert.strictEqual(verifyUser(signUser(a, KEY), KEY), a);
});

test("a Spotify id is never a guest", () => {
  for (const id of ["nadav", "31k2jspotify", "", "anon", "owner", "host"]) {
    assert.strictEqual(isAnon(id), false);
  }
  assert.strictEqual(isAnon(null), false);
  assert.strictEqual(isAnon(undefined), false);
});
