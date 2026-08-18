// Plain-node self-test for the harness's pure logic — no API calls, no cost.
// Covers the finding-9 verdict enforcement, the finding-17 resume/upsert
// logic, and the finding-18 aggregation, against evals/test-fixtures/, plus
// the pass@k/pass^k estimators, the threshold gate, and the reliability
// summary. Importing reliability.ts pulls in server/curator.ts, which is
// side-effect-free at module scope — no client is constructed until a call.
//
// Usage:
//   node evals/selftest.ts

import assert from "node:assert";
import path from "node:path";
import { enforceVerdict, doneIds, upsert } from "./judge.ts";
import { aggregateRun, renderSummary, noDataReason } from "./aggregate.ts";
import { passAtK, passHatK, checkThresholds, renderChecks } from "./metrics.ts";
import { summarizeTrials, renderReliability } from "./reliability.ts";

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

const list: any[] = [{ id: "b", error: "boom" }];
upsert(list, { id: "b", notes: [{ index: 0 }] });
assert.strictEqual(list.length, 1, "retry must replace the error entry, not duplicate the id");
assert.deepStrictEqual(list[0], { id: "b", notes: [{ index: 0 }] });
upsert(list, { id: "d", error: "later" });
assert.strictEqual(list.length, 2);

// --- Finding 18: aggregateRun over the fixture -------------------------------

const summary = aggregateRun(path.join(import.meta.dirname, "test-fixtures", "run-fixture"));

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
assert.strictEqual(summary.outcomes.resolved!["specific-true"], 1);
assert.strictEqual(summary.outcomes.unresolved!["specific-unverifiable"], 1);
assert.strictEqual(summary.outcomes.unresolved!.missing, 1);
assert.strictEqual(summary.outcomes["unknown-resolution"]!["specific-subjective"], 1);
assert.deepStrictEqual(summary.downgrades, { total: 1, byReason: { "evidence-missing": 1 } });
assert.strictEqual(summary.headline.checkableNotes, 4);
assert.strictEqual(summary.headline.inventedRate, 0.25);
assert.strictEqual(summary.headline.verifiedTrueRate, 0.25);
assert.strictEqual(summary.headline.unverifiableRate, 0.5);
assert.strictEqual(summary.headline.genericRate, 0.1429);
assert.strictEqual(summary.headline.resolutionRate, 0.6667);
assert.strictEqual(summary.rates.overall!["specific-invented"], 0.1429);

console.log("\n" + renderSummary(summary) + "\n");

// --- pass@k / pass^k estimators ----------------------------------------------

// The all-or-nothing ends, where the two metrics agree.
assert.strictEqual(passAtK(10, 10, 10), 1, "all clean => always at least one");
assert.strictEqual(passHatK(10, 10, 10), 1, "all clean => all k clean");
assert.strictEqual(passAtK(10, 0, 10), 0, "never clean => never any");
assert.strictEqual(passHatK(10, 0, 10), 0);

// The regression this harness exists for, in numbers. Pre-fix the model closed
// the tracks array early 6 times in 10, so 4 clean; post-fix 10 clean. pass@1
// barely moves in the eye ("it usually works"), pass^3 is the metric that
// screams — which is exactly why the gate is set on pass^k.
assert.strictEqual(passAtK(10, 4, 1), 0.4, "pre-fix: 4/10 clean");
assert.strictEqual(passHatK(10, 4, 3), 0.0333, "pre-fix: 3 clean runs in a row was a coin-flip away from never");
assert.strictEqual(passHatK(10, 10, 3), 1, "post-fix: 3 in a row is certain");

// Opposite stories as k grows: pass@k rises, pass^k falls.
assert.ok(passAtK(10, 5, 3)! > passAtK(10, 5, 1)!, "pass@k must rise with k");
assert.ok(passHatK(10, 5, 3)! < passHatK(10, 5, 1)!, "pass^k must fall with k");

// Too few failures to fill k draws => at least one success is certain.
assert.strictEqual(passAtK(10, 9, 3), 1);
// Too few successes to fill k draws => all-k-succeed is impossible.
assert.strictEqual(passHatK(10, 2, 3), 0);

// Guard rails: k > n, empty, and non-integer counts are null, not NaN.
assert.strictEqual(passAtK(3, 3, 5), null, "k > n is unanswerable");
assert.strictEqual(passHatK(0, 0, 1), null);
assert.strictEqual(passAtK(10, 11, 3), null, "more successes than trials");
assert.strictEqual(passHatK(10, 1.5, 3), null);

// --- Threshold checking ------------------------------------------------------

const fixtureSummary = {
  headline: { inventedRate: 0.25, genericRate: 0.1429, resolutionRate: null },
  overall: { passHatK: 0.9 },
};

// max breached, min met, min breached.
const checks = checkThresholds(fixtureSummary, {
  $comment: "ignored" as any,
  "headline.inventedRate": { max: 0.1 },
  "headline.genericRate": { max: 0.5 },
  "overall.passHatK": { min: 0.95 },
});
assert.strictEqual(checks.length, 3, "$-prefixed keys are documentation, not rules");
assert.strictEqual(checks[0]!.ok, false);
assert.strictEqual(checks[0]!.reason, "above max 0.1");
assert.strictEqual(checks[1]!.ok, true);
assert.strictEqual(checks[2]!.ok, false);
assert.strictEqual(checks[2]!.reason, "below min 0.95");

// A null metric (empty denominator) is missing data, not a regression — it must
// never fail a build on an absence.
const nullCheck = checkThresholds(fixtureSummary, { "headline.resolutionRate": { min: 0.9 } });
assert.strictEqual(nullCheck[0]!.ok, true);
assert.strictEqual(nullCheck[0]!.actual, null);
assert.strictEqual(nullCheck[0]!.reason, "no data — skipped");

// A path that doesn't exist behaves the same way — a renamed metric must not
// silently pass as "met", nor hard-fail the run.
const missingPath = checkThresholds(fixtureSummary, { "headline.nope": { max: 1 } });
assert.strictEqual(missingPath[0]!.actual, null);
assert.strictEqual(missingPath[0]!.reason, "no data — skipped");

// No rules configured = report-only, and the renderer says so plainly.
assert.deepStrictEqual(checkThresholds(fixtureSummary, {}), []);
assert.match(renderChecks([]), /none configured — report-only/);
assert.match(renderChecks(checks), /2 threshold\(s\) breached/);

// --- summarizeTrials ---------------------------------------------------------

// Two prompts x 3 trials: one perfectly clean, one that retried twice and
// errored once. Hand-planted so every number below is checkable by eye.
const trialEntries = [
  {
    id: "clean-prompt",
    category: "mainstream-safe",
    trials: [
      { ok: true, cleanFirstCommit: true, firstGap: null, commitAttempts: 1, trackCount: 8, refCount: 8, ms: 1000 },
      { ok: true, cleanFirstCommit: true, firstGap: null, commitAttempts: 1, trackCount: 8, refCount: 6, ms: 2000 },
      { ok: true, cleanFirstCommit: true, firstGap: null, commitAttempts: 1, trackCount: 8, refCount: 8, ms: 3000 },
    ],
  },
  {
    id: "flaky-prompt",
    category: "deep-niche",
    trials: [
      { ok: true, cleanFirstCommit: false, firstGap: "only 1 of the 8 track slots were filled in", commitAttempts: 2, trackCount: 8, refCount: 4, ms: 4000 },
      { ok: true, cleanFirstCommit: true, firstGap: null, commitAttempts: 1, trackCount: 8, refCount: 8, ms: 2000 },
      { ok: false, error: "overloaded", cleanFirstCommit: false, firstGap: null, commitAttempts: 0, trackCount: 0, refCount: 0, ms: 500 },
    ],
  },
];

const rel = summarizeTrials(trialEntries, 3);
assert.strictEqual(rel.overall.trials, 6);

// The denominator fix. One trial died before committing anything, so it is
// excluded from cleanliness rather than counted against the model: 4 clean of
// the 5 that COMMITTED (0.8), not 4 of 6 (0.6667). Getting this wrong is what
// made the first baseline read as a schema regression instead of a flaky link.
assert.strictEqual(rel.overall.committed, 5);
assert.strictEqual(rel.overall.neverCommitted, 1);
assert.strictEqual(rel.overall.cleanFirstCommits, 4);
assert.strictEqual(rel.overall.cleanFirstCommitRate, 0.8, "4 clean of 5 committed");
assert.strictEqual(rel.overall.successRate, 0.8333, "5 of 6 returned a card — over ALL trials");
assert.strictEqual(rel.overall.passHatK, 0.4, "C(4,3)/C(5,3) = 4/10");
assert.strictEqual(rel.overall.passAtK, 1, "only 1 dirty commit — can't fill 3 draws");
// Mean attempts over committed trials only: (1+1+1+2+1)/5. Including the
// never-committed trial would give 6/6 = 1.0, implying "never retried" when a
// retry demonstrably happened.
assert.strictEqual(rel.overall.meanCommitAttempts, 1.2);
assert.strictEqual(rel.overall.refRate, 0.85, "34 refs over 40 committed tracks");
assert.strictEqual(rel.overall.meanMs, 2083, "mean latency spans ALL trials, failures included");

// A trial that threw before ever committing must not count as clean.
assert.strictEqual(rel.perPrompt[1]!.clean, 1);
assert.strictEqual(rel.perPrompt[1]!.committed, 2);
assert.strictEqual(rel.perPrompt[1]!.neverCommitted, 1);
assert.strictEqual(rel.perPrompt[1]!.succeeded, 2);
assert.strictEqual(rel.perPrompt[1]!.cleanFirstCommitRate, 0.5);
assert.strictEqual(rel.perPrompt[0]!.passHatK, 1, "3/3 clean");
assert.strictEqual(rel.perPrompt[1]!.passHatK, 0, "1 clean can't fill 2 draws");
assert.deepStrictEqual(rel.firstCommitGaps, {
  "only 1 of the 8 track slots were filled in": 1,
});
// Failures are grouped by class + message so a future run diagnoses itself.
assert.deepStrictEqual(rel.failures, { "unknown: overloaded": 1 });
assert.deepStrictEqual(rel.perPrompt[1]!.errors, ["overloaded"]);

// Every trial dying before a commit means there is nothing to measure at all.
const allDead = summarizeTrials(
  [{ id: "x", category: "c", trials: [
    { ok: false, error: "terminated", cleanFirstCommit: false, firstGap: null, commitAttempts: 0, trackCount: 0, refCount: 0, ms: 600000 },
    { ok: false, error: "terminated", cleanFirstCommit: false, firstGap: null, commitAttempts: 0, trackCount: 0, refCount: 0, ms: 600000 },
  ] }],
  2
);
assert.strictEqual(allDead.overall.committed, 0);
assert.strictEqual(allDead.overall.cleanFirstCommitRate, null, "no data, not 0% — 0% would read as a regression");
assert.strictEqual(allDead.overall.passHatK, null);

// --- noDataReason: a run that measured nothing is a FAILED run -------------

// The 2026-08-17 shape exactly: cards generated, every judge call timed out.
assert.match(
  noDataReason({ cards: { prompts: 6, generated: 3, generateErrors: 3, judged: 0, judgeErrors: 3 }, notes: { total: 0 } })!,
  /0 of 6 cards were judged \(3 generate error\(s\), 3 judge error\(s\)\)/
);
assert.match(noDataReason({ cards: { prompts: 0, judged: 0 }, notes: { total: 0 } })!, /no prompts/);
assert.match(
  noDataReason({ cards: { prompts: 2, judged: 2 }, notes: { total: 0 } })!,
  /2 card\(s\) judged but 0 notes/
);
// The fixture run DID measure something, so it must not trip the gate.
assert.strictEqual(noDataReason(summary), null);

console.log(renderReliability(rel) + "\n");
console.log("[selftest] all assertions passed");
