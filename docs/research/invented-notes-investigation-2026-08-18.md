# Invented liner notes: root cause + fix design — 2026-08-18

Two parallel investigations into the 24% invented-note baseline (18/75
checkable, run `2026-08-18T07-45-44-348Z`, plus 2/12 in the Aug-17 run —
corpus n=20, every one on a `resolved: true` track). One investigated the
elicitation side (why the model invents), one the data/enforcement side (what
could ground or catch the inventions). Read-only; no paid calls were made.
Follows `eval-findings-audit-2026-08-18.md`.

## Root cause, in one paragraph

The system prompt's note rule — *"a detail, a moment, a stat"* — is a direct
elicitation of exactly the claim shapes that fail (stats → BPM/duration/take
counts, moments → timestamps), with no accuracy channel anywhere in prompt or
schema. The fault line in the data is **claim type × documentation depth**:
canonical lore and coarse stats survive for canon-tier songs (Free Bird "over
nine minutes" — true) and fail below that tier (Barbara "six aching minutes" —
4:08); timestamps, take counts, lyric quotes, and associative credits fail
*even for famous songs* (Stairway, Layla, Comfortably Numb, Campus). Both
false credits in the corpus (Kadomatsu, Aviv Geffen) are **hot-in-context
associations** — the curator had searched those exact artists in the same
conversation. And the model's two best categories point at the formula: the
0%-invented `artist-radiohead-bsides` card's notes are all *shown catalog fact
+ one subjective texture image* — every b-side placement claim was literally
the `album` field of a search row it saw.

## Corpus (n=20, by load-bearing failed claim)

| Claim type | n | Knowable from shown rows {artist,title,album,year}? |
|---|---|---|
| Duration (track/section length) | 4 | No — `duration_ms` fetched from Spotify but discarded by `trimItem` |
| Timestamp / event position | 3 | No |
| Credit/attribution (producer, label, project, instrument, sample) | 5 | No |
| Album/era structure ("title track", "Brat-era") | 2 | Manchild was refutable **by the row the model itself quoted** |
| Date faithfully repeating shown metadata | 3 | Yes — grounded; judge-definition floor (see audit), untouchable by elicitation |
| Lyric quote | 1 | No |
| BPM (+origin) | 1 | No |
| Take count | 1 | No |

The 55 verified-true notes get right: row-anchored album/year/placement facts,
canonical lore of mega-famous songs, coarse stats of canon-tier tracks, and
single-placement claims — the fix must not kill these.

## Fix, layer 1 — elicitation (free, prompt-only)

Replace `server/curator.ts:302` ("a detail, a moment, a stat") with:

```
- Notes must feel human and specific, not AI-generic — a catalog fact, a piece of lore, an image of the sound.
- Every fact in a note must be either something a search result showed you (artist, title, album, year) or something so famous you would stake the whole tape on it. Merely pretty sure means leave it out.
- Never put a number in a note that no search result showed you: no track lengths, no timestamps, no BPMs, no take counts. Never quote a lyric from memory. Never name a producer, label, sample, or side-project unless that connection is what the song is famous for.
- When you have no fact, describe the sound instead — what the track does to the room, the road, the hour. A vivid image beats a shaky stat, and both beat a generic compliment.
```

`TRACK_SCHEMA.note` description (line 84–85) becomes:

```
"One concrete reason this track earns its place — a fact a search result showed you, lore you'd stake the tape on, or a vivid image of the sound. No unseen numbers, remembered lyrics, or guessed credits. Max 18 words. Never generic."
```

`ADJUST_TOOL` note description (line 203): "Same rules as create_mixtape
notes: shown facts, staked lore, or a vivid image of the sound — no guessed
specifics. Max 18 words."

The "describe the sound" escape hatch routes pressure into the safe
`specific-subjective` class (unchecked, ungated, and the product's charm) —
the model already does this unprompted on stat-bait cards. Per-note
predictions over the Aug-18 18: **10 confidently prevented, 3 firm survivors
(the grounded-date floor), 5 uncertain** → predicted inventedRate ~0.07–0.11,
predicted genericRate 0.06–0.12 (gate 0.15). Residual no prompt can fix:
miscalibrated confidence ("Brat-era", "Rotterdam") — the case for layer 3.

A `note_kind` enum in the schema (grammar-enforceable, unlike `minItems`) was
considered and **rejected for round one**: the grammar validates the label,
not the note; it's a model-visible schema change ×8 tracks ×2 tools that
invalidates baseline comparability; and its value lives entirely in a
post-hoc lint that doesn't exist yet. Hold as lever two.

## Fix, layer 2 — data + deterministic gate (free)

**Field expansion** (verified against the current /search reference:
`duration_ms`, `explicit`, `track_number`, `disc_number`, `external_ids.isrc`,
`album.album_type`, `album.total_tracks` are all still on the wire of requests
the app already pays for; `popularity` and `preview_url` are deprecated —
skip). Keep in `trimItem`: `duration_ms`, `isrc`, `track_number`,
`album_type`, `total_tracks`. Show the model one new row field:
`length: "4:08"` (omit when null). All six duration-claim refs were verified
present in the cache — the data crossed the wire during the run and was
thrown away. Adding a tool_result key does NOT touch tool schemas, so the
compiled-grammar cache is unaffected. **Cache migration: do nothing** — treat
missing fields as null/no-op; the 7-day TTL self-heals, and invalidating would
burn quota.

**Deterministic pre-pass**: compose into the existing bounce path —
`incompleteReason: (i) => cardIncompleteReason(i) ?? noteGroundingReason(i)` —
with a cap of 2 grounding bounces per run, then accept-and-log (a false
positive must degrade to a shipped card, never a dead run). Rules, all keyed
on `recallByRef(track.ref)`, all no-ops when the ref doesn't join:

1. **Year**: reuse `extractYears` from `evals/grounding.ts`; flag when
   asserted year ≠ shown year AND |diff| > 1 AND the year isn't part of the
   row's title/album (the "1979"-by-Smashing-Pumpkins false-positive class).
   Catches 0 of the known 18 (measured — mismatch 0); prophylactic only.
2. **Duration**: clock (`\d{1,2}:\d{2}`) and worded
   (`under/over/nearly N (word) minutes`) patterns vs `duration_ms` (±30s, or
   directional). Timestamps check only `ts ≤ duration`. Catches 3
   (Nantes, A-Punk, Blue Ridge). FP scan over the run's 70 non-invented
   notes: 1 pattern match (Free Bird), which passes — 0 FPs on observed data.
3. **Title track**: `/title track/i` and normalized album ≠ title, or
   `album_type === "single"`. Catches 1 (Manchild). 0 FPs observed.

Deterministic total: **4/18 hard catches** plus whatever showing `length`
converts from invented to grounded (the mechanism behind 6 of 18). Bounce
message pattern: name the track, quote the claim, cite the ref's value, and
instruct rewrite "using only facts visible in your search results" — never
invite the model to substitute another unverified fact. Tag the gap string
with a `grounding:` prefix so `onCommit` telemetry splits it from
hollow-commit retries.

## Fix, layers 3–4 — advisory only until FP rates are measured

**Haiku rows-only check** (~$0.006/card, one strict-schema call, eight
required keys `note1…note8`, verdict enum): a phrasing-robust superset of the
regex gate (catches "six *aching* minutes" variants), low
verifier-hallucination risk, can share the inline bounce path once the
deterministic gate's telemetry looks clean. A **priors-allowed** mode
plausibly flags 8–12 of the 15 beyond-schema notes ("Brat-era",
"Kadomatsu-produced", the lyric quote) but has a real false-positive surface —
this run's *true* notes also assert beyond-schema facts — so it runs
**async, log-and-measure only**; never an inline gate until its
precision/recall vs the Opus judge is measured.

**MusicBrainz for credits** ($0, no key, hard 1 req/s): ISRC → recording →
relationships gives producer/label/member/sample data, 2–3 req/track ⇒
16–24s/card full-fleet — doesn't fit inline; gate on a credit-marker regex
(~2–5 tracks/card) or run async-after-render. Honest coverage check against
the actual 6 credit inventions: plausibly catches Plastician (UK label data),
half-catches "Brat-era" (data yes, phrase-mapping needs the LLM), coin-flip
on the Doechii sample, likely misses Kadomatsu (J-catalog producer rels
sparse) and Knesiyat Hasechel (Hebrew catalog thin — and refuting membership
needs *complete* data). **1–2 of 6, maybe 3** — the failure set tilts toward
exactly the catalogs MB covers worst. Absence of a relationship must never
bounce a note. Eval-side enrichment, not a product gate.

## Sequencing and the open decision

Both investigations agree on the mechanism ranking: **prompt fix and field
expansion + deterministic gate are the free tier; Haiku-rows-only next;
priors-allowed Haiku and MusicBrainz stay advisory.** They differ on
bundling, and it's a real trade:

- **Bundle** (prompt + fields + gate, one validation run, ~$13 + ~90 live
  searches): one bite of the quota measures the combined effect, but can't
  attribute the drop between prompt and data.
- **Sequence** (prompt-only first, then fields+gate, two runs): clean
  attribution, double the cost and quota.

Predicted combined landing zone: **24% → ~7–17%** invented (the two
investigations' ranges overlap; the ~4pp grounded-date floor is untouchable
by design and now measured by `grounding.ts`). Either way the validation run
should read: `inventedRate` (thresholds untouched — 0.35 gate stays),
`genericRate` (the stat-bait cards are the drift canaries), `verifiedTrueRate`
(over-conservatism check), duration-claim incidence + truth (the direct test
of showing `length`), bounce count + FP rate via the `grounding:` gap prefix,
and the `grounding.ts` split (mismatch must stay 0 — now enforced, not just
measured). Skim `cards.json` note texts for hedging/rule-quoting before
judging.

Marked as guesses throughout the source reports: all per-note prevention
predictions, Haiku catch rates, MB coverage estimates, and the exact MB `inc`
parameter spellings (confirm at implementation).
