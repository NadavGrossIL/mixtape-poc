// A generate run's state moves the way App's setters used to move it: a
// start clears the last run's stage, log, seed and error; songs land by
// index in any order and holes stay holes until they arrive; a resolve
// only ticks a song that landed; every failure bumps the tick; the run's
// end leaves the error up. The step line counts a song Spotify couldn't
// find as checked, and names the seed by the server's name first.

import test from "node:test";
import assert from "node:assert";
import {
  generationIdle,
  generationRun,
  type GenerationState,
} from "../../client/src/generationRun.ts";

const loading = (over: Partial<GenerationState> = {}): GenerationState => ({
  ...generationIdle,
  loading: true,
  ...over,
});

// ── the reducer ──

test("started resets the stage, log and error, and keeps the tick", () => {
  const before: GenerationState = {
    loading: false,
    stage: "resolving",
    logTracks: [{ artist: "a", title: "t", resolved: true }],
    error: { message: "x", detail: "d", booked: true },
    errorTick: 4,
  };
  assert.deepStrictEqual(generationRun(before, { type: "started" }), {
    ...generationIdle,
    loading: true,
    errorTick: 4,
  });
});

test("seeding sets the stage", () => {
  const s = generationRun(loading(), { type: "seeding" });
  assert.strictEqual(s.stage, "seeding");
});

test("stage sets the stage, and the same stage twice is the same state", () => {
  const s = generationRun(loading(), { type: "stage", stage: "curating" });
  assert.strictEqual(s.stage, "curating");
  assert.strictEqual(generationRun(s, { type: "stage", stage: "curating" }), s);
});

test("track writes by index out of order and keeps the holes", () => {
  let s = generationRun(loading(), { type: "track", index: 3, artist: "d", title: "4" });
  s = generationRun(s, { type: "track", index: 1, artist: "b", title: "2" });
  assert.strictEqual(s.logTracks.length, 4);
  assert.strictEqual(s.logTracks[0], undefined);
  assert.strictEqual(s.logTracks[2], undefined);
  assert.deepStrictEqual(s.logTracks[1], { artist: "b", title: "2" });
  assert.deepStrictEqual(s.logTracks[3], { artist: "d", title: "4" });
});

test("track does not mutate the previous log", () => {
  const before = loading({ logTracks: [{ artist: "a", title: "1" }] });
  generationRun(before, { type: "track", index: 1, artist: "b", title: "2" });
  assert.strictEqual(before.logTracks.length, 1);
});

test("resolved on an empty slot changes nothing", () => {
  const before = loading({ logTracks: [{ artist: "a", title: "1" }] });
  const after = generationRun(before, { type: "resolved", index: 5, resolved: true });
  assert.deepStrictEqual(after.logTracks, before.logTracks);
});

test("resolved on a filled slot merges the flag", () => {
  const before = loading({ logTracks: [{ artist: "a", title: "1" }, { artist: "b", title: "2" }] });
  const after = generationRun(before, { type: "resolved", index: 1, resolved: false });
  assert.deepStrictEqual(after.logTracks, [
    { artist: "a", title: "1" },
    { artist: "b", title: "2", resolved: false },
  ]);
});

test("failed sets the error and bumps the tick, even for the same line twice", () => {
  const error = { message: "that's it for today", detail: null, booked: true };
  const once = generationRun(loading(), { type: "failed", error });
  const twice = generationRun(once, { type: "failed", error });
  assert.deepStrictEqual(once.error, error);
  assert.strictEqual(once.errorTick, 1);
  assert.strictEqual(twice.errorTick, 2);
});

test("a cap fails booked; an offline, dropped, plain or fault failure does not", () => {
  const cap = generationRun(loading(), {
    type: "failed",
    error: { message: "that's it for today", detail: null, booked: true },
  });
  assert.strictEqual(cap.error?.booked, true);
  for (const message of ["you look offline", "the connection dropped", "too long", "dropped the needle"]) {
    const s = generationRun(loading(), { type: "failed", error: { message, detail: null, booked: false } });
    assert.strictEqual(s.error?.booked, false);
  }
});

test("finished clears loading and keeps the error, stage and log", () => {
  const error = { message: "x", detail: null, booked: false };
  const before = loading({ stage: "resolving", logTracks: [{ artist: "a", title: "1" }], error, errorTick: 1 });
  assert.deepStrictEqual(generationRun(before, { type: "finished" }), { ...before, loading: false });
});
