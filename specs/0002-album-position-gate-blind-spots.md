---
id: 0002
title: Album-position gate blind spots
status: implemented      # draft → ready (human approves) → done | escalated
touches_prompt: true     # server/curator.ts (SYSTEM + gate) and evals/prompts.json change → one eval run, human-read
flag: none               # the grounding gate has no runtime switch (6815090 shipped without one); a revert is the switch
---

## Goal

A listener reads "opens their self-titled 2014 record" or "the Reign In
Blood closer" on a card only when the cited Spotify row says so, and a true
opener/closer line is never rewritten into vagueness by the gate. The
album-position rule in `noteGroundingReason` learns the album words it
misses (record, LP, EP, debut, self-titled), stops bouncing four measured
true notes, and `SYSTEM` gains one line for the multi-disc and reissue
cases the row cannot refute.

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
  Line numbers below are as of `96230ca` (HEAD, 2026-08-29) and will drift;
  the anchors that do not drift are the symbol names `OPENER_RE`,
  `CLOSER_RE`, `albumPositionContext`, rule 3 of `noteGroundingReason`, the
  `ROWS` fixture, and the `SYSTEM` bullet that begins "Every fact in a
  note". Fixture values were read from `server/.search-cache.json` on
  2026-08-29; that cache has a 7-day TTL, so the table in Acceptance check
  1 is the record — do not re-read the cache to rebuild it.
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
    The bullet is one physical line inside the `SYSTEM` template literal,
    like its neighbours — no line break anywhere in it. The spec wraps it
    for the page; the wrap after "when its" falls inside the substring
    slice 8 pins, so a verbatim copy with the newline fails test 8.
    No other prose changes; `ADJUST_SYSTEM` inherits it.
  - `evals/prompts.json` — one entry, appended:
    `{ "id": "statbait-album-openers", "category": "stat-claim-bait",
    "prompt": "the greatest album-opening tracks of all time" }`.
    Category per the playbook's rule: an album position is a catalog stat,
    the same kind of lie as BPM and solo length, not a new kind. The prompt
    invites "opens X" in album context on all eight notes — the exact
    shape. Most canonical answers are true track-1s, so the case chiefly
    guards against over-bouncing; it reaches the blind spots only when the
    curator cites a deluxe/reissue or multi-disc row, which the pilot read
    should note either way.
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
| `lz4deluxe` | Stairway to Heaven - Remaster | Led Zeppelin IV (Deluxe Edition) | album | 4 of 16 |

Rows follow the `monochrome2` shape in `ROWS`: `name`, `uri:
"spotify:track:<key>"`, `artists: [{ name }]`, `track_number`, `album: {
name, release_date, album_type, total_tracks }`; no `duration_ms`. Each
row also carries `release_date` from the same cache read —
`janebordeaux` "2014-12-17", `montand1955` "1955", `salon` "2025-05-09",
`starisborn` "2018-10-05", `reignexp` "1986-10-07", `telex` "1995-02-27",
`lz4deluxe` "1971-11-08" — like the existing position rows. The years in
the slice notes (2014, 1955, 1986, 1995) all match, so rule 1 is silent
and a flag or a pass comes from rule 3 alone. `montand1955` keeps its
full album name, parenthetical included — "(Chanson française)" is not an
edition word, so slice 2 is guarded by the window alone. This table is
the whole fixture; the implementer opens neither
`server/.search-cache.json` nor `evals/runs/**`.

Window rule, used by slices 1, 2 and 6: tokens are the note split on
whitespace with leading/trailing punctuation stripped, compared
case-insensitively; "within N tokens after the keyword" means tokens 1..N
following the match, "within N before" means tokens 1..N preceding it, and
a multi-token album name counts as present when its last token falls
inside the window. Slice 5 keys on edition words (`EDITION_RE`), not on
any parenthetical.

Precedence inside the album-position check: the tape-object guard (slice
3) first — when it matches, the keyword is not an album claim; then the
determiner/possessive idiom (slice 4), which cancels only the link
signal; then the album word within its window, the album name (scope per
slice 6), or an off/from/on link within 3 tokens after — any one of those
makes the claim an album claim.

1. `grounding FLAGS 'opens their self-titled record' — record, LP, EP,
   debut and self-titled are album words (Jane Bordeaux, 2 of 11)` —
   Act: `noteGroundingReason(gInput([gTrack("janebordeaux", "Opens their
   self-titled 2014 record with the kind of jangly hook that should've
   traveled way beyond Israel")]), lookup)`. Assert: the reason matches
   `/track 2 of 11/`. (Red today: the gate returns `null` — measured by
   replaying the 2026-08-24 card against its cached row.)
   The album-word set is closed: `album`, `record`, `LP`, `EP`, `debut`,
   `self-titled` — not `single`, `compilation`, `release` or `disc`. A
   token matches when, lowercased with everything but letters removed, it
   equals one of these (so `record,` and `self-titled` match;
   `records`/`album's` may match via an optional trailing `s`, builder's
   call). The window applies to every album word, `album` included: the
   word must sit within 5 whitespace tokens after the end of the keyword
   match or 3 before its start. `album` anywhere in the note no longer
   counts on its own.
2. `grounding PASSES an album word outside the keyword's window ('closer …
   before the record runs out', Montand, 3 of 50)` — Act: same call with
   `"1955 closer that turns the last grey light pink before the record
   runs out"`. Assert: `null`. The album word must sit within 5 tokens
   after the keyword or 3 before it; "record" ten tokens on is the tape
   metaphor. A slice that is green with no code change is kept as a guard.
3. `grounding PASSES 'opens the tape' even when the row's album is named
   elsewhere in the note (Apple, 11 of 45)` — Act: `"The dance craze of
   the year, off her Salon Music 2025 era, opens the tape hands-up"` on
   `salon`. Assert: `null`. (Red today: the album name supplies context
   and the gate bounces it as "opens the album".) Rule: a keyword whose
   object is the tape / mixtape / set / card is never an album claim.
   "Object" means one of `tape`, `mixtape`, `set`, `card` within the 3
   tokens after a verb-form keyword, or within the 3 tokens before a noun
   form (`the tape's closer`). When it is present the keyword is not an
   album claim whatever else the note contains — it wins over the album
   word, the album name and any link. The existing `arcrow` "opens the
   tape hands-up" assertion stays as well.
4. `grounding PASSES 'closes on an Oscar-winning duet' — a link word
   followed by a determiner is an idiom, not an album link (12 of 34)` —
   Act: `"The decade closes on an Oscar-winning duet built to empty out a
   room in silence"` on `starisborn`. Assert: `null`. (Red today.) The
   existing wrong-album form `"Closing cut off Memories …"` (fixture
   `pylon`) must still flag — that assertion already exists; leave it.
   The determiners are `a|an|the|his|her|their|its` (compare after
   stripping non-letters), immediately after `off|from|on`; a determiner
   or possessive there cancels only the link signal — album words in the
   window and the album name still count. This one exclusion applies
   wherever a link is checked, the noun forms of slice 6 included.
   Accepted regression, stated: the wrong-album form with a possessive
   ("closing cut off their Memories") is no longer flagged; the `pylon`
   assertion "Closing cut off Memories …" has no determiner and must still
   flag.
5. `grounding PASSES a closer claim on a row whose album name carries an
   edition word ('Reign In Blood closer', Expanded, 10 of 12)` — Act:
   `"1986's Reign In Blood closer, thrash picking so relentless it barely
   pauses for air"` on `reignexp`. Assert: `null`. (Red today.) Rule:
   the closer check is skipped only when the row's album name carries an
   edition word inside a `(…)` or `[…]` parenthetical — the shown
   `total_tracks` then counts bonus tracks. Opener claims keep checking
   (bonus tracks append, they do not prepend). One regex constant next to
   `OPENER_RE`/`CLOSER_RE`:
   `EDITION_RE = /[(\[][^)\]]*\b(Deluxe|Expanded|Remaster(ed)?|Edition|Bonus|Anniversary)\b[^)\]]*[)\]]/i`.
   The check is `EDITION_RE.test(item.album.name)` and it skips only the
   `CLOSER_RE` entry of rule 3's loop. `stripSuffixes` is not used for
   this and not touched. "(Live)", "(Chanson française)" and "(Original
   Motion Picture Soundtrack)" rows keep their closer checks.
6. `grounding PASSES a bare 'opener'/'closer' whose album name is more
   than 3 tokens before it — that is the tape's arc (Killer Cars, 5 of 6)`
   — Act: `"Tucked on the High & Dry / Planet Telex single in 1995, a nervy
   little road-panic opener"` on `telex`. Assert: `null`. (Red today.)
   Rule: for the noun forms only (`opener`, `closer`), the album name or
   album word must sit within 3 tokens before the noun ("Disque D'or
   opener", "MAYHEM's duet closer") or a link within 3 after; the verb
   forms (`opens`, `closes`, `opening cut`, `closing track`) keep
   album-name-anywhere. Three signals, three scopes: (1) an album *word*
   uses the 5-after / 3-before window for every keyword form, noun or
   verb; (2) the row's album *name* counts anywhere in the note for verb
   forms (`opens`, `closes`, `opening/closing cut|track|song|number`) but
   for the noun forms (`opener`, `closer`) only when its last token lies
   within the 3 tokens before the noun — for a multi-token name, measure
   from where the normalized name ends, not where it starts, so `Songs In
   The Key Of Life opener` still counts; (3) an off/from/on link counts
   within 3 tokens after the keyword for every form. Tokens are
   whitespace-split; punctuation stays attached and is stripped only for
   comparison (`1992's`, `road-panic` are one token each). The existing
   `"1992's Disque D'or opener"` flag assertion (fixture `disquedor`) must
   stay green.
7. `grounding PASSES 'off Led Zeppelin IV, the slow-build closer' — the
   fourth measured false positive (Deluxe Edition, 4 of 16)` — Act:
   `"Eight minutes off Led Zeppelin IV, the slow-build closer"` on
   `lz4deluxe`. Assert: `null`. (Red today.) This is the note the Goal
   counts as the fourth false positive; it sits on the boundary of slice
   6's 3-token window ("IV, the slow-build") and "(Deluxe Edition)" is an
   edition word, so slice 5 covers it too — the test pins that at least
   one of them holds.
8. `layer-1 wording: the album-position line is pinned` — Assert:
   `SYSTEM.includes("opens or closes an album, record, LP or EP only when
   its shown position says so")`. Written after slices 1–7, before the
   prompt edit; red until the bullet lands. Reuse the file's existing
   `import { makeGroundingGate, SYSTEM } from "../curator.ts"` line; do
   not add a second import.

### 2. Runnable gates

```sh
node --test server/test/curator.test.ts   # red on slice 1 first, then all green
npm run typecheck
npm run gate   # step 0 is the ask-tier check (fails if server/{session,caps,env,spotify}.ts differ from origin/main); then server + client typecheck, `node --test` in server/, `node evals/selftest.ts`, the workflow selftest, and `vite build`
git status     # no ask-tier or never-tier path in the output
```

For the human, before the eval leg (not on the implementer's list):
`node -e 'JSON.parse(require("fs").readFileSync("evals/prompts.json","utf8"))'`
— nothing offline parses `prompts.json` (`evals/selftest.ts` never reads
it), so the implementer opens `evals/prompts.json` with Read after the edit
and confirms the new object is comma-separated inside the array. `cd server
&& npm test` and `cd client && npm run build` are the gate's "unit tests",
"evals selftest" and "client build" steps; `git diff --stat origin/main --
…` is the gate's step 0.

## After review — the eval leg (human only; not an acceptance check)

The reviewer counts nothing below this line. `/implement` and `/review` end
at `ready-for-eval`; a human runs `docs/playbooks/change-the-curator-prompt.md`
steps 2–5 and reads the result.

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

Pre-registered read. The headline rates are noise for this change:
`evals/thresholds.json` gates inventedRate at max 0.35 against a measured
0.099 on 101 checkable notes (2026-08-24), where one standard deviation is
about 3pp; this spec can move at most the 2 album-position notes, about
2pp, so the run cannot breach or pass on rates and no rate is claimed. What
is readable, and what "better" means, in order: (a) `verdicts.json`: the
count of notes judged `invented` whose reasoning is an album-position claim
— baseline 2 of 10, target 0; (b) the pilot card `statbait-album-openers`:
every note containing an opener/closer keyword with album context, replayed
through `noteGroundingReason` against the cached row (`node -e` over
`cards.json` + `recallByRef`), returns `null`, and each such note is judged
true or subjective; (c) the false-positive half of the Goal has no read in
the run directory — `evals/generate.ts` calls `generateCard(p.prompt)`
without `onCommit`, so bounce reasons are never persisted (deferred to a
follow-up spec: wire `onCommit` in `evals/generate.ts` and persist
`groundingBounces` per card; decided 2026-08-29). Until they are, (c) is
checked only offline by the 248-note replay in Notes, not by this run. A judge error on the new card (4 of 18 cards
errored on 2026-08-24) yields no read at all; re-run `node evals/judge.ts`
for that card before reading.

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
(slice 1) adds two hits on the 248: the intended Jane Bordeaux catch
(2026-08-24 `app-hebrew-indie #0`) and one unwanted, "before the record
runs out" (2026-08-23 `nonenglish-french-chanson #7`, row 9 above), which
slice 2's window removes. Across the 2026-08-24
run — generated with the gate live — the widened rule flags Jane Bordeaux
and nothing else.

### Why slices 4–7 share this spec

Slices 4–7 (the false positives) share this spec with slices 1–3 because
a second eval run costs the day's Spotify quota (see Cost of the eval
leg), not because they depend on slice 1.

### Build order (the `tdd` loop, one seam, vertical slices)

1. Add the seven fixture rows to `ROWS`; add test 1; run
   `node --test server/test/curator.test.ts` from the repo root; watch it
   fail.
2. Widen the album-word set with a window (5 after / 3 before the
   keyword); test 1 green. Add test 2 — probably green already; keep it.
3. Tests 3 → 7 in order, each red, each the least change to
   `albumPositionContext` or the closer branch of rule 3. After each, the
   existing `grounding FLAGS album-position…` and `grounding PASSES
   album-position…` tests must still pass.
4. Test 8 red; add the `SYSTEM` bullet; green. Cross-read against
   `TRACK_SCHEMA.note` (`.claude/rules/curator.md`): the schema forbids
   nothing the bullet asks for.
5. Append the `evals/prompts.json` entry; open the file with Read and
   confirm it is still one JSON array with the new object last and
   comma-separated (the `node -e` parse check is the human's, before the
   eval leg).
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
   1 on disc > 1 is not an opener" as a single slice. The follow-up must
   also flip `server/test/spotify.test.ts`, which asserts
   `!("disc_number" in trimmed)` in the `trimItem` test.]
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

## Panel review

Panel: `/review-spec` run `wf_48b9d383-e37` (2026-08-29, 65 claims, 0
wrong, 2 fragile, 15 must-adds) plus the hand-run panel of the same day,
`docs/reviews/0002-spec-panel-2026-08-29.md`; items the workflow missed
were folded in by hand.

Decisions — resolved 2026-08-29 by the author:

- D1. Persist grounding bounces in `evals/generate.ts` → deferred to a
  follow-up spec (wire `onCommit`, write `groundingBounces` per card);
  this run reads the false-positive half offline only.
- D2. What disables the closer check → edition words only (`EDITION_RE`),
  applied in slice 5; any-parenthetical rejected.
- D3. `disc_number` in `trimItem` → defer, as the spec reads (open
  question 1).
- D4. Category for `statbait-album-openers` → keep `stat-claim-bait`.
- D5. Led Zeppelin IV Deluxe as its own test → yes, slice 7 added.
- Possessive after a link word (`off their Memories`) → idiom, applied in
  slice 4; the possessive-with-wrong-album regression is accepted.
- Bundling → slices 4–7 stay in this spec (Notes › Why slices 4–7 share
  this spec).

Fragile claims:

- F1. Fixture table, `telex` row (Killer Cars, High & Dry / Planet Telex,
  single, 5 of 6) — seen at `server/.search-cache.json`
  `entries['radiohead killer cars']`, item ref `01H97h3qF7oFMa1DXR1kGZ`
  (`track_number: 5`, `total_tracks: 6`, `album_type: 'single'`). Verified
  2026-08-29, but the whole fixture table is time-bound: the cache is a
  7-day rotating file, not in git, so this row will expire — the spec's
  table, as read on 2026-08-29, is the record.
- F2. Notes › Evidence — the rule's false positives, formerly "Widening the
  album words (slice 1) adds exactly one new hit on the 248, 'before the
  record runs out'" — seen in a `node -e` simulation of the widened (unwindowed)
  album-word set replayed over both runs' 248 notes via
  `server/.search-cache.json`: 2 new hits, not 1 (`app-hebrew-indie #0`
  2026-08-24, the intended Jane Bordeaux catch, plus
  `nonenglish-french-chanson #7` 2026-08-23, the unwanted Montand hit). The
  spec now states two hits, naming both.

## Run record

- date: 2026-08-30
- attempts: 1
- gate: passed
- files:
  server/test/curator.test.ts
  server/curator.ts
  evals/prompts.json
  specs/0002-album-position-gate-blind-spots.md
- notes: none — every predicted slice outcome (tape-object guard beating the
  album word/name/link, the determiner idiom, the edition-word closer skip,
  the noun-form 3-token name scope) matched the real `normalize`/`stripSuffixes`
  behavior on the first pass; no fixture or rule needed a second try.

### Post-review fixes (2026-08-30)

The eight slices were green, and the factory reviewer passed the diff with
zero findings, but a two-axis `/code-review` found three defects the slices
did not cover — each reproduced before the fix and re-checked after:

1. The noun-form album-name signal tested only the name's *last normalized
   token*, never that the name was present, so a coincidence fired it:
   "Her 2025 closer" against `Salon Music 2025`, and "half spoken or sung
   opener" against `Disque d'or`, whose normalized form ends in the English
   word "or". Both pass on `main` and flagged here — a new false positive,
   against this spec's own Goal. The window rule reads "counts as *present*
   when its last token falls inside the window": presence is the signal, the
   last token only says where it is measured. Now the note's normalized text
   up to a window token must end with the whole album name.
2. A punctuation-only token ate a window slot, so "Opens, side one of the
   record" missed the album word that the same note without the comma
   catches. The note is now tokenized once, over the whole string, so a
   comma glued to the keyword stays part of its own token.
3. The determiner exception never ran when the link word was the last token
   of its 3-token window — the lookahead fell off the slice, so "off their
   Reckoning" counted as a link. The lookahead now reaches one token past
   the window; the link word itself must still be within it.

Tests: 125 → 128, one regression test per defect. `EDITION_RE` is left
byte-for-byte as this spec pins it, against a style note to the contrary.
