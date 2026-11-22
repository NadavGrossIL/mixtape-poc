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
  loadingStep,
  type GenerationState,
} from "../../client/src/generationRun.ts";

const loading = (over: Partial<GenerationState> = {}): GenerationState => ({
  ...generationIdle,
  loading: true,
  ...over,
});

// ── the reducer ──

test("started resets the stage, log, seed and error, and keeps the tick", () => {
  const before: GenerationState = {
    loading: false,
    stage: "resolving",
    logTracks: [{ artist: "a", title: "t", resolved: true }],
    seedLog: { name: "mine" },
    error: { message: "x", detail: "d", booked: true },
    errorTick: 4,
  };
  assert.deepStrictEqual(generationRun(before, { type: "started" }), {
    ...generationIdle,
    loading: true,
    errorTick: 4,
  });
});

test("seeding sets the stage and the seed's name", () => {
  const s = generationRun(loading(), { type: "seeding", name: "Road trip" });
  assert.strictEqual(s.stage, "seeding");
  assert.deepStrictEqual(s.seedLog, { name: "Road trip" });
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

// ── loadingStep ──

test("no seed: step 1 of 2, picking the songs", () => {
  assert.deepStrictEqual(loadingStep(null, [], null, null), { n: 1, label: "picking the songs", total: 2 });
});

test("a seed before any event: step 1 of 3, reading it by its armed name", () => {
  assert.deepStrictEqual(loadingStep(null, [], null, { name: "Road trip" }), {
    n: 1,
    label: "reading “Road trip”",
    total: 3,
  });
});

test("the server's seed name beats the armed one, then 'your playlist'", () => {
  assert.strictEqual(loadingStep("seeding", [], { name: "From server" }, { name: "Armed" }).label, "reading “From server”");
  assert.strictEqual(loadingStep("seeding", [], null, { name: "" }).label, "reading “your playlist”");
});

test("a seeded run picking the songs is step 2 of 3", () => {
  assert.deepStrictEqual(loadingStep("curating", [], { name: "x" }, { name: "x" }), {
    n: 2,
    label: "picking the songs",
    total: 3,
  });
});

test("resolving counts a song Spotify couldn't find as checked", () => {
  const log = [
    { artist: "a", title: "1", resolved: true },
    { artist: "b", title: "2", resolved: false },
    { artist: "c", title: "3" },
    undefined,
  ];
  assert.deepStrictEqual(loadingStep("resolving", log, null, null), {
    n: 2,
    label: "checking each one on Spotify · 2 of 4",
    total: 2,
  });
  assert.strictEqual(loadingStep("resolving", log, null, { name: "x" }).n, 3);
});
