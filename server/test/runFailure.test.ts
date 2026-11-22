// A failed generate or refine is sorted the way the catch blocks always
// sorted it: a stop first, a cap even when offline, the visitor's wifi apart
// from our own bugs. A refused response and the stream's error events
// become the same errors they always threw.

import test from "node:test";
import assert from "node:assert";
import {
  classifyRunFailure,
  noStreamErrors,
  noteStreamError,
  responseFailure,
  streamFailure,
} from "../../client/src/runFailure.ts";
import { CapError, PlainError, QUOTA_COPY, StreamDroppedError } from "../../client/src/sse.ts";

const abortError = () => {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
};

// ── classifyRunFailure ──

test("a stop beats everything, even offline", () => {
  assert.strictEqual(classifyRunFailure(abortError(), false).kind, "aborted");
});

test("a cap is a cap even when the browser says it is offline", () => {
  const cap = new CapError("that's it for today");
  const failure = classifyRunFailure(cap, false);
  assert.strictEqual(failure.kind, "cap");
  assert.ok(failure.kind === "cap");
  assert.strictEqual(failure.error, cap);
});

test("the browser's network TypeError is offline", () => {
  assert.strictEqual(classifyRunFailure(new TypeError("Failed to fetch"), true).kind, "offline");
});

test("offline wins over a dropped stream or a plain error", () => {
  assert.strictEqual(classifyRunFailure(new StreamDroppedError(), false).kind, "offline");
  assert.strictEqual(classifyRunFailure(new PlainError("too long"), false).kind, "offline");
});

test("a TypeError from a bug in our own code is a fault", () => {
  const bug = new TypeError("Cannot read properties of null (reading 'getReader')");
  assert.strictEqual(classifyRunFailure(bug, true).kind, "fault");
});

test("a stream that ended with no card is dropped", () => {
  assert.strictEqual(classifyRunFailure(new StreamDroppedError(), true).kind, "dropped");
});

test("a PlainError is plain and carries itself", () => {
  const plain = new PlainError("that prompt is too long", "detail");
  const failure = classifyRunFailure(plain, true);
  assert.ok(failure.kind === "plain");
  assert.strictEqual(failure.error, plain);
});

test("anything else, thrown values included, is a fault", () => {
  assert.strictEqual(classifyRunFailure(new Error("generate failed"), true).kind, "fault");
  assert.strictEqual(classifyRunFailure("a string", undefined).kind, "fault");
});

// ── responseFailure ──

test("a 429 is a cap in the server's words, or the default line", () => {
  const worded = responseFailure(429, { error: "come back tomorrow" }, "generate failed");
  assert.ok(worded instanceof CapError);
  assert.strictEqual(worded.message, "come back tomorrow");
  const bare = responseFailure(429, {}, "generate failed");
  assert.ok(bare instanceof CapError);
  assert.strictEqual(bare.message, new CapError().message);
});

test("a 400 that names its problem is a PlainError", () => {
  const e = responseFailure(400, { error: "that prompt is too long" }, "generate failed");
  assert.ok(e instanceof PlainError);
  assert.strictEqual(e.message, "that prompt is too long");
  assert.strictEqual(e.detail, null);
});

test("a 400 without a message is a fault with the route's own text", () => {
  const e = responseFailure(400, {}, "adjust failed");
  assert.ok(!(e instanceof PlainError) && !(e instanceof CapError));
  assert.strictEqual(e.message, "adjust failed");
});

test("a 500 is a fault carrying the body's error", () => {
  const e = responseFailure(500, { error: "boom" }, "generate failed");
  assert.ok(!(e instanceof PlainError) && !(e instanceof CapError));
  assert.strictEqual(e.message, "boom");
});

// ── the stream's error events ──

test("no error events, no failure", () => {
  assert.strictEqual(streamFailure(noStreamErrors()), null);
});

test("a plain error event is a fault, detail preferred over message", () => {
  const acc = noStreamErrors();
  noteStreamError(acc, { message: "it broke", detail: "upstream 500" }, "generate failed");
  const e = streamFailure(acc);
  assert.ok(e && !(e instanceof PlainError) && !(e instanceof CapError));
  assert.strictEqual(e.message, "upstream 500");
});

test("an event with nothing in it falls back to the route's text", () => {
  const acc = noStreamErrors();
  noteStreamError(acc, null, "adjust failed");
  assert.strictEqual(streamFailure(acc)?.message, "adjust failed");
});

test("an outage is a PlainError in the server's words, with the detail carried", () => {
  const acc = noStreamErrors();
  noteStreamError(acc, { message: "the curator is offline", outage: true, detail: "credit" }, "x");
  const e = streamFailure(acc);
  assert.ok(e instanceof PlainError);
  assert.strictEqual(e.message, "the curator is offline");
  assert.strictEqual(e.detail, "credit");
});

test("the quota flag beats an outage, and sticks across later events", () => {
  const acc = noStreamErrors();
  noteStreamError(acc, { message: "q", quota: true }, "x");
  noteStreamError(acc, { message: "the curator is offline", outage: true, detail: "last" }, "x");
  const e = streamFailure(acc);
  assert.ok(e instanceof CapError);
  assert.strictEqual(e.message, QUOTA_COPY);
  assert.strictEqual(e.detail, "last"); // the detail is the last event's
});

test("an outage beats a later plain error", () => {
  const acc = noStreamErrors();
  noteStreamError(acc, { message: "offline", outage: true }, "x");
  noteStreamError(acc, { message: "boom" }, "x");
  const e = streamFailure(acc);
  assert.ok(e instanceof PlainError);
  assert.strictEqual(e.message, "offline");
});

test("the quota message without the flag (an older server) is still the quota", () => {
  const acc = noStreamErrors();
  noteStreamError(acc, { message: "Spotify's daily limit for this app is used up." }, "x");
  assert.ok(streamFailure(acc) instanceof CapError);
});
