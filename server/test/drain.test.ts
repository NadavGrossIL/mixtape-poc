// A redeploy must wait for in-flight curator streams (already charged to the
// visitor's cap) and must NOT wait for a stream that never ends: the drain
// returns the moment the count hits zero, and returns anyway at the ceiling.
// Time is injected, so 25 s of waiting costs the suite nothing.

import test from "node:test";
import assert from "node:assert";
import { drain, DEFAULT_POLL_MS } from "../drain.ts";

// A fake clock whose `sleep` advances `now` — the drain's own polling drives
// time forward, and the test reads off how far it went.
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

test("nothing open: returns at once without sleeping", async () => {
  const clock = fakeClock();
  const r = await drain({ openStreams: () => 0, maxWaitMs: 25_000, ...clock });
  assert.deepEqual(r, { reason: "drained", waitedMs: 0, left: 0 });
  assert.deepEqual(clock.sleeps, [], "no poll when there is nothing to wait for");
});

test("waits while streams are open and returns when they finish", async () => {
  const clock = fakeClock();
  let open = 2;
  const r = await drain({
    openStreams: () => {
      // finish one per poll
      const n = open;
      open = Math.max(0, open - 1);
      return n;
    },
    maxWaitMs: 25_000,
    pollMs: 100,
    ...clock,
  });
  assert.equal(r.reason, "drained");
  assert.equal(r.left, 0);
  assert.equal(r.waitedMs, 200, "two polls of 100ms before the count hit zero");
});

test("gives up at the ceiling with the stragglers reported", async () => {
  const clock = fakeClock();
  const r = await drain({ openStreams: () => 3, maxWaitMs: 25_000, pollMs: 1_000, ...clock });
  assert.equal(r.reason, "timeout");
  assert.equal(r.left, 3);
  assert.equal(r.waitedMs, 25_000, "never overshoots the ceiling");
  assert.equal(clock.sleeps.length, 25);
});

test("the last sleep is clamped so the ceiling is exact, not a poll late", async () => {
  const clock = fakeClock();
  const r = await drain({ openStreams: () => 1, maxWaitMs: 1_050, pollMs: 500, ...clock });
  assert.deepEqual(clock.sleeps, [500, 500, 50]);
  assert.equal(r.waitedMs, 1_050);
  assert.equal(r.reason, "timeout");
});

test("a zero ceiling means one look and no waiting", async () => {
  const clock = fakeClock();
  const r = await drain({ openStreams: () => 1, maxWaitMs: 0, ...clock });
  assert.equal(r.reason, "timeout");
  assert.equal(r.left, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("a negative count (a decrement bug) still counts as drained, never hangs", async () => {
  const clock = fakeClock();
  const r = await drain({ openStreams: () => -1, maxWaitMs: 25_000, ...clock });
  assert.equal(r.reason, "drained");
  assert.equal(r.left, 0);
});

test("the default poll interval is used when none is given", async () => {
  const clock = fakeClock();
  let polls = 0;
  await drain({ openStreams: () => (polls++ < 1 ? 1 : 0), maxWaitMs: 25_000, ...clock });
  assert.deepEqual(clock.sleeps, [DEFAULT_POLL_MS]);
});

test("defaults to the real clock and finishes promptly on a short ceiling", async () => {
  // No injected time: guards the default wiring (Date.now + setTimeout).
  const started = Date.now();
  const r = await drain({ openStreams: () => 1, maxWaitMs: 20, pollMs: 5 });
  assert.equal(r.reason, "timeout");
  assert.ok(Date.now() - started < 2_000, "must not hang on the real clock");
});
