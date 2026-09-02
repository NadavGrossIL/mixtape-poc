import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUpstream, makeOutageTracker, OFFLINE_COPY, BUSY_COPY } from "../outage.ts";

test("a Spotify error with a status is never an Anthropic outage", () => {
  const c = classifyUpstream({ status: 401, message: "Spotify API 401 on /v1/search" }, false);
  assert.equal(c.kind, null);
  assert.equal(c.message, null);
  assert.equal(c.persistent, false);
});

test("401/403 from Anthropic is a persistent auth outage", () => {
  for (const status of [401, 403]) {
    const c = classifyUpstream({ status, message: "invalid x-api-key" }, true);
    assert.equal(c.kind, "anthropic-auth");
    assert.equal(c.message, OFFLINE_COPY);
    assert.equal(c.persistent, true);
  }
});

test("the 2026-09-02 billing 400 is a persistent outage", () => {
  const c = classifyUpstream(
    {
      status: 400,
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    },
    true
  );
  assert.equal(c.kind, "anthropic-billing");
  assert.equal(c.message, OFFLINE_COPY);
  assert.equal(c.persistent, true);
});

test("an ordinary 400 (our own bad request) is not an outage", () => {
  const c = classifyUpstream({ status: 400, message: "max_tokens too large" }, true);
  assert.equal(c.kind, null);
});

test("429, 500, 529 are transient: busy copy, not persistent", () => {
  for (const status of [429, 500, 529]) {
    const c = classifyUpstream({ status, message: "overloaded" }, true);
    assert.equal(c.kind, "anthropic-busy");
    assert.equal(c.message, BUSY_COPY);
    assert.equal(c.persistent, false);
  }
});

test("a status-less error is not classified", () => {
  assert.equal(classifyUpstream({ message: "socket hang up" }, true).kind, null);
  assert.equal(classifyUpstream(null, true).kind, null);
});

test("tracker remembers only persistent failures and forgets on success", () => {
  const t = makeOutageTracker();
  assert.equal(t.current(), null);
  t.note({ status: 529, message: "overloaded" }, true);
  assert.equal(t.current(), null, "transient failures are not remembered");
  const c = t.note({ status: 401, message: "bad key" }, true, 1000);
  assert.equal(c.kind, "anthropic-auth");
  assert.deepEqual(t.current(), { kind: "anthropic-auth", since: 1000, message: "bad key" });
  t.note({ status: 429, message: "spotify" }, false);
  assert.equal(t.current()?.kind, "anthropic-auth", "a Spotify error does not overwrite it");
  t.clear();
  assert.equal(t.current(), null);
});
