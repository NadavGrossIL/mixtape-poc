// The gate is a single shared secret, so the only thing making a guessing loop
// expensive is this: a handful of free tries, then a doubling delay that the
// guesser cannot outrun and a mistyping human never notices — and a correct key
// clears it immediately.

import test from "node:test";
import assert from "node:assert";
import { makeGateThrottle } from "../gateThrottle.ts";

const LIMITS = { maxAttempts: 3, windowMs: 60_000, baseDelayMs: 1_000 };

test("the first maxAttempts guesses are free", () => {
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i < LIMITS.maxAttempts; i++) {
    assert.equal(t.check("1.2.3.4", 0).allowed, true, `guess ${i + 1} must be free`);
    t.fail("1.2.3.4", 0);
  }
  assert.equal(t.check("1.2.3.4", 0).allowed, false, "the next one is not");
});

test("the delay doubles per extra failure and reports a real retry-after", () => {
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i < LIMITS.maxAttempts; i++) t.fail("ip", 0); // the last one blocks
  assert.deepEqual(t.check("ip", 0), { allowed: false, retryAfterMs: 1_000 });
  assert.equal(t.check("ip", 999).allowed, false, "still blocked just before it lapses");
  assert.equal(t.check("ip", 1_000).allowed, true, "and allowed exactly when promised");

  t.fail("ip", 1_000);
  assert.equal(t.check("ip", 1_000).retryAfterMs, 2_000);
  t.fail("ip", 3_000);
  assert.equal(t.check("ip", 3_000).retryAfterMs, 4_000);
});

test("the backoff is capped at the window, so a block always ends", () => {
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i < 40; i++) t.fail("ip", i);
  const { retryAfterMs } = t.check("ip", 39);
  assert.ok(retryAfterMs > 0);
  assert.ok(
    retryAfterMs <= LIMITS.windowMs,
    `a ${retryAfterMs}ms lockout is not a wait a human can be told about`
  );
});

test("checking while blocked does not extend the block", () => {
  // Otherwise an attacker's own hammering keeps a shared office IP locked out
  // and the retry-after we handed back never comes true.
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i <= LIMITS.maxAttempts; i++) t.fail("ip", 0);
  const first = t.check("ip", 0).retryAfterMs;
  for (let i = 0; i < 50; i++) t.check("ip", 10);
  assert.equal(t.check("ip", 0).retryAfterMs, first);
});

test("a correct key clears the record immediately", () => {
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i <= LIMITS.maxAttempts; i++) t.fail("ip", 0);
  assert.equal(t.check("ip", 0).allowed, false);
  t.succeed("ip", 0);
  assert.deepEqual(t.check("ip", 0), { allowed: true, retryAfterMs: 0 });
  assert.equal(t.size(), 0, "and stops being remembered at all");
});

test("failures older than the window are a different episode", () => {
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i < LIMITS.maxAttempts - 1; i++) t.fail("ip", 0);
  // one more failure now would block; the same one a window later must not,
  // or last week's typo counts towards today's lockout
  t.fail("ip", LIMITS.windowMs);
  assert.equal(t.check("ip", LIMITS.windowMs).allowed, true, "the old typos expired");
});

test("one IP's lockout is nobody else's", () => {
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i <= LIMITS.maxAttempts; i++) t.fail("guesser", 0);
  assert.equal(t.check("guesser", 0).allowed, false);
  assert.equal(t.check("visitor", 0).allowed, true);
});

test("an unknown IP is allowed and is not remembered for asking", () => {
  const t = makeGateThrottle(LIMITS);
  assert.deepEqual(t.check("never-seen", 12_345), { allowed: true, retryAfterMs: 0 });
  assert.equal(t.size(), 0, "check() must not be a way to fill the map");
});

test("the map does not grow forever under spoofed client IPs", () => {
  // req.ip comes from X-Forwarded-For behind the proxy, so it is attacker-
  // influenced; expired entries have to be swept or this is a memory leak with
  // a public trigger.
  const t = makeGateThrottle(LIMITS);
  for (let i = 0; i < 5_000; i++) t.fail(`ip-${i}`, 0);
  assert.ok(t.size() > 0);
  t.fail("late", LIMITS.windowMs * 2);
  assert.ok(t.size() < 100, `everything stale should be gone, ${t.size()} left`);
});
