// /healthz is what pages a human at 3am, so two properties have to hold: it
// fails for exactly the misconfigurations a human can fix, and it never fails
// for a missing host account (degraded, not down). The uptime it reports must
// always be a non-negative integer, whatever the clock hands it.

import test from "node:test";
import assert from "node:assert";
import { healthBody, type HealthChecks } from "../health.ts";

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
