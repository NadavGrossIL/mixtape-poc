// A refine run's state moves the way App's setters used to move it: a start
// clears the last error but keeps the typed text, the log grows per change
// and is ticked per resolve, the run's end clears the log but leaves the
// error up, a success empties the box, and a reset drops error and text.

import test from "node:test";
import assert from "node:assert";
import { refineIdle, refineRun, type RefineState } from "../../client/src/refineRun.ts";

const line = (index: number, artist = "a", title = "t") => ({ index, artist, title });

const running = (over: Partial<RefineState> = {}): RefineState => ({
  ...refineIdle,
  adjusting: true,
  ...over,
});

test("textChanged sets the box's text", () => {
  assert.strictEqual(refineRun(refineIdle, { type: "textChanged", text: "less 80s" }).text, "less 80s");
});

test("started clears the error, stage and log but keeps the text", () => {
  const before: RefineState = {
    text: "less 80s",
    adjusting: false,
    stage: "resolving",
    log: [line(1)],
    error: { message: "x", detail: "d", booked: true },
    errorTick: 1,
  };
  assert.deepStrictEqual(refineRun(before, { type: "started" }), {
    text: "less 80s",
    adjusting: true,
    stage: null,
    log: [],
    error: null,
    errorTick: 1,
  });
});

test("stage sets the stage, and the same stage twice is the same state", () => {
  const s = refineRun(running(), { type: "stage", stage: "adjusting" });
  assert.strictEqual(s.stage, "adjusting");
  assert.strictEqual(refineRun(s, { type: "stage", stage: "adjusting" }), s);
});

test("change appends a log line, without mutating the old log", () => {
  const before = running({ log: [line(0)] });
  const after = refineRun(before, { type: "change", line: line(3, "b", "u") });
  assert.deepStrictEqual(after.log, [line(0), line(3, "b", "u")]);
  assert.deepStrictEqual(before.log, [line(0)]);
});

test("resolved marks every line with that index and no other", () => {
  const before = running({ log: [line(2), line(5), line(2)] });
  const after = refineRun(before, { type: "resolved", index: 2, resolved: false });
  assert.deepStrictEqual(after.log, [
    { ...line(2), resolved: false },
    line(5),
    { ...line(2), resolved: false },
  ]);
});

test("succeeded empties the box", () => {
  assert.strictEqual(refineRun(running({ text: "less 80s" }), { type: "succeeded" }).text, "");
});

test("failed sets the error as given", () => {
  const error = { message: "nope", detail: "upstream", booked: false };
  assert.deepStrictEqual(refineRun(running(), { type: "failed", error }).error, error);
});

test("a cap fails booked; an offline, dropped, plain or fault failure does not", () => {
  const cap = refineRun(running(), {
    type: "failed",
    error: { message: "that's it for today", detail: null, booked: true },
  });
  assert.strictEqual(cap.error?.booked, true);
  for (const message of ["you look offline", "the connection dropped", "too long", "couldn't"]) {
    const s = refineRun(running(), { type: "failed", error: { message, detail: null, booked: false } });
    assert.strictEqual(s.error?.booked, false);
  }
});

test("finished clears adjusting, stage and log but keeps the error and text", () => {
  const error = { message: "nope", detail: null, booked: false };
  const before = running({ text: "less 80s", stage: "resolving", log: [line(1)], error });
  assert.deepStrictEqual(refineRun(before, { type: "finished" }), {
    text: "less 80s",
    adjusting: false,
    stage: null,
    log: [],
    error,
    errorTick: 0,
  });
});

test("every failure bumps the tick, so the same line twice still scrolls into view", () => {
  const error = { message: "capped", detail: null, booked: true };
  const once = refineRun(running(), { type: "failed", error });
  const twice = refineRun(once, { type: "failed", error });
  assert.strictEqual(once.errorTick, 1);
  assert.strictEqual(twice.errorTick, 2);
  assert.strictEqual(refineRun(twice, { type: "reset" }).errorTick, 2);
});

test("reset clears the error and the text", () => {
  const before: RefineState = {
    ...refineIdle,
    text: "less 80s",
    error: { message: "nope", detail: "d", booked: true },
  };
  assert.deepStrictEqual(refineRun(before, { type: "reset" }), refineIdle);
});
