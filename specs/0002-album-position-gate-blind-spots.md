---
id: 0002
title: Album-position gate blind spots
status: draft            # draft → ready (human approves) → done | escalated
touches_prompt: true     # server/curator.ts (SYSTEM + gate) and evals/prompts.json change → one eval run, human-read
flag: none               # the grounding gate has no runtime switch (6815090 shipped without one); a revert is the switch
---

## Goal

A listener reads "opens their self-titled 2014 record" on a card only when
the cited Spotify row says the track is 1 of N. Album position is the
dominant invented-note shape in both judged runs: 5 of 13 invented notes in
`evals/runs/2026-08-23T05-29-26-094Z` (129 checkable, inventedRate 0.1008)
and 2 of 10 in `evals/runs/2026-08-24T20-12-17-089Z` (101 checkable,
inventedRate 0.099, 14 of 18 cards judged). Commit `6815090` (2026-08-23)
grounded the shape — search rows carry `position: "4 of 13"`, `SYSTEM`
lists position among the shown facts, and `noteGroundingReason` rule 3
bounces opener/closer claims — and the four 2026-08-23 notes it targets do
not recur. The two that survive in 2026-08-24 are the rule's blind spots:
`albumPositionContext` (`server/curator.ts:451`) counts only the word
"album", the row's album name, or off/from/on within 3 tokens as album
context, so "Opens their self-titled 2014 record" (Jane Bordeaux, row
2 of 11) passes; and Spotify's `track_number` restarts per disc, so "Opens
Songs In The Key Of Life" (row 1 of 21, the track opens disc 2) passes.
Replaying the same rule over the 2026-08-23 run's judged-*true* notes also
shows it bouncing four of them ("The decade closes on an Oscar-winning
duet", "1986's Reign In Blood closer" on an Expanded row, "a nervy little
road-panic opener", "the slow-build closer" of a tape) — a true note
rewritten into vagueness costs a turn and a fact. This spec closes the
context miss in the gate, removes the four measured false positives, and
adds one `SYSTEM` line for the multi-disc case the row cannot refute.

## Non-goals

- No change to `evals/thresholds.json` (never tier; re-baselining is
  Nadav's call) and no reading of the eval result by the factory.
- No new field in `trimItem` (`server/spotify.ts:613`, ask tier). The
  multi-disc miss needs `disc_number`; it is left to open question 1.
- No schema change (ADR 0001 — strict tool use; `TRACK_SCHEMA.note` stays
  as is). No new dependency.
- No new claim shape. The other 2026-08-24 shapes — year and album name
  copied from the cited row (Junko Yagami "1982", Montand "1980", Beach
  House "from Festival"), Guinness/chart claims, "debut", nationality, a
  returning guest — are not refutable from the row; the row *is* the
  claim for the first group (`evals/grounding.ts` exists to measure that
  disagreement) and the prompt already forbids the rest.
- No gating of `adjustCard` (its replacement notes stay ungated, as
  `makeGroundingGate`'s comment says).
- No change to the year or duration rules, the bounce cap, or the
  last-turn leniency.

## Files touched, by tier

- free:
  - `server/test/curator.test.ts` (written **first**, one slice at a time)
    — new rows in the `ROWS` fixture (`~L363`), built from the cached
    search records the invented notes actually cited (values below), and
    the tests listed in Acceptance check 1, using the file's existing
    `gTrack` / `gInput` / `lookup` helpers. Every existing `grounding
    FLAGS …` / `grounding PASSES …` test stays green — they are the
    regression guard for `6815090`.
  - `server/curator.ts` — the one seam is `noteGroundingReason(input,
    lookup)`; the edits are confined to `OPENER_RE`/`CLOSER_RE` and
    `albumPositionContext` (`L443–L461`) and rule 3 inside
    `noteGroundingReason` (`L576–L596`), plus one bullet in `SYSTEM`
    (`L289`), after the
    "Every fact in a note…" bullet:
    `- Say a track opens or closes an album, record, LP or EP only when its
    shown position says so (1 of N, or N of N). A multi-disc album's
    position restarts on each disc and a reissue's count includes bonus
    tracks, so when the position is not clearly first or last, leave the
    position out.`
    No other prose changes; `ADJUST_SYSTEM` inherits it.
  - `evals/prompts.json` — one entry, appended:
    `{ "id": "statbait-album-openers", "category": "stat-claim-bait",
    "prompt": "the greatest album-opening tracks of all time" }`.
    Category per the playbook's rule: an album position is a catalog stat,
    the same kind of lie as BPM and solo length, not a new kind. The prompt
    invites "opens X" in album context on all eight notes — the exact shape
    — and the canonical answers are multi-disc and reissued albums, which
    exercises the new `SYSTEM` line where the gate is blind.
  - `specs/0002-album-position-gate-blind-spots.md` — run record.
- ask (identity, caps, tokens — a headless run stops here): none. Stated
  explicitly: the lever needs no new `trimItem` field. `disc_number` would
  close the multi-disc miss but lives in `server/spotify.ts` and is
  deliberately out (open question 1).
- never (thresholds, runs, CI, CLAUDE.md, .claude, .env — humans only):
  none. `evals/runs/**` is read, never written.

## Acceptance checks (each one runnable)

### 1. The test list — `server/test/curator.test.ts`, one slice at a time

Each line is one `test(...)` with one logical assertion; type it, watch it
fail, write the least change to `albumPositionContext` / rule 3 that
passes it, then the next. Fixture rows (from `server/.search-cache.json`
as read on 2026-08-29; `total_tracks` under `album`):

| key | name | album | album_type | track_number of total_tracks |
|---|---|---|---|---|
| `janebordeaux` | איך אפשר | ג'יין בורדו | album | 2 of 11 |
| `montand1955` | La vie en rose | C'est si bon + 49 succès de Yves Montand (Chanson française) | album | 3 of 50 |
| `salon` | Apple | Salon Music 2025 | compilation | 11 of 45 |
| `starisborn` | Shallow | A Star Is Born Soundtrack | album | 12 of 34 |
| `reignexp` | Raining Blood | Reign In Blood (Expanded) | album | 10 of 12 |
| `telex` | Killer Cars | High & Dry / Planet Telex | single | 5 of 6 |

1. `grounding FLAGS 'opens their self-titled record' — record, LP, EP,
   debut and self-titled are album words (Jane Bordeaux, 2 of 11)` —
   Act: `noteGroundingReason(gInput([gTrack("janebordeaux", "Opens their
   self-titled 2014 record with the kind of jangly hook that should've
   traveled way beyond Israel")]), lookup)`. Assert: the reason matches
   `/track 2 of 11/`. (Red today: the gate returns `null` — measured by
   replaying the 2026-08-24 card against its cached row.)
2. `grounding PASSES an album word outside the keyword's window ('closer …
   before the record runs out', Montand, 3 of 50)` — Act: same call with
   `"1955 closer that turns the last grey light pink before the record
   runs out"`. Assert: `null`. The album word must sit within 5 tokens
   after the keyword or 3 before it; "record" nine tokens on is the tape
   metaphor. A slice that is green with no code change is kept as a guard.
3. `grounding PASSES 'opens the tape' even when the row's album is named
   elsewhere in the note (Apple, 11 of 45)` — Act: `"The dance craze of
   the year, off her Salon Music 2025 era, opens the tape hands-up"` on
   `salon`. Assert: `null`. (Red today: the album name supplies context
   and the gate bounces it as "opens the album".) Rule: a keyword whose
   object is the tape / mixtape / set / card is never an album claim.
4. `grounding PASSES 'closes on an Oscar-winning duet' — a link word
   followed by a determiner is an idiom, not an album link (12 of 34)` —
   Act: `"The decade closes on an Oscar-winning duet built to empty out a
   room in silence"` on `starisborn`. Assert: `null`. (Red today.) The
   existing wrong-album form `"Closing cut off Memories …"` (fixture
   `pylon`) must still flag — that assertion already exists; leave it.
5. `grounding PASSES a closer claim on a row whose album name carries an
   edition suffix ('Reign In Blood closer', Expanded, 10 of 12)` — Act:
   `"1986's Reign In Blood closer, thrash picking so relentless it barely
   pauses for air"` on `reignexp`. Assert: `null`. (Red today.) Rule:
   when `stripSuffixes(album.name)` differs from `album.name`, the
   shown `total_tracks` counts bonus tracks, so closer claims are a no-op;
   opener claims keep checking (bonus tracks append, they do not prepend).
6. `grounding PASSES a bare 'opener'/'closer' whose album name is more
   than 3 tokens before it — that is the tape's arc (Killer Cars, 5 of 6)`
   — Act: `"Tucked on the High & Dry / Planet Telex single in 1995, a nervy
   little road-panic opener"` on `telex`. Assert: `null`. (Red today.)
   Rule: for the noun forms only (`opener`, `closer`), the album name or
   album word must sit within 3 tokens before the noun ("Disque D'or
   opener", "MAYHEM's duet closer") or a link within 3 after; the verb
   forms (`opens`, `closes`, `opening cut`, `closing track`) keep
   album-name-anywhere. The existing `"1992's Disque D'or opener"` flag
   assertion (fixture `disquedor`) must stay green.
7. `layer-1 wording: the album-position line is pinned` — Assert:
   `SYSTEM.includes("opens or closes an album, record, LP or EP only when
   its shown position says so")`. Written after slices 1–6, before the
   prompt edit; red until the bullet lands.

### 2. Runnable gates

```sh
cd server && node --test test/curator.test.ts   # red on slice 1 first, then all green
cd server && npm test
npm run typecheck
cd client && npm run build
npm run gate
node -e 'JSON.parse(require("fs").readFileSync("evals/prompts.json","utf8"))'   # the new case parses
git diff --stat origin/main -- server/spotify.ts server/session.ts server/caps.ts server/env.ts   # empty
```

### 3. The eval leg — `docs/playbooks/change-the-curator-prompt.md` steps 2–5

Not run by the factory. `/implement` and `/review` end at
`ready-for-eval`; a human runs the following and reads the result.

Pilot the new case first, per `docs/playbooks/add-an-eval-case.md` step 2
(each step reads the latest run dir):

```sh
node evals/generate.ts --only statbait-album-openers   # real curator + Spotify resolution
node evals/judge.ts                                    # Opus + web search, one call per card
node evals/aggregate.ts                                # rates + threshold gate → summary.json
```

Read that card's entry in `evals/runs/<ts>/verdicts.json` by hand: one card
proves the prompt provokes the shape and the gate rewrites it, not a rate.
Then the playbook:

2. Preflight the quota with one search (the probe in
   `scripts/eval-baseline.sh`). No quota → nothing else is worth paying for.
3. The one eval run — the shape `evals/run-validation.sh` used on
   2026-08-23 (copy it with a new log name; it hardcodes that date):
   ```sh
   node evals/generate.ts     # all prompts through the real curator (now 19)
   node evals/judge.ts        # Opus + web search
   node evals/aggregate.ts    # exit 1 = a threshold breached
   node evals/grounding.ts    # were invented years copied from Spotify rows?
   ```
4. Contract check, k=3 on the cheap eval (plan §9):
   `node evals/reliability.ts --only app-fastest-rap --trials 3`
5. Read `evals/runs/<ts>/summary.json` against `evals/thresholds.json`
   **and** a sample of `verdicts.json` by hand. A breach means the change
   regressed truthfulness — fix the prompt, not the threshold.

The aggregate is read by a human against `evals/thresholds.json`; nothing
loops on it. What "better" looks like, for that reading: zero
album-position notes among the invented, and no judged-true note whose
wording an opener/closer bounce visibly flattened.

## Notes

### Evidence — the invented notes, by claim shape

`evals/runs/2026-08-24T20-12-17-089Z` (14 cards judged; 4 judge errors
remain: `statbait-longest-solos`, `recent-2025-best`, `recent-2026-indie`,
`artist-radiohead-bsides`). "Row" is the cached search record the note's
`ref` cites, as read 2026-08-29; "gate" is `noteGroundingReason` today.

| # | card · track | note (abridged) | judge's reason (abridged) | shape | row refutes? |
|---|---|---|---|---|---|
| 1 | app-fastest-rap #3 · Twista — Adrenaline Rush | "The title track from the album that got Twista into the Guinness Book" | Guinness entry was 1992, for the debut; five years before this album | chart-award | no ("title track" itself is true: row album = Adrenaline Rush) |
| 2 | app-fastest-rap #6 · Tech N9ne — Speedom (Wwc2) | "pulls Eminem back in for round two" | Eminem was not on Worldwide Choppers | collaboration | no |
| 3 | app-2am-drive #2 · Beach House — Myth | "Dream-pop haze from Festival" | Myth is on Bloom; no album Festival | album name | no — the row's album *is* "Festival" (2015 compilation, 18 of 40); row-agrees |
| 4 | app-hebrew-indie #0 · Jane Bordeaux — איך אפשר | "Opens their self-titled 2014 record" | track 1 is על סבון וחיסכון; this is track 2 | **album position** | **yes** — row 2 of 11; gate missed it ("record" is not "album") |
| 5 | niche-city-pop #1 · Junko Yagami — 夜空のイヤリング | "Deep cut off 1982's LONELY GIRL" | album released Feb 1983 | year | no — row shows 1982; row-agrees |
| 6 | nonenglish-hebrew-rock #7 · Knesiyat Hasechel | "their self-titled 1999 debut" | it is their third album | origin-story ("debut") | no |
| 7 | nonenglish-french-chanson #6 · Yves Montand — Les feuilles mortes | "Montand's 1980 take" | no 1980 recording; 1950 / 1968 / 1981 | year | no — row shows 1980-12-01; row-agrees |
| 8 | decade-80s-onehit #3 · Falco — Rock Me Amadeus | "topped American charts in 1985" | Hot 100 #1 on 29 Mar 1986 | chart-award | no — row release 1985, so the ±1 year rule passes |
| 9 | mood-first-warm-day #4 · Stevie Wonder — Isn't She Lovely | "Opens Songs In The Key Of Life" | opens side 3; the album opens with Love's in Need… | **album position** | **only with `disc_number`** — row 1 of 21, per-disc numbering; gate sees track 1 |
| 10 | statbait-highest-bpm #1 · Rob Gee — 1 Gabber Family | "Dutch gabber royalty" | Rob Gee is from New Jersey | origin-story | no |

Shapes: album position 2 · year (row-agrees) 2 · chart-award 2 ·
origin-story 2 · collaboration 1 · album name (row-agrees) 1. Four-way tie
at 2; album position is the only one the row can refute deterministically,
so it is the lever (a gate rule = a `node:test` case; the others could at
best be discouraged by prose).

`evals/runs/2026-08-23T05-29-26-094Z` (17 cards judged; 1 judge error:
`decade-80s-onehit`; generated *before* `6815090`):

| # | card · track | note (abridged) | shape | row refutes? |
|---|---|---|---|---|
| 1 | app-2am-drive #7 · The Midnight — Los Angeles | "Days of Thunder's longest cut" | album superlative | no (needs the whole album) |
| 2 | app-90s-roadtrip #5 · Warren G — Do You See | Nate Dogg as performer, "same Regulate sessions" | collaboration | no — row artists "Warren G, Nate Dogg"; row-agrees |
| 3 | niche-city-pop #0 · Minako Yoshida — MIDNIGHT DRIVER | "Opens MONOCHROME" | **album position** | yes — row 7 of 8; gate flags since `6815090` |
| 4 | niche-city-pop #1 · Junko Yagami | "A 1982 LONELY GIRL cut" | year | no — row 1982; row-agrees |
| 5 | niche-city-pop #7 · Minako Yoshida — 風 | "Closes LIGHT'N UP" | **album position** | yes — row 4 of 8; gate flags |
| 6 | nonenglish-hebrew-rock #0 · Ethnix — ציפור מדבר | "Opening cut off … debut album" | **album position** | yes — row 2 of 12; gate flags |
| 7 | nonenglish-french-chanson #0 · Charles Trenet — La mer | "1992's Disque D'or opener" | **album position** | yes — row 7 of 14; gate flags |
| 8 | nonenglish-french-chanson #1 · Montand — Sous le ciel de Paris | "1955" | year | no — row 1955 (a 50-track compilation); row-agrees |
| 9 | nonenglish-french-chanson #7 · Montand — La vie en rose | "1955 closer" | year | no — row 1955; row-agrees ("closer" is the tape's) |
| 10 | statbait-longest-solos #5 · Lynyrd Skynyrd — Free Bird | "9:19" | duration | no on today's cache — row 558933 ms = 9:19 (`6815090` recorded 9:08 for this ref; the cached row has changed since) |
| 11 | statbait-longest-solos #7 · Allman Brothers — Whipping Post (live) | "23:09" | duration | no on today's cache — row 1389371 ms = 23:09 |
| 12 | recent-2025-best #0 · Charli xcx — Apple | "off her Salon Music 2025 era, opens the tape" | album name | no — row album *is* the "Salon Music 2025" compilation; today's gate bounces it anyway, for the wrong reason ("opens the album", 11 of 45) — slice 3 |
| 13 | recent-2026-indie #7 · beabadoobee — Sun Has Set | "Closing cut off Memories" | **album position** | no — the cited row is the *Memories* single, 3 of 3; row-agrees (the `pylon` fixture in the test file is the judge's world, not this row) |

Shapes: album position 5 · year (row-agrees) 3 · duration (row-agrees) 2 ·
collaboration 1 · album name 1 · superlative 1. **Stable across both
runs**: album position is the top shape in each (5/13 → 2/10), the four
row-refutable 2026-08-23 cases do not recur after `6815090`, and the two
2026-08-24 survivors are the context miss and the multi-disc miss above.
Second-largest and also stable: a year or album name copied from a
compilation/reissue row (3 → 2, plus 2 durations). The gate cannot touch
that — the row is the claim — and it is what `evals/grounding.ts` was
written to count; see open question 2.

### Evidence — the rule's false positives

Replaying today's rule 3 over all 248 judged notes of both runs (34 carry
an opener/closer keyword) bounces four judged-*true* 2026-08-23 notes
(the run predates the gate, so these were never bounced live), each the
source of one PASS slice above: `mainstream-pop-anthems #7` "The decade
closes on an Oscar-winning duet" (12 of 34; slice 4),
`statbait-highest-bpm #3` "1986's Reign In Blood closer" (10 of 12 on
*Reign In Blood (Expanded)*; slice 5), `artist-radiohead-bsides #0` "a
nervy little road-panic opener" (5 of 6; slice 6), and
`mainstream-classic-rock #7` "Eight minutes off Led Zeppelin IV, the
slow-build closer" (4 of 16 on the Deluxe Edition; covered by slices 5
and 6). A fifth, `app-hebrew-indie #7` "A slow-dance closer from
'אוקיינוסים,'" (3 of 11), keeps flagging: the from-link is a genuine album
link and the judge did not check the position. Widening the album words
(slice 1) adds exactly one new hit on the 248, "before the record runs
out" (row 9 above), which slice 2's window removes. Across the 2026-08-24
run — generated with the gate live — the widened rule flags Jane Bordeaux
and nothing else.

### Build order (the `tdd` loop, one seam, vertical slices)

1. Add the six fixture rows to `ROWS`; add test 1; run
   `cd server && node --test test/curator.test.ts`; watch it fail.
2. Widen the album-word set with a window (5 after / 3 before the
   keyword); test 1 green. Add test 2 — probably green already; keep it.
3. Tests 3 → 6 in order, each red, each the least change to
   `albumPositionContext` or the closer branch of rule 3. After each, the
   existing `grounding FLAGS album-position…` and `grounding PASSES
   album-position…` tests must still pass.
4. Test 7 red; add the `SYSTEM` bullet; green. Cross-read against
   `TRACK_SCHEMA.note` (`.claude/rules/curator.md`): the schema forbids
   nothing the bullet asks for.
5. Append the `evals/prompts.json` entry; run the parse check.
6. `npm run gate`. Write the run record. Refactoring belongs to review.

### Playbooks and ADRs

- `docs/playbooks/change-the-curator-prompt.md` (prompt + gate; one eval
  run, human-read) and `docs/playbooks/add-an-eval-case.md` (one case,
  existing category, piloted with `--only`).
- ADR 0003: every rule here has one right answer per note-and-row, so it
  is a `node:test`; whether the *rewritten* notes are true is model-graded,
  so that is the eval leg. ADR 0001: no schema change. `.claude/rules/
  curator.md` and `.claude/rules/evals.md` bind (no threshold edits,
  `runs/` is evidence).
- Precedent: `928af80` → `b7c09eb` took invented notes 24.0% → 10.1%;
  `6815090` grounded this shape and predicted, did not measure, its effect
  — the 2026-08-24 run is that measurement (5 → 2).

### Cost of the eval leg

From the curator playbook: judge ≈ $1.18/card, **$12.95 for an 11-card
run**, ~2.9 min/card; **~90 live Spotify searches — the day's whole quota**,
so nothing else runs against Spotify that day. With the new case the full
run is 19 prompts (≈ $22 at the playbook's per-card figure; cache hits make
re-runs of the same prompts cheaper). The pilot is one card: ≈ $1.18 and up
to `SEARCH_BUDGET` = 20 searches. Wall clock has ranged 32 min to ~5 h.

### Open questions (headless run — reading taken in brackets)

1. The multi-disc miss (row 9) is refutable only with `disc_number` in
   `trimItem` — one ask-tier line in `server/spotify.ts` plus a fixture in
   `server/test/spotify.test.ts`. Include it here, stopping the headless
   run, or defer? [Defer: 1 of 10 notes, and the `SYSTEM` bullet covers
   it in prose. A follow-up spec can add the field and the rule "track
   1 on disc > 1 is not an opener" as a single slice.]
2. Two runs in a row show 3–5 invented notes that copied the cited row's
   own year/album name from a compilation or reissue. Is that a curator
   failure to fix (e.g. show `album_type` to the model and have the prompt
   say a compilation's year is not the recording's) or a judge-vs-metadata
   disagreement to report separately? [Neither is this spec. Flagging it
   for the human reading of `node evals/grounding.ts` in step 3.]
3. Should the four false positives be fixed at all, given a bounce degrades
   to an accepted card after two rounds? [Yes: a bounce spends a turn of
   `MAX_TOOL_TURNS` = 8 and rewrites a true fact into an image; the
   measured cost is 4 of 113 true notes in one run.]
4. Is one `SYSTEM` bullet enough to count as the "prompt-touching" dry
   run of `docs/factory/plan.md` §6, or should the factory's second run
   wait for a bigger prompt change? [Enough: `touches_prompt: true` is
   decided by the file, not the diff size, and the eval leg is the same
   either way.]
