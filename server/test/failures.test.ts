// A save that can't work until tomorrow shows the server's words; every other
// save failure stays generic. A dropped connection is told apart from a bug.

import test from "node:test";
import assert from "node:assert";
import { isNetworkFailure, saveRefusal, SAVE_CAP_FALLBACK } from "../../client/src/failures.ts";
import { PRESS_REFUSAL } from "../pressCaps.ts";

// ── client side: saveRefusal ──

// the 429 body /api/playlist sends when today's saves are used up
test("the daily save cap is shown in the server's words", () => {
  assert.strictEqual(saveRefusal(429, PRESS_REFUSAL), PRESS_REFUSAL);
});

test("a 429 with no readable body still reads as a cap, in the same words", () => {
  assert.strictEqual(saveRefusal(429, undefined), SAVE_CAP_FALLBACK);
  assert.strictEqual(SAVE_CAP_FALLBACK, PRESS_REFUSAL);
});

// the line the route's catch sends as an SSE `error` event (index.ts)
const QUOTA_LINE = "Spotify's daily limit for this app is used up — try again tomorrow.";

test("Spotify's daily quota mid-stream is shown in the server's words", () => {
  assert.strictEqual(saveRefusal(null, QUOTA_LINE), QUOTA_LINE);
});

test("the quota line without the stream (a 500 body) is still a cap", () => {
  assert.strictEqual(saveRefusal(500, QUOTA_LINE), QUOTA_LINE);
});

test("a fault is not a refusal, so its owner-facing text never reaches the visitor", () => {
  assert.strictEqual(saveRefusal(null, "Pressing the playlist failed — check the server logs."), null);
  assert.strictEqual(saveRefusal(500, "Pressing the playlist failed — check the server logs."), null);
  assert.strictEqual(saveRefusal(null, "The Mixtape account isn't connected on the server."), null);
  assert.strictEqual(saveRefusal(400, "Missing title or valid track uris"), null);
  assert.strictEqual(saveRefusal(403, "Cross-site request refused."), null);
  assert.strictEqual(saveRefusal(500, undefined), null);
});

// ── client side: isNetworkFailure ──

// what each browser rejects fetch() or reader.read() with when the network is gone
const BROWSER_LINES = [
  "Failed to fetch", // Chrome, fetch
  "network error", // Chrome, reader.read()
  "Load failed", // Safari
  "The network connection was lost.", // Safari, mid-stream
  "NetworkError when attempting to fetch resource.", // Firefox
  "Error in body stream", // Firefox, mid-stream
];

test("each browser's network TypeError is a network failure", () => {
  for (const line of BROWSER_LINES) {
    assert.strictEqual(isNetworkFailure(new TypeError(line), true), true, line);
  }
});

test("a TypeError from a bug in our own code is not", () => {
  const bug = new TypeError("Cannot read properties of null (reading 'getReader')");
  assert.strictEqual(isNetworkFailure(bug, true), false);
  assert.strictEqual(isNetworkFailure(bug, undefined), false);
});

test("a plain Error with a network-ish message is not (only fetch throws TypeError)", () => {
  assert.strictEqual(isNetworkFailure(new Error("Failed to fetch"), true), false);
});

test("a browser that says it is offline is a network failure whatever was thrown", () => {
  assert.strictEqual(isNetworkFailure(new Error("generate failed"), false), true);
});
