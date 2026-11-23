// jamMode: jam runs only behind JAM_MODE=1, generate takes the mode from its
// body, adjust takes it from the card (never the body), and every refusal is
// an error the route answers with 400 before anything is charged.

import test from "node:test";
import assert from "node:assert";
import { adjustMode, generateMode, jamEnabled } from "../jamMode.ts";

test("jamEnabled: only the exact string 1", () => {
  assert.equal(jamEnabled("1"), true);
  for (const v of [undefined, "", "0", "true", " 1", "yes"]) assert.equal(jamEnabled(v), false, String(v));
});

test("generateMode: missing or mix is a mixtape, whatever the flag", () => {
  for (const enabled of [true, false]) {
    assert.equal(generateMode(undefined, enabled), "mix");
    assert.equal(generateMode("mix", enabled), "mix");
  }
});

test("generateMode: jam needs the flag", () => {
  assert.equal(generateMode("jam", true), "jam");
  assert.ok(typeof generateMode("jam", false) === "object" && "error" in (generateMode("jam", false) as object));
});

test("generateMode: anything else is an error", () => {
  for (const v of ["foo", "", null, 1, { mode: "jam" }, "JAM"]) {
    const m = generateMode(v, true);
    assert.ok(typeof m === "object" && typeof m.error === "string", JSON.stringify(v));
  }
});

test("adjustMode: the card's mode, missing = mix", () => {
  assert.equal(adjustMode({ mode: "jam" }, true), "jam");
  assert.equal(adjustMode({ mode: "mix" }, true), "mix");
  assert.equal(adjustMode({}, true), "mix");
  assert.equal(adjustMode({}, false), "mix");
});

test("adjustMode: a jam card with the flag off is an error", () => {
  const m = adjustMode({ mode: "jam" }, false);
  assert.ok(typeof m === "object" && typeof m.error === "string");
});

// ── invite link (JAM_INVITE): jam for browsers that opened the link only ──

import { jamInviteToken, jamAllowed, MIN_INVITE } from "../jamMode.ts";

const fakeHash = (s: string) => `h(${s})`;
const eq = (a: string, b: string) => a === b;
const SECRET = "x".repeat(MIN_INVITE);

test("jamInviteToken: off when unset or too short, a salted hash otherwise", () => {
  assert.equal(jamInviteToken(undefined, fakeHash), null);
  assert.equal(jamInviteToken("", fakeHash), null);
  assert.equal(jamInviteToken("x".repeat(MIN_INVITE - 1), fakeHash), null);
  const token = jamInviteToken(SECRET, fakeHash);
  assert.equal(token, `h(mixtape-jam-invite:${SECRET})`);
  // the cookie never holds the secret itself
  assert.notEqual(token, SECRET);
});

test("jamAllowed: JAM_MODE=1 lets everyone in, cookie or not", () => {
  assert.equal(jamAllowed({ everyone: true, token: null, cookie: null }, eq), true);
});

test("jamAllowed: with an invite, only the matching cookie gets in", () => {
  const token = jamInviteToken(SECRET, fakeHash)!;
  assert.equal(jamAllowed({ everyone: false, token, cookie: token }, eq), true);
  assert.equal(jamAllowed({ everyone: false, token, cookie: null }, eq), false);
  assert.equal(jamAllowed({ everyone: false, token, cookie: "wrong" }, eq), false);
  // the raw secret in the cookie is not the token
  assert.equal(jamAllowed({ everyone: false, token, cookie: SECRET }, eq), false);
});

test("jamAllowed: no invite and no JAM_MODE means nobody, whatever the cookie says", () => {
  assert.equal(jamAllowed({ everyone: false, token: null, cookie: "anything" }, eq), false);
});
