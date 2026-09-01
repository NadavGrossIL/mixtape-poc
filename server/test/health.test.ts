// /healthz is what pages a human at 3am, so two properties have to hold: it
// fails for exactly the misconfigurations a human can fix, and it never fails
// for a missing host account (degraded, not down). The uptime it reports must
// always be a non-negative integer, whatever the clock hands it. And the body
// an anonymous caller gets must carry the verdict and nothing else — the
// endpoint is unauthenticated by design.

import test from "node:test";
import assert from "node:assert";
import { healthBody, publicHealthBody, type HealthChecks } from "../health.ts";

const ALL_GOOD: HealthChecks = {
  spotifyCredentials: true,
  anthropicKey: true,
  ownerToken: true,
  hostAccount: true,
};

test("every check passing is ok", () => {
  const body = healthBody(ALL_GOOD, 1);
  assert.equal(body.ok, true);
  assert.deepEqual(body.checks, ALL_GOOD);
});

// One at a time, so a check that stopped being consulted can't hide behind
// another one still failing.
for (const check of ["spotifyCredentials", "anthropicKey", "ownerToken"] as const) {
  test(`${check} failing alone makes it not ok`, () => {
    const body = healthBody({ ...ALL_GOOD, [check]: false }, 1);
    assert.equal(body.ok, false, `${check} must fail the endpoint`);
    assert.equal(body.checks[check], false, "the failing check is still reported");
  });
}

test("hostAccount failing alone is reported but stays ok", () => {
  const body = healthBody({ ...ALL_GOOD, hostAccount: false }, 1);
  assert.equal(body.ok, true, "no host account is degraded, not down");
  assert.equal(body.checks.hostAccount, false);
});

test("every check failing is not ok", () => {
  const body = healthBody(
    { spotifyCredentials: false, anthropicKey: false, ownerToken: false, hostAccount: false },
    1
  );
  assert.equal(body.ok, false);
});

test("uptime is floored, never rounded up", () => {
  assert.equal(healthBody(ALL_GOOD, 0).uptime, 0);
  assert.equal(healthBody(ALL_GOOD, 12.9).uptime, 12);
  assert.equal(healthBody(ALL_GOOD, 3600.0001).uptime, 3600);
});

test("a nonsense clock reads as 0, not NaN or a negative", () => {
  for (const bad of [-1, -0.5, NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    const { uptime } = healthBody(ALL_GOOD, bad);
    assert.equal(uptime, 0, `${bad} must clamp to 0`);
  }
});

test("uptime is always an integer", () => {
  for (const n of [0, 1, 12.9, -3, NaN, 3600.0001]) {
    assert.ok(Number.isInteger(healthBody(ALL_GOOD, n).uptime), `${n} must yield an integer`);
  }
});

test("the body carries exactly ok, uptime and checks", () => {
  assert.deepEqual(Object.keys(healthBody(ALL_GOOD, 1)).sort(), ["checks", "ok", "uptime"]);
});

// ── what a stranger sees ─────────────────────────────────────

test("the public body is the verdict and nothing else", () => {
  const full = healthBody(ALL_GOOD, 12345);
  assert.deepEqual(publicHealthBody(full), { ok: true });
  assert.deepEqual(Object.keys(publicHealthBody(full)), ["ok"]);
});

test("the public body never leaks checks or uptime, whatever the state", () => {
  // Adversarial: the interesting cases for a stranger are exactly the broken
  // ones — which credential is missing, and how recently we restarted (the
  // daily caps are in memory, so a fresh uptime means a fresh guest budget).
  const states: HealthChecks[] = [
    ALL_GOOD,
    { ...ALL_GOOD, spotifyCredentials: false },
    { ...ALL_GOOD, anthropicKey: false },
    { ...ALL_GOOD, ownerToken: false },
    { ...ALL_GOOD, hostAccount: false },
    { spotifyCredentials: false, anthropicKey: false, ownerToken: false, hostAccount: false },
  ];
  for (const checks of states) {
    for (const uptime of [0, 3, 86_400]) {
      const body = publicHealthBody(healthBody(checks, uptime));
      const seen = JSON.stringify(body);
      assert.deepEqual(Object.keys(body), ["ok"], `leaked a field: ${seen}`);
      assert.ok(!seen.includes("uptime"), `leaked uptime: ${seen}`);
      assert.ok(!seen.includes("check"), `leaked checks: ${seen}`);
      assert.ok(!/host|anthropic|spotify|token/i.test(seen), `leaked config: ${seen}`);
    }
  }
});

test("the public body keeps the monitor's signal — the ok bit is unchanged", () => {
  for (const checks of [ALL_GOOD, { ...ALL_GOOD, ownerToken: false }]) {
    const full = healthBody(checks, 1);
    assert.equal(publicHealthBody(full).ok, full.ok);
  }
});

test("reducing the body does not mutate the full one the owner gets", () => {
  const full = healthBody(ALL_GOOD, 42);
  publicHealthBody(full);
  assert.deepEqual(Object.keys(full).sort(), ["checks", "ok", "uptime"]);
  assert.equal(full.uptime, 42);
});
