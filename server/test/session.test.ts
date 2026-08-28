// The signed session cookie and the token-store shapes — identity must fail
// closed: a forged or tampered cookie is nobody, not somebody.

import test from "node:test";
import assert from "node:assert";
import { signUser, verifyUser } from "../session.ts";
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
