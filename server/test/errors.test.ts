// Guards that a caught value of any shape reads safely: the routes branch on
// `status` and `quotaExceeded`, and a wrong read would turn a quota stop into a retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageOf, errorMessage, errorStatus, isQuotaError } from "../errors.ts";

test("an Error with bolted-on fields reads all of them", () => {
  const err = Object.assign(new Error("Spotify API 429 on /v1/search"), {
    status: 429,
    quotaExceeded: true,
  });
  assert.equal(errorMessage(err), "Spotify API 429 on /v1/search");
  assert.equal(errorStatus(err), 429);
  assert.equal(isQuotaError(err), true);
});

test("a plain object with the same fields counts too", () => {
  const err = { status: 401, message: "bad key" };
  assert.equal(messageOf(err), "bad key");
  assert.equal(errorStatus(err), 401);
  assert.equal(isQuotaError(err), false);
});

test("a non-Error throw is logged as itself", () => {
  assert.equal(errorMessage("boom"), "boom");
  assert.equal(errorMessage(null), "null");
  assert.equal(errorMessage(undefined), "undefined");
  assert.equal(messageOf("boom"), undefined);
});

test("fields of the wrong type are not trusted", () => {
  assert.equal(errorStatus({ status: "429" }), undefined);
  assert.equal(isQuotaError({ quotaExceeded: "yes" }), false);
  assert.equal(messageOf({ message: 42 }), undefined);
  assert.equal(errorStatus(null), undefined);
  assert.equal(isQuotaError(undefined), false);
});
