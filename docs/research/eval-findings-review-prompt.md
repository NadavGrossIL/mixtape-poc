# Review prompt — audit the eval findings, then do what actually pays

Paste everything below into a fresh session opened in `~/Projects/mixtape-poc`.

---

You are auditing conclusions a previous session reached about this repo's eval
harness, and then acting on whatever survives. **Assume the conclusions are
wrong until you have checked them yourself.** The session that produced them
also produced the analysis that undermined its own headline number, so treat
confidence in that write-up as weak evidence, not strong.

Your job is not to be agreeable. If a claim does not hold, say so plainly and
show the check that killed it. A confirmed "this was wrong" is worth more here
than a polished restatement.

## Ground truth to read first

- `evals/` — `generate.ts`, `judge.ts`, `aggregate.ts`, `reliability.ts`,
  `metrics.ts`, `selftest.ts`, `thresholds.json`
- `server/curator.ts` — `TRACK_SCHEMA`, `CURATOR_TOOL`, `runCuratorAgent`,
  `cardIncompleteReason`
- `server/spotify.ts` — `trimItem`, `searchCatalog`
- Runs on disk: `evals/runs/2026-08-18T07-45-44-348Z/` (the wide baseline —
  `cards.json`, `verdicts.json`, `summary.json`),
  `evals/runs/2026-08-17T07-36-33-768Z/` (earlier 3-card run),
  `evals/runs/2026-08-17T10-21-53-412Z/` (**voided** reliability numbers)
- `evals/baseline-logs/` — raw stdout of every run
- Commits `99d0ff0`, `5d5717b`, `8e0a94a`, `c830faa`, `572cef4`

Offline and free: `node evals/selftest.ts`, `cd server && npm test`,
`npm run typecheck`. Costs money: anything calling `generate`, `judge` or
`reliability`. Spotify has a per-developer-account daily quota (~10–30 curator
runs) shared by local dev, Railway and evals.

## Claims to check, hardest first

Each of these is load-bearing. The ones marked ⚠️ are where the previous
session already knew its own evidence was thin.

1. ⚠️ **"5 of the 18 invented notes were correctly grounded; real hallucination
   is ~17%, not 24%."** The claim is that every year asserted in an invented
   note exactly matches the `album.release_date` the model was shown, so the
   judge and the app disagree about which date counts rather than the model
   inventing. **The check that produced this matched cached search results by
   fuzzy title prefix, not by the `ref` (Spotify track id) each track carries.**
   Redo it via `ref` against `server/.search-cache.json` and the run's
   `cards.json`. Does the split hold at 5? Is it larger? Smaller? This single
   number decides whether the headline is 24% or 17%, and whether the
   thresholds now in `evals/thresholds.json` are calibrated or nonsense.

2. **"Don't add an inline grounding LLM call."** Argued on cost (judge ≈ 2.8
   min/card, Opus + 9–10 web searches, versus 37s to generate) and on the claim
   that it would not fix the grounded-date cases. Price it yourself from the
   run logs and `judge.ts`'s actual usage numbers. Is there a cheaper shape the
   previous session did not consider — a smaller model, notes batched
   differently, verifying only claim types that fail, verifying asynchronously
   after the card renders? Argue the other side properly before agreeing.

3. **"Fix the judge's date definition first."** Is that really the highest-value
   move, or does it just repaint a metric while the product problem is
   untouched? What would you sequence differently, and why?

4. **"Constrain `TRACK_SCHEMA.note` to what search returns."** The supporting
   evidence is the category split (mood-only 57% invented, stat-claim-bait 36%,
   non-english 33% … decade-specific 0%, artist-specific 0%). Does that split
   actually support the schema hypothesis, or is it confounded — by how obscure
   the catalogue is, by language, by how much the web has been written about
   these artists? Check the per-note verdicts, not the summary.

5. ⚠️ **"The content-filter 400 is triggered by fetched web-search content."**
   2 of 15 judge calls died on `400 invalid_request_error: "Output blocked by
   content filtering policy"` (`app-90s-roadtrip`, `mood-train-window`). The
   causal claim is **pure speculation and was never tested.** Design a cheap
   test. Consider that this costs a whole card's data each time and that
   `judge.ts` batches all 8 notes into ONE call.

6. ⚠️ **"The Aug 17 slowness was environmental, not structural."** Rests on two
   runs: ~13.5 min/mixtape then, 37s/mixtape the next day, with 88 of 92
   searches going live rather than cached. n=2. Is there a better explanation
   in the logs?

7. ⚠️ **"The curator timeout / `maxRetries: 3` change helped."** It cannot be
   credited — the good run had zero failures, so retries left no trace. Only
   the judge's 30-minute timeout is unambiguously confirmed (every card had
   died at ~28 min ≈ 10 min × 3 attempts). Decide whether the curator change
   should stay, be reverted, or be instrumented.

8. **"The hollow-commit bug changed shape rather than being fixed."** 2 of 12
   first commits were rejected for placeholder content in `track1`, i.e. ~83%
   clean, against the 0/10 the eight-required-keys fix originally measured. Is
   that a real regression, a different failure mode, or sampling noise at n=12?

9. **"Tests should not be folded into evals."** The original question. All 73
   server tests plus `evals/selftest.ts` are deterministic; the argument was
   that code-based graders belong on deterministic logic and judges only on
   nuance. Still true? Is anything in `server/test/` actually an eval in
   disguise, or anything in `evals/` deterministic enough to be a test?

## What to do after checking

Do not stop at a verdict list. Once you know which claims survive:

- Fix what is cheap, offline and clearly right. `evals/selftest.ts` covers the
  harness's pure logic and must stay green.
- Where a fix needs a paid run to validate, say what it would cost and what it
  would prove **before** spending, and check quota first.
- If the highest-value action is something nobody proposed, do that instead and
  explain why it beats the list above.

Two standing rules from this repo: a metric with an empty denominator is "no
data — skipped", never a breach, but a run that measured **nothing** must fail
outright; and thresholds are regression guards derived from a measurement,
never numbers someone picked.

## Deliverable

A short report: each claim marked CONFIRMED / REFUTED / UNTESTABLE-CHEAPLY with
the evidence, then what you changed and what you deliberately did not. Flag
anything where you are guessing.
