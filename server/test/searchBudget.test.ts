// The per-request search allowance: it must hand out exactly `limit` searches
// and then refuse forever, because everything downstream (the curator loop and
// track resolution) treats a refusal as "degrade", not "retry".

import test from "node:test";
import assert from "node:assert";
import { makeSearchBudget } from "../searchBudget.ts";

test("hands out exactly `limit` searches, then refuses", () => {
  const budget = makeSearchBudget(3);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), false);
  assert.equal(budget.spend(), false, "a refusal is permanent, not a one-off");
  assert.equal(budget.spent(), 3, "a refused spend must not be counted");
  assert.equal(budget.remaining(), 0);
});

test("spent and remaining track each other", () => {
  const budget = makeSearchBudget(5);
  budget.spend();
  budget.spend();
  assert.equal(budget.spent(), 2);
  assert.equal(budget.remaining(), 3);
});

test("two consumers share one allowance", () => {
  // The whole point: the curator loop and track resolution draw from the same
  // object, so the request total is bounded rather than each half's total.
  const budget = makeSearchBudget(4);
  const curatorHalf = [budget.spend(), budget.spend(), budget.spend()];
  assert.deepEqual(curatorHalf, [true, true, true]);
  assert.equal(budget.spend(), true, "resolution gets what the loop left");
  assert.equal(budget.spend(), false, "and no more");
});

test("a nonsense limit is a closed budget, never an unbounded one", () => {
  for (const bad of [0, -1, NaN, Number.NEGATIVE_INFINITY]) {
    assert.equal(makeSearchBudget(bad).spend(), false, `${bad} must refuse`);
  }
});

test("a fractional limit floors rather than rounding up", () => {
  const budget = makeSearchBudget(2.9);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), true);
  assert.equal(budget.spend(), false);
});
