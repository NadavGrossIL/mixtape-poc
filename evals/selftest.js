// Plain-node self-test for the harness's pure logic — no API calls, no cost.
// Covers the finding-9 verdict enforcement, the finding-17 resume/upsert
// logic, and the finding-18 aggregation, against evals/test-fixtures/.
//
// Usage:
//   node evals/selftest.js

const assert = require("assert");
const path = require("path");
const { enforceVerdict, doneIds, upsert } = require("./judge");
const { aggregateRun, renderSummary } = require("./aggregate");

// --- Finding 9: enforceVerdict -----------------------------------------------

// A properly evidenced "true" passes through untouched.
const ok = enforceVerdict(
  {
    index: 0,
    classification: "specific-checkable",
    verification: "true",
    reasoning: "r",
    evidence: [{ url: "https://example.com", snippet: "s" }],
  },
  "fx"
);
assert.strictEqual(ok.verification, "true");
assert.strictEqual(ok.downgraded, undefined);

// "true" with empty evidence is downgraded, flagged, and keeps the original.
const noEvidence = enforceVerdict(
  { index: 1, classification: "specific-checkable", verification: "true", reasoning: "r", evidence: [] },
  "fx"
);
assert.strictEqual(noEvidence.verification, "unverifiable");
assert.strictEqual(noEvidence.downgraded, "evidence-missing");
assert.strictEqual(noEvidence.rawVerification, "true");

// Same for a missing evidence field entirely.
const noField = enforceVerdict(
  { index: 2, classification: "specific-checkable", verification: "true", reasoning: "r" },
  "fx"
);
assert.strictEqual(noField.verification, "unverifiable");
assert.strictEqual(noField.downgraded, "evidence-missing");

// Unknown verification enum values are downgraded, flagged, and kept.
const badEnum = enforceVerdict(
  {
    index: 3,
    classification: "specific-checkable",
    verification: "confirmed",
    reasoning: "r",
    evidence: [{ url: "https://example.com", snippet: "s" }],
  },
  "fx"
);
assert.strictEqual(badEnum.verification, "unverifiable");
assert.strictEqual(badEnum.downgraded, "invalid-verdict");
assert.strictEqual(badEnum.rawVerification, "confirmed");

// Non-"true" valid verdicts are untouched even with empty evidence.
const invented = enforceVerdict(
  { index: 4, classification: "specific-checkable", verification: "invented", reasoning: "r", evidence: [] },
  "fx"
);
assert.strictEqual(invented.verification, "invented");
assert.strictEqual(invented.downgraded, undefined);

// --- Finding 17: doneIds / upsert --------------------------------------------

const done = doneIds([
  { id: "a", notes: [{}] },
  { id: "b", error: "boom" },
  { id: "c", notes: [] },
]);
assert.ok(done.has("a") && done.has("c"));
assert.ok(!done.has("b"), "error entries must not count as done");

const list = [{ id: "b", error: "boom" }];
upsert(list, { id: "b", notes: [{ index: 0 }] });
assert.strictEqual(list.length, 1, "retry must replace the error entry, not duplicate the id");
assert.deepStrictEqual(list[0], { id: "b", notes: [{ index: 0 }] });
upsert(list, { id: "d", error: "later" });
assert.strictEqual(list.length, 2);

// --- Finding 18: aggregateRun over the fixture -------------------------------

const summary = aggregateRun(path.join(__dirname, "test-fixtures", "run-fixture"));

assert.deepStrictEqual(summary.cards, {
  prompts: 4,
  generated: 3,
  generateErrors: 1,
  judged: 2,
  judgeErrors: 1,
  judgeErrorIds: ["fx-4"],
});
assert.deepStrictEqual(summary.notes, {
  total: 7,
  resolved: 4,
  unresolved: 2,
  unknownResolution: 1,
});
assert.deepStrictEqual(summary.outcomes.overall, {
  "specific-true": 1,
  "specific-invented": 1,
  "specific-unverifiable": 2,
  generic: 1,
  "specific-subjective": 1,
  missing: 1,
});
assert.strictEqual(summary.outcomes.resolved["specific-true"], 1);
assert.strictEqual(summary.outcomes.unresolved["specific-unverifiable"], 1);
assert.strictEqual(summary.outcomes.unresolved.missing, 1);
assert.strictEqual(summary.outcomes["unknown-resolution"]["specific-subjective"], 1);
assert.deepStrictEqual(summary.downgrades, { total: 1, byReason: { "evidence-missing": 1 } });
assert.strictEqual(summary.headline.checkableNotes, 4);
assert.strictEqual(summary.headline.inventedRate, 0.25);
assert.strictEqual(summary.headline.verifiedTrueRate, 0.25);
assert.strictEqual(summary.headline.unverifiableRate, 0.5);
assert.strictEqual(summary.headline.genericRate, 0.1429);
assert.strictEqual(summary.headline.resolutionRate, 0.6667);
assert.strictEqual(summary.rates.overall["specific-invented"], 0.1429);

console.log("\n" + renderSummary(summary) + "\n");
console.log("[selftest] all assertions passed");
