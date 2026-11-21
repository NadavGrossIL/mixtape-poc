// The one log line per curator run: it is the only cost record on a deployed
// host, so the numbers must be the run's own — and a missing or odd token
// count must never break a run or print NaN.

import test from "node:test";
import assert from "node:assert";
import { runSummary, tokensOf } from "../lc/runLog.ts";

test("a generate run: outcome, rounds, searches, tokens, seconds", () => {
  assert.equal(
    runSummary({ kind: "generate", outcome: "card", rounds: 3, liveSearches: 7, tokensIn: 12345, tokensOut: 890, ms: 28412 }),
    "[curator-lc] run generate: card | 3 rounds | 7 live searches | tokens 12345 in, 890 out | 28.4 s"
  );
});

test("singular words for one round and one search", () => {
  const line = runSummary({ kind: "generate", outcome: "no card", rounds: 1, liveSearches: 1, tokensIn: 0, tokensOut: 0, ms: 900 });
  assert.match(line, /no card \| 1 round \| 1 live search \| tokens 0 in, 0 out \| 0\.9 s$/);
});

test("an adjust says whether it continued the remembered thread", () => {
  const base = { kind: "adjust", outcome: "card", rounds: 2, liveSearches: 0, tokensIn: 1, tokensOut: 1, ms: 1000 } as const;
  assert.match(runSummary({ ...base, remembered: true }), /run adjust \(remembered thread\): card/);
  assert.match(runSummary({ ...base, remembered: false }), /run adjust \(fresh thread\): card/);
});

test("the line carries numbers only — nothing a visitor typed can be in it", () => {
  const line = runSummary({ kind: "generate", outcome: "stopped", rounds: 0, liveSearches: 0, tokensIn: 0, tokensOut: 0, ms: 0 });
  assert.equal(line, "[curator-lc] run generate: stopped | 0 rounds | 0 live searches | tokens 0 in, 0 out | 0.0 s");
});

test("tokensOf reads LangChain's usage_metadata", () => {
  assert.deepEqual(tokensOf({ usage_metadata: { input_tokens: 4200, output_tokens: 310, total_tokens: 4510 } }), { in: 4200, out: 310 });
});

test("tokensOf: missing or odd usage counts as zero, never NaN", () => {
  for (const m of [undefined, null, {}, { usage_metadata: null }, { usage_metadata: { input_tokens: "9", output_tokens: NaN } }, { usage_metadata: { input_tokens: -5 } }]) {
    assert.deepEqual(tokensOf(m), { in: 0, out: 0 });
  }
});
