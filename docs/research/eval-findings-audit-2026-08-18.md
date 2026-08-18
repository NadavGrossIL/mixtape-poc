# Audit of the eval-harness findings — 2026-08-18

Response to `eval-findings-review-prompt.md`. Every claim was rechecked against
the run artifacts, the raw logs, the search cache, and the git history before
anything was changed. Verdicts below; changes and non-changes at the end.

## Verdicts

### 1. "Real hallucination is ~17%, not 24%" — REFUTED (the count survives, the inference doesn't)

Redone by `ref` against `server/.search-cache.json` (the fuzzy title-prefix
match happened to land on the same set): exactly **5 of 18** invented notes
assert a year, and in all 5 the year equals `release_date.slice(0,4)` of the
exact cached record the model committed — zero mismatches. Cache timestamps
prove all 5 entries were written **during** the run's generate phase
(07:46–07:48), so they are precisely what the model saw.

But subtracting all 5 was wrong. Read the judge's own reasoning:

- **Plastician** — judge calls the 2007 date "broadly supportable"; the
  invented verdict is the *Big Apple Records* label claim.
- **Knesiyat Hasechel** — the 1999 date is never disputed; the invented
  verdict is the *"Aviv Geffen's other project"* credit.

Those two notes are invented regardless of the grounded year. Only **3 of 18**
(Shalom Hanoch 1992, Montand 1955, Brel 1957) have the date as the
load-bearing invented claim — and Brel is arguable, since "original …
recording" is the model's own embellishment on top of a shown album year.

So: headline stays **24%** under the judge's world-truth definition; the
judge-vs-metadata date disagreement is worth at most **3 notes**, putting real
model invention at **20–21%** (15–16/75), not 17%. `thresholds.json` was
calibrated on the measured 0.240 and remains valid.

### 2. "Don't add an inline grounding LLM call" — right conclusion, wrong reasoning

The cost numbers verify from `verdicts.json` usage: judge ≈ **$1.18/card mean**
($1.66 max, $12.95/run), 2.9 min/card wall clock, 10.4 searches/card — so the
Opus web judge inline is correctly ruled out. But the session priced only the
shape nobody would ship. Cheaper shapes it skipped:

- **$0 deterministic checks** against the ref'd search row the server already
  holds: note-year regex vs shown `year`, "title track" vs `album` string,
  duration claims vs `duration_ms` (one field addition to `trimItem` /
  `searchCatalog` — Spotify already returns it and we throw it away). Would
  have flagged 4–6 of this run's 18.
- **Haiku, no web, checking notes against the search rows already in the
  conversation**: ~$0.006/card, catches album/era attributions too (~6–9 of
  18 at 0.5% of judge cost).
- **Async verify-after-render**: latency argument doesn't apply at all.

And the "grounding wouldn't fix the grounded-date cases" argument cuts both
ways — it means Spotify metadata can't be the *full* ground truth either,
which is why the web judge stays as the eval's arbiter.

### 3. "Fix the judge's date definition first" — REFUTED as sequencing

It repaints at most 3 of 18 notes (~4pp of a 24% metric) and touches nothing
the user sees. Higher value, in order: (a) the deterministic grounding
diagnostic — shipped, $0, keeps the judge's definition intact and reports the
disagreement instead of hiding it; (b) product-side prevention — 12–13 of the
18 inventions assert fact types the model was never shown and cannot know
(durations, timestamps, credits, take counts). Give it `duration_ms` and a
note-writing constraint against asserting unseen fact types before paying to
recalibrate any metric.

### 4. "Constrain note content to what search returns" — split is confounded, hypothesis still right

The category split reproduces exactly (mood-only 4/7 = 57%, statbait 4/11,
non-english 5/15, decade 0/8, artist 0/8) but each "category" is 1–2 cards
with tiny denominators — card topic and how well-documented the artists are
dominate, so the split itself proves little. The unconfounded evidence is
per-note: **~15 of 18 invented notes assert fact types outside
{artist, title, album, year}**, and 18/18 sit on `resolved: true` tracks. The
tracks are real; the notes reach beyond the data. That supports grounding the
notes via prompt + richer search rows — a JSON schema cannot express "only
assert facts you were shown", so this is not literally a `TRACK_SCHEMA` fix.

### 5. Content-filter 400 caused by fetched web content — UNTESTED, and the fact pattern was misremembered

The two failures are real but come from **different runs**: `app-90s-roadtrip`
(Aug 17 set, died in the Aug 18 retest) and `mood-train-window` (Aug 18 run).
Neither was ever retried, so even determinism is unknown. Both cards' notes
quote lyric fragments, so "the judge's *output* reproducing lyrics trips the
output filter" is at least as live as the fetched-content theory. Cheap
decisive test, not run (paid, ~$1.20–2.40): re-judge `mood-train-window` as-is
(judge.ts already retries failed entries); if it fails again, once more with
the web-search tool removed. Fails without search → card content; passes →
search-derived.

### 6. "Aug 17 slowness was environmental" — half survives, half refuted

**Refuted**: "Aug 18 was fast because searches were cached" — the cache gained
88 new entries during the Aug 18 generate phase (≈92 searches, ≤4 hits). Both
runs were nearly all-live; search latency was never the cost.
**Supported**: per-card timing reconstructed from cache `at` timestamps shows
Aug 17's 13.5 min/card average was three hung streams (~35, ~33, ~10 min) plus
one 12-minute turn-1 stream — the cards that didn't hang already ran at Aug 18
speed. "Environmental" in the narrow sense of dropped streams, yes; n=2 runs
can't say more.

### 7. Curator timeout/maxRetries:3 "helped" — REFUTED as stated (unfalsified)

Zero retry traces in the Aug 18 run (`terminated`/`timed out`/undici: 0 hits)
— all 12 cards succeeded first try, so the change was never exercised. The
**judge** 30-min/1-retry fix IS confirmed by before/after on identical inputs
(Aug 17: 3/3 died at 28:04 ≈ 3×10 min; retest: 2/3 passed). Also on record:
one reliability trial died at 498 s, which no 600 s timeout explains — some
"terminated" errors are not timeouts. Decision: **keep** `maxRetries: 3` (a
drop voids a paid run; the pinned timeout costs nothing) and treat it as
uncredited until a run shows a retry recovering.

### 8. Hollow-commit bug "changed shape" — CONFIRMED, but the cited baseline was misstated

The Aug 18 rejections (2/12, both "track 1 had a missing or placeholder
artist, title or note", both recovered next turn) are a genuinely different
mechanism from the pre-fix failure: early array close is now ungrammatical;
this is stub *content* in a grammatically complete card — exactly the residual
commit 4330264 predicted. The review prompt's "0/10 clean originally" is
wrong: pre-fix was 6/10 dirty (4/10 clean), post-fix probe was 10/10 clean.
83% vs 100% at n=12 vs n=10 is not distinguishable from noise. Curious
pattern, unexplained: all 4 known instances across 3 runs are track 1.

### 9. "Tests should not be folded into evals" — CONFIRMED

No eval-in-disguise in `server/test/` (all 73 are deterministic fixtures, no
network/model calls; the prompt-wording and schema assertions pin artifacts,
not behavior samples). The deterministic parts of `evals/` are already
covered by `selftest.ts`. One filing gap fixed: selftest wasn't wired into
`npm test` — it is now.

## Changed

- **`evals/grounding.ts`** (new): deterministic judge-vs-metadata date split
  per invented note, joined by `ref`; pure logic exported. On the baseline
  run: `no-year-in-note 13 | grounded 5 | mismatch 0`.
- **`evals/generate.ts`**: persists `shownReleaseDate` per track at generation
  time (via `spotify.recallByRef`), so future runs self-contain what the model
  was shown instead of depending on cache freshness.
- **`evals/selftest.ts`**: assertions for `extractYears` / `groundNote` /
  `groundRun`, including the grounded-vs-mismatch-vs-unknown boundaries.
- **`server/package.json`**: `npm test` now also runs `evals/selftest.ts`.

Verified after changes: 73/73 server tests, selftest green, `npm run
typecheck` clean, grounding output on the baseline reproduces the audit. No
paid call was made by this audit.

## Deliberately not changed

- **Judge prompt / date definition** — the world-truth definition stays; the
  disagreement is now measured alongside instead of redefined away.
- **`thresholds.json`** — calibrated on the measured 0.240, which stands.
- **`TRACK_SCHEMA` / note constraints / `duration_ms`** — product changes that
  alter model-visible schema mid-baseline. Proposed shape: add `duration_ms`
  to search rows + a note rule against asserting unseen fact types; validating
  the effect costs one generate+judge run (~$13–14 and ~90 live Spotify
  searches — a large bite of the daily quota, so schedule deliberately).
- **Content-filter test** — designed (claim 5) but paid; ~$1.20–2.40 when
  wanted.
- **Curator `maxRetries: 3`** — kept, explicitly uncredited.

Flagged guesses: Brel's classification (grounded year, invented "original
recording" framing) is a judgment call either way; the all-track-1 rejection
pattern has no explanation yet; $ figures use standard published Opus/Haiku
per-token prices.
