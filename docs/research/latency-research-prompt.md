# Research prompt — cut mixtape latency without losing quality

Paste everything below into a fresh session opened in `~/Projects/mixtape-poc`.

---

You are researching **how to make a mixtape generate faster without degrading
quality**. This is a research + measurement task. Do not refactor the app
before you have numbers.

## The system, as it actually is

Read these before proposing anything: `README.md`, `server/curator.ts`,
`server/spotify.ts` (search + cache + quota), `server/index.ts` (SSE stages),
`evals/reliability.ts`, `evals/aggregate.ts`, `evals/metrics.ts`.

Facts to start from (verify them, they may have moved):

- One agent loop does everything: `runCuratorAgent` in `server/curator.ts:465+`.
  There is no separate "planning model" and no `thinking` parameter anywhere in
  `server/` — but the model thinks anyway: 20 of ~26 turns in the 2026-08-17 log
  and every turn in the 2026-08-18 run emit `thinking` blocks. So thinking is on
  by default, unbudgeted and unmeasured, including on turn 1 whose only job is
  choosing a few search queries. **Capping or disabling thinking on the search
  turn while keeping it for the commit turn is the cheapest lever on this page**
  — one parameter, immediately measurable, and it cannot change who picks the
  tracks, so it does not need the taste eval from Step 1.5 to be safe. Try it
  before any model split. Beyond that, it is a single `claude-sonnet-5`
  (`curator.ts:10`) tool loop that alternates `search_spotify` turns with a
  final `create_mixtape` commit.
- Constants that shape wall-clock: `MAX_TOOL_TURNS = 8` (`curator.ts:260`),
  `SEARCH_BUDGET = 20` (`:269`), `SEARCH_CONCURRENCY = 2` (`:272`),
  `max_tokens: 4000` per turn (`:508`), `TRACK_COUNT = 8` (`:11`).
- Every model turn re-sends the full message history with a static system
  prompt and a static tool list. **No `cache_control` anywhere** — check
  whether prompt caching would help before assuming it would.
- Spotify search results are disk-cached (`server/spotify.ts`, `.search-cache.json`,
  7-day TTL) — a repeated prompt is much cheaper and faster than a cold one.
  Any latency measurement must state whether the cache was warm or cold, and
  must not compare a warm run against a cold one.
- Tracks already stream to the client as the model writes them, so some of the
  perceived time is already overlapped. Treat **perceived** latency (time to
  first track, time to a usable card) and **total** latency as two separate
  metrics; a lever that only helps one still counts, but say which.

## Step 0 — the harness was broken; it has since been fixed

Do not redo this work. Commit `8e0a94a` (2026-08-18) fixed all three defects
that voided the 2026-08-17 baseline: explicit client timeouts on both the
curator and the judge, a reliability denominator that no longer blames the model
for a dropped socket, and a validity gate so a run that measured nothing can no
longer exit 0. The 12-prompt run in `evals/runs/2026-08-18T07-45-44-348Z/`
generated 12/12 cards with zero `terminated` failures, which is the practical
confirmation.

Two residuals only:

1. The `terminated` root cause is **fixed but not fully explained** — one trial
   died at 498s with two turns already done, which no fixed 600s bound accounts
   for. `runTrial` now records an `errorClass`, so if it recurs, read that
   before paying for another run.
2. **`evals/runs/2026-08-17T10-21-53-412Z/reliability-summary.json` holds voided
   numbers** (`cleanFirstCommitRate 0.4`, `passHatK 0`) computed on the wrong
   denominator. There is currently **no valid reliability baseline** — re-run
   `evals/reliability.ts` before using pass^k as a quality gate.

## Step 1 — instrument, then baseline

There is currently no per-stage timing in the app: the only latency number
anywhere is `meanMs` in `evals/reliability.ts`. So first add lightweight timing
(per model turn: TTFT, turn duration, input/output tokens; per Spotify search:
duration + cache hit/miss; plus end-to-end) and emit it into the existing
logbook, so every later claim is backed by a real distribution, not one run.

Then take a baseline over a fixed prompt set (use `evals/prompts.json`), several
trials each, and record the breakdown: how much of the wall clock is model
generation vs. Spotify I/O vs. serialized turn round-trips. **Optimize what the
breakdown says dominates.** If it turns out model output tokens dominate, most
of the ideas below are noise.

Known numbers to start from (all from the healthy 12-prompt run,
`evals/baseline-logs/fullrun-1045.log`, cold search cache):

- **~35s per card end-to-end** in the harness (generate stage 10:45:44 →
  10:53:06 for 12 cards, minus a 1.5s inter-prompt sleep).
- **3 LLM calls per card on average** — turn distribution over 12 runs was
  12 / 12 / 8 / 4, i.e. every run took 2 turns, two-thirds took 3, a third took
  4. Ceiling is 8. Spotify searches are HTTP, not model calls.
- The old `meanMs` of ~445s is **void** — it came from the broken run and
  averaged in hung trials.

**The biggest open discrepancy, and probably the first thing to chase:** the
same code is ~35s per card in the local harness but has been measured at
**84s–674s live on Railway**. That is a 2-20x environmental gap that dwarfs
every prompt-level lever below. Prime suspect: Railway's ephemeral disk wipes
`server/.search-cache.json` on every redeploy, so production frequently runs
cold while local runs warm. Measure local vs. deployed with the same
instrumentation *before* optimizing tokens — if the gap is the cache, the fix is
a Railway volume, not a model change.

## Step 1.5 — one eval gap you must close before testing a model swap

Do **not** build a pile of new evals before the research; the existing two plus
timing instrumentation cover most of it. But there is exactly one gap that the
headline idea walks straight into:

**Nothing measures whether the mixtape is any good.** `judge.ts` classifies
liner-note *truthfulness* (generic / specific-subjective / specific-checkable,
then true / invented / unverifiable). `reliability.ts` measures whether the
model *fills the schema*. A Haiku-curated card can be fully truthful, fully
complete, fully resolvable on Spotify — and be an obvious, boring, off-prompt
mixtape. Both harnesses would call that a pass. So "no quality degradation" is
currently unmeasurable for the exact change being proposed.

Close it with the cheapest thing that works, not a rubric:

- **A blind pairwise judge.** Same prompt, two cards (baseline vs. candidate),
  order randomized, judge picks which better fits the prompt and says why.
  Pairwise is both cheaper and far more sensitive than absolute 1-5 scoring,
  and ties are a legitimate verdict. Report win/loss/tie over the prompt set.
- **Mechanical checks that cost no tokens**, in the same pass: same-artist
  repeats, duplicate tracks, obvious-hit concentration, era/genre match where
  the prompt states one, and the resolution rate you already compute.

That is the whole addition. Resist adding a diversity score, a note-style
rubric, or a taste model — none of them are needed to answer "did this get
worse", and each one is another thing to maintain and pay for.

## Step 2 — the levers

The idea that prompted this: **use a cheaper/faster model (e.g. Haiku 4.5) for
one of the steps.** Note that this is not a drop-in today — there is only one
step. Making it real means splitting the loop, e.g.:

- Haiku runs the search/verification turns (mechanical: pick queries, copy refs
  from result rows), Sonnet writes only the final card and liner notes.
- Or a cascade: Haiku drafts a candidate track list, Sonnet verifies + writes.
- Or per-track note writing fanned out in parallel to Haiku after the list is
  fixed.

Evaluate that seriously, including the cost of splitting (extra prompt
re-sends, extra round-trips, more places for the contract to break), and then
evaluate at minimum these other candidates on the same footing:

1. **Prompt caching** on the static system prompt + tool definitions, and on the
   growing message prefix across turns.
2. **Fewer serialized round-trips** — the loop is turn-bound; each turn is a
   full generation. Can the card be committed in fewer turns (better search
   batching, a first turn that is forced to search broadly)?
3. **`SEARCH_CONCURRENCY = 2`** — is 2 still the right number, or is it leftover
   caution from the rate-limit work? Find the real Spotify limit empirically and
   raise it only as far as the measurement supports.
4. **Speculative / overlapped Spotify work** — start resolving track 1 while the
   model is still writing track 8; prefetch likely queries.
5. **Output size** — `max_tokens: 4000` per turn, and liner-note length. Output
   tokens are usually the single biggest latency term. What does shortening
   notes actually buy, in ms and in quality?
6. **Anything the profile reveals** that is not on this list. The list is a
   starting point, not a scope.

## Step 3 — the quality bar (non-negotiable)

A speedup that costs quality is not a result. Every candidate must be measured
against the existing harnesses, not vibes:

- `evals/reliability.ts` — clean-first-commit rate, **pass^k** (not pass@k).
  This is the one that caught the 6/10 hollow-commit bug.
- `evals/generate.ts` → `judge.ts` → `aggregate.ts` — invented rate,
  verified-true rate, resolution rate.
- The pairwise prompt-fit comparator from Step 1.5 — required for any lever
  that changes which model picks the tracks or writes the notes. A lever that
  only touches I/O (caching, concurrency, prefetch) does not need it.
- Invariants that must survive: the eight-required-keys schema shape (see
  "Constraints worth knowing" in the README — do not reintroduce an array),
  every track backed by a real search result with a copied `ref`, unverified
  tracks still shown and marked rather than hidden.

Read the README's constraints section before proposing prompt-wording fixes:
wording has already been measured as ineffective for the failure mode there.

## Step 4 — cost discipline

Generation, judging and reliability runs cost real API money, and the run window
is shared with everything else. Before spending: state the plan, the number of
API calls, and a rough cost, and get approval. Prefer a cheap pilot (one prompt,
few trials) to size an effect before paying for a full sweep. If a lever can be
ruled in or out offline, do that first.

## Deliverable

A written report at `docs/research/latency-findings.md` containing:

1. What was wrong with the eval harness and what you did about it (Step 0),
   including anything you could not fix and why.
2. The measured baseline and the wall-clock breakdown, with cache state stated.
3. A ranked table: lever → measured (or estimated, labeled as such) ms saved →
   quality delta on the metrics above → implementation risk → effort.
4. A clear recommendation: what to do first, what to skip and why, and what
   could not be answered without more spend.
5. Honest negatives. A lever that turned out not to matter is a finding worth
   writing down, and so is "the dominant cost is X and none of these touch it".

Do not change production behaviour as part of this research beyond the timing
instrumentation and the harness fixes. If you want to prototype a lever, do it behind a flag or on a
branch, and say so.
