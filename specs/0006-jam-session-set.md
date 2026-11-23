---
id: 0006
title: Jam session set
status: implemented      # draft → ready (human approves) → implemented (gate passed) → done | escalated
touches_prompt: true     # jam rules appended to the curator prompt; one eval run after review, human-read
flag: JAM_MODE / JAM_INVITE  # JAM_MODE=1: everyone. JAM_INVITE=<secret ≥16 chars>: only browsers that opened /?jam=<secret>. Neither: no toggle, `mode: "jam"` → 400
---

## Goal

A visitor types a prompt like "acoustic campfire, 4 guitars, beginners" and
gets an 8-song **jam set**: songs picked for being fun to play together, in a
playable order. Each song is a small **hub of links** to the places
musicians already trust: chords, tabs, lyrics, play-along and listening. The
set still saves to Spotify. Today a card tells you what to listen to; this
one gets a group from "what should we play?" to playing in one screen.

## Users

- Friends with guitars, keys or ukulele planning a jam, who today build a
  list in one tab and hunt for each song across five chord sites.
- Success for them: from one prompt they get a set they would actually play, in order, and they reach chords for each song in one tap. They don't need a second search.
- Not served: anyone wanting the chords or lyrics *on our page*. We point
  to the source; we don't host it (see Non-goals).

## Non-goals

- **We host no chords, tabs or lyrics.** Researched 2026-11-23 (two
  web-research agents): no official API returns per-song chords; full
  lyrics need a paid Musixmatch/LyricFind licence; the free datasets
  (Chordonomicon, LRCLIB) are non-commercial or unlicensed. Linking out
  avoids all of it and sends people to sources with real corrections and
  ratings.
- **The model states no musical facts it hasn't seen.** It may use what it
  knows to *pick* songs, but a note never asserts a chord, key, capo,
  tuning, tempo, difficulty grade or chord count. Those live behind the
  links. The curator's rule against unseen numbers stays as it is.
- The share page (`/m/<id>`) shows a jam card as a plain card, with no link
  row and no mode. `recent` and `latest` keep only title and URL, so no
  stored card is ever refined; only the live card carries `mode`.
- We never fetch, scrape or embed any linked site. A link is a URL built
  from artist + title; the visitor's browser is the only thing that opens it.
- No change to normal mixtape mode when the toggle is off.

## Design

**The hub, per track.** A row of small labelled links under each song in
jam mode, built by a pure function from the track's `artist` and `title`
(the curator's own strings, never Spotify's `matchedName`), so a refine
needs no new data. Before encoding, the function strips release suffixes
that break chord-site searches: ` - Remastered …`, ` - Live …`,
` - Mono/Stereo …`, `(feat. …)`, `[… Version]`.

| Link | Opens | Why this source |
|---|---|---|
| Chords | Ultimate Guitar search | largest chord library, rated versions |
| Play along | Chordify search | chords synced to the recording, transposes, shows a capo |
| Tabs | Songsterr search | accurate tabs per instrument (guitar, bass, drums) |
| Lyrics | Genius search | lyrics with annotations |
| Listen | the track's existing Spotify link | already on the card |

Search URLs, not song pages: a search URL can't 404 when a site renames a
page, and it needs no API key, no network call from our server and no
rate limit. Each URL is percent-encoded artist + title, opened with
`target="_blank" rel="noopener noreferrer"`.

`client/src/jamLinks.ts` exports `jamLinks({ artist, title }): { site: "chords" | "playalong" | "tabs" | "lyrics"; label: string; url: string }[]`. It always returns those four entries, in that order, with labels "Chords", "Play along", "Tabs", "Lyrics". The `site` values are the ones `jam_link_opened` sends. The search text is `` `${artist} ${cleanTitle}` ``, passed through `encodeURIComponent`. Only the title is cleaned; the artist is used as given. Cleaning drops everything from the first case-insensitive match of a ` - ` whose tail names a release variant (a word `remaster…`, `version`, `live`, `mono`, `stereo`, `mix` or `edit`), a ` (`/` [` whose contents name one, or ` (feat.`/` (ft.`, then trims. A dash or bracket that names no variant ("Part 1 - The Beginning", "Song [Intro]") stays. (Widened after the first live run, which returned "Harvest - 2009 Remaster" and "… - Original Version".) If cleaning leaves an empty string, the raw title is used. URL templates, `<q>` = the encoded search text:
- chords: `https://www.ultimate-guitar.com/search.php?search_type=title&value=<q>`
- playalong: `https://chordify.net/search/<q>`
- tabs: `https://www.songsterr.com/?pattern=<q>`
- lyrics: `https://genius.com/search?q=<q>`

A human opens each template once in a browser before setting `status: ready`, and corrects it here if it is wrong. The implementer uses them exactly as written and checks nothing by hand. Listen is not part of `jamLinks` and adds no new anchor: it is the row's existing title link to Spotify.

**Curator.** `/api/generate/stream` and `/api/adjust/stream` accept
`mode: "jam"`. Same tool (`create_mixtape`), same eight slots, same
search — so every song is still a real Spotify record and still saves.
Jam mode appends a `JAM_RULES` block to `SYSTEM`:
- pick songs a group can actually play: well-known, with a clear,
  repeating structure, matched to the level and instruments in the prompt;
- order for a jam, not a DJ set: an easy warm-up first, a singalong peak,
  a wind-down to close;
- the note says why it works *in the room*: the chorus everyone knows, who
  takes the lead, where the energy lifts, a good spot for a solo. It never
  names a chord, key, capo, tuning, tempo, difficulty grade or chord count,
  and never calls a song "easy" or "three chords" (the visitor checks that
  behind the Chords link).

`SYSTEM` says "Order the tracks like a DJ set with an arc: an opener, a build, a peak, a comedown." Appending a rule that says the opposite would leave the model two conflicting orders. In jam mode `systemFor("jam")` therefore replaces that one line with the jam ordering rule and appends the rest of `JAM_RULES`. Every other line of `SYSTEM`, the grounding rules included, stays byte-identical, and `systemFor("mix") === SYSTEM`.

Bundled on purpose: the curator rules, the wire field, the link row and the analytics ship together because none of them is useful alone. A jam card without links is a worse mixtape, and links without jam picks are open question 4's "no". Everything sits behind `JAM_MODE`, so the bundle ships dark and turns on as one switch.

`WireCardSchema` gains `mode?: "mix" | "jam"` (and `client/src/types.ts`
mirrors it; `wire.test.ts` checks parity). No new track fields.

`mode` is the last key in `WireCardSchema`, after `seed`. The generate route sets `card.mode = "jam"` right after `card.seed`, and only for a jam run; a mix card carries no `mode` key. So every mix card, the existing `wire.test.ts` fixtures included, still round-trips byte-identical. Adjust returns a diff, not a card, so the client keeps the card's `mode` through a refine. `toShareCard` (shares.ts) already drops unknown keys, so a pressed or shared jam card stores no mode and `/m/<id>` stays plain.

**The mode belongs to the card, not the request.** Generate takes `mode`
from the body; adjust ignores any `mode` in the body and uses the card's
(missing = `"mix"`), and the agent picks `SYSTEM` or `SYSTEM + JAM_RULES`
from that. So a jam card is never refined with the mixtape prompt or the
reverse — which matters more once Part 3 makes threads multi-turn.

**The flag guards both routes.** The card comes from the browser, so with
`JAM_MODE` unset, adjust rejects a card with `mode: "jam"` (400) exactly
as generate does. Otherwise a hand-edited card would run `JAM_RULES` with
the flag off. The mode stays on the card rather than in `threads.ts`: a
thread can be evicted, spent or unknown after a restart, and the card is
what adjust rebuilds from in all three cases.

**The mode decision is one pure module, `server/jamMode.ts`, and the routes only call it.** It exports `jamEnabled(env: string | undefined): boolean` (true only for `"1"`), `generateMode(bodyMode: unknown, enabled: boolean): "mix" | "jam" | { error: string }` and `adjustMode(card: { mode?: "mix" | "jam" }, enabled: boolean): "mix" | "jam" | { error: string }`. `generateMode` maps a missing body `mode` and `"mix"` to `"mix"`, maps `"jam"` to `"jam"` when enabled, and returns an error otherwise: `"jam"` with the flag off, or any other value such as `"foo"`. `adjustMode` never sees the body. It returns the card's mode (missing = `"mix"`) and an error for `"jam"` with the flag off. Both routes answer an error with 400 before `capExceeded`, `countGeneration`, `usage.record` or `metrics.count`, so a refused mode is neither charged nor counted. `/auth/status` adds `jamMode: jamEnabled(process.env.JAM_MODE)` to its JSON. The prompt choice is a pure export of `server/curator.ts`, `systemFor(mode: "mix" | "jam"): string`. It returns `SYSTEM` unchanged for `"mix"` and the jam prompt for `"jam"`. `curator-lc.ts` passes `systemFor(...)` to `createAgent` as `systemPrompt`. `generateCard` takes the mode as `opts.mode` (default `"mix"`); `adjustCard` reads `card.mode` and ignores any opts mode.

**Client.** A two-way toggle under the composer, **Mixtape · Jam**, shown
only when `/auth/status` reports `jamMode: true`. In jam mode `TrackRow`
renders the link row. Links are plain anchors, so they work on phones and
need no JavaScript.

The link row is driven by the card, not the toggle. `MixtapeCard` passes `jam={card.mode === "jam"}` through `TrackList` to `TrackRow`, so flipping the toggle with a card on screen changes only the next generate. The toggle's state goes into the generate body as `mode`. `useRefine` sends the card as it is and adds no `mode` to its body. The row is a `<nav aria-label="Play this song">` of plain `<a>` anchors, with class `jam-links ph-no-capture`. Like the replace button, it sits above the title link's row-wide `::after` overlay (`position: relative; z-index: 1`), so a click on a jam link opens that link and not Spotify. Unresolved tracks get the row too.

**Analytics.** `mixtape_requested` gains `mode: "mix" | "jam"`, the toggle's value at the moment of the request (`"mix"` whenever the toggle is hidden). A new `jam_link_opened`
event carries `{ site }` only (never artist, title or prompt), so we learn
which sources people actually use and can drop the dead ones. PostHog
autocapture is on (`analytics.ts`) and records a clicked anchor's `href`,
which here holds artist and title. So the link row gets the
`ph-no-capture` class, and `jam_link_opened` is sent by hand.
`jam_link_opened` is sent through the existing `track()` in `analytics.ts`, from an `onClick` on each jam anchor, with `{ site }` set to the entry's `site` value and nothing else. The click doesn't call `preventDefault`, so the link still opens.

## Metrics

Pre-registered before the eval run; read in this order.

- **Gate (readable):** the normal-mode truthfulness run on `evals/prompts.json` must stay inside `evals/thresholds.json` (invented ≤ 0.35, verified-true ≥ 0.60, generic ≤ 0.15, resolution ≥ 0.90). That sample (about 75 checkable notes) is the one the gates were set on, so it is the only read that can say "regressed".
- **Jam cases (pass/fail, not a rate):** 3–5 cards from `evals/jam-prompts.json`, about 24–40 notes. At that size one standard deviation of the invented rate is about 7–9pp, so a jam invented rate compared against 0.35 is noise and is reported, never gated. What a run of this size can read: (a) resolution — all 8 tracks on every jam card resolve to Spotify (one miss fails); (b) the regex scan in Notes matches zero notes (one match fails, after a human confirms it is not a false positive such as a song title); (c) a human reads every jam note for chord, key, capo, tuning, tempo, difficulty or "easy" claims.
- **After launch (directional only):** the share of `mixtape_requested` with `mode: "jam"` and `jam_link_opened` counts per `site`. Too few events to rank sites until each has at least 30 clicks; until then, no link is dropped.

## Files touched, by tier

- free: `server/curator.ts`, `server/lc/curator-lc.ts`, `server/wire.ts`,
  `server/index.ts`, `server/test/wire.test.ts`,
  `server/test/jamLinks.test.ts` (new), `server/test/curator*.test.ts`,
  `client/src/jamLinks.ts` (new, pure), `client/src/types.ts`,
  `client/src/components/Composer.tsx`, `TrackRow.tsx`, `MixtapeCard.tsx`,
  `client/src/hooks/useGeneration.ts`, `useRefine.ts`,
  `client/src/analytics.ts`, `client/src/styles/jam.css` (new),
  `evals/jam-prompts.json` (new, jam cases), `evals/generate.ts` (pass a
  case's `mode` to `generateCard(prompt, opts)`; today it passes the
  prompt only)
- free, also (W1): `server/curatorLoader.ts` (the `Curator` interface types
  `generateCard`/`adjustCard` opts and has no mode today);
  `server/lc/curator-lc.ts` in full: `RunOpts` gains `mode`, the `makeAgent`
  signature takes it, the `generateCard` return that spreads
  `{...card, threadId}` keeps `mode`, and its `Card` zod schema gains it (as built: neither does; only the generate route writes `mode`, so it stays the card's last key and the model can't set it);
  `MixtapeCard` in `server/curator.ts` gains `mode`.
- ask: none. `server/env.ts` only loads `server/.env` through dotenv and declares no variables; `index.ts` reads `process.env.JAM_MODE` directly, as it does `DEPLOYED`. Jam mode is on only when `process.env.JAM_MODE === "1"`; any other value, or unset, is off.
- never: none
- free, also: `server/jamMode.ts` (new, pure) and `server/test/jamMode.test.ts` (new); `client/src/hooks/useSession.ts` (reads `jamMode` from `/auth/status`); `client/src/App.tsx` (passes the toggle state to `useGeneration`); `client/src/components/TrackList.tsx` (passes `jam` to `TrackRow`); `client/src/styles/index.css` (imports `jam.css`); `server/test/curator.test.ts` and `server/test/lcCurator.test.ts` (exact names, replacing `curator*.test.ts`).
- human, not the implementer: setting `JAM_MODE=1` in `server/.env` or on Railway, adding the flag to CLAUDE.md's map, and every eval run (they write to `evals/runs/`, never tier).

## Acceptance checks (each one runnable)

```sh
node --test server/test/jamLinks.test.ts
#   jamLinks({artist:"Bob Marley & The Wailers", title:"Three Little Birds"}) returns 4 entries,
#   sites chords/playalong/tabs/lyrics in that order, each url https on its template's host,
#   "&" as %26 and spaces as %20, artist and title appearing only percent-encoded;
#   titles "Here Comes the Sun - Remastered 2019" and "Señorita (feat. X)" search as
#   "Here Comes the Sun" and "Señorita"; a title that cleans to "" falls back to the raw title
node --test server/test/jamMode.test.ts
#   jamEnabled: "1" true; undefined, "", "0", "true" false
#   generateMode: missing/"mix" → mix; "jam" + enabled → jam; "jam" + disabled → error; "foo" → error
#   adjustMode: card {mode:"jam"} → jam whatever the body said; card with no mode → mix;
#   card {mode:"jam"} + disabled → error
node --test server/test/curator.test.ts
#   systemFor("mix") === SYSTEM; systemFor("jam") contains JAM_RULES and not the DJ-set line
node --test server/test/lcCurator.test.ts
#   adjustCard on a card with mode "jam" runs the model with systemFor("jam"); with no mode, with SYSTEM
node --test server/test/wire.test.ts
#   a jam card round-trips with mode last; mode "other" is rejected; a mix card has no mode key
npm run typecheck
#   server typecheck, which also proves client/src/types.ts and wire.ts stay identical
npm run gate
#   ask-tier check, both typechecks, all unit tests, evals selftest, client build
```

## Human checks (not the implementer's; the reviewer does not count these)

- Before `status: ready`: open each of the four URL templates in a browser with a real song and fix any that land on an empty or error page. Done 2026-11-23, all four correct.
- With `JAM_MODE` unset on a local server: `/auth/status` shows `jamMode: false`, no toggle is shown, and a POST to `/api/generate/stream` with `{mode:"jam"}` returns 400.
- With `JAM_MODE=1`: a jam card has 8 tracks, each row shows Chords, Play along, Tabs and Lyrics above the title overlay, each opens in a new tab, and the title still opens Spotify. A refine keeps the links. The share page `/m/<id>` for a pressed jam card shows no links.
- DevTools → Network: clicking a jam link sends one `jam_link_opened` with `{ site }` only, and no `$autocapture` event carrying the link's href.
- `docs/playbooks/change-the-curator-prompt.md` steps 2–5 on `prompts.json`: normal-mode truthfulness must not regress against `evals/thresholds.json`.
- `node evals/generate.ts --prompts jam-prompts.json`, then the judge. Read the jam notes for any chord, key, capo, tuning, tempo, difficulty grade or chord count.

## Notes

- Playbooks: `change-the-curator-prompt.md`; `add-a-server-route.md` (no
  new route, but two stream routes change their body).
- Eval: 3–5 jam cases in a separate `evals/jam-prompts.json`, run with
  `node evals/generate.ts --prompts jam-prompts.json` through the existing
  truthfulness judge. They stay out of `prompts.json` so the aggregate
  gated by `thresholds.json` (never tier) doesn't move. The judge is the
  real check. The scan is a human step, not code: after the jam eval run, the human greps the jam cards' notes for `/\b(capo|bpm|key of|tuning|drop d|chords?:)/i` and, case-sensitively (no `i` flag), `/\b[A-G][#b]?(m|maj7?|min|sus[24]?|dim|7)\b/`. Case-insensitive, the chord pattern matches the ordinary words "am", "dim" and "bm". The implementer writes `evals/jam-prompts.json`: 4 cases shaped like `prompts.json` (`id`, `category: "jam"`, `prompt`) plus `mode: "jam"`. It also changes `evals/generate.ts` to call `curator.generateCard(p.prompt, p.mode ? { mode: p.mode } : undefined)`, so a case without `mode` calls exactly as today. It does not run the eval.
  Note: `evals/generate.ts` currently passes the prompt only, with no `mode` (checked 2026-11-23). If that has changed by implementation time, skip the `generate.ts` edit.
- Research record (2026-11-23): Chordonomicon (679,807 songs keyed by
  Spotify ID, CC BY-NC, scraped from Ultimate Guitar) is the fallback if
  visitors later ask for chords on the page. Hooktheory, Ultimate Guitar
  and Songsterr have no per-song API and forbid scraping. Genius's API
  returns song URLs (not lyrics) and could later replace the Genius search
  link with a direct page link.
- **Agentic additions considered (2026-11-23) — none in this spec.** The
  existing curator (search → pick → write the card) already does the job;
  jam mode changes its rules, not its shape.
  - *Ask the group first* (LangGraph interrupt: "what instruments, what
    level?"). Matters more for a jam than a mixtape. v1 reads level and
    instruments from the prompt only (open question 3). If prompts turn out
    to lack them, add two optional chips under the composer first (no extra
    round-trip or model call), and an interrupt only if people ignore those.
  - *Link-checker tool* (agent confirms each song has a chord/lyrics page).
    No legal API for Ultimate Guitar or Chordify, so it would be scraping.
    Revisit only if `jam_link_opened` data shows people hitting dead ends.
  - *Genius direct links* (its API returns the song page URL). Not an agent
    tool: a plain server step after the card, no model needed. Later, if
    `jam_link_opened` shows Lyrics is a top link.
  - *Critic agent* judging playability. It has no chord data to check
    against, so it would be a second opinion from the same memory, at double
    the cost per card. No.
  - *Playability lookup* (advisor review, 2026-11-23): the one agentic idea
    that would add real information. A tool reads Chordonomicon's chord
    count per Spotify ID and uses it only to *choose* songs, never shown.
    It's the only source of playability data the curator doesn't have, but
    it is CC BY-NC and scraped from Ultimate Guitar, so it's a licensing
    call for the owner, not a v1 item.
  - **Worth doing next:** jam mode is the strongest case for the already
    planned LangChain Part 3 ("keep talking to your mixtape"): mid-jam
    requests like "something slower in the same vibe" or "our singer just
    left, swap the vocal-heavy ones" are follow-ups on one thread. Build this
    spec first, then Part 3 with jam as its test case.
  - To build it: `/review-spec` then the `implement-from-spec` workflow.
- **Open questions** (reading taken in brackets):
  1. Which links? [Chords, Play along, Tabs, Lyrics + Spotify; YouTube
     left out as redundant with Spotify]
  2. Separate mode, or "make this jammable" on an existing card? [separate
     mode; a normal card's songs weren't picked for being playable]
  3. Group size and level as controls, or read from the prompt? [prompt
     only]
  4. Show the link row in normal mixtape mode too? [no; jam only, so the
     normal card stays quiet]

## Panel review

Decisions for the author (resolved 2026-11-23, Nadav approved implementation):

- Resolved: `JAM_MODE` is read in `index.ts`; `env.ts` untouched (ask: none). The run stops at ready-for-eval; Nadav runs the evals. All four URL templates opened in a real browser with Bob Marley & The Wailers "Three Little Birds": each lands on a results page listing the song (Chordify and Genius return 403 to curl, so a server-side check would wrongly flag them).

Original questions:

- Is the `server/env.ts` question settled before `status: ready`, so a headless run doesn't stop on the ask tier? Options: read `JAM_MODE` directly in `index.ts` via `process.env`, `env.ts` untouched | declare it in `env.ts` (human approves the edit during the run). [Read it in `index.ts`, the way other optional flags are read, and remove the ask-tier line, so the run never stops.]
- Should one autonomous run include the paid eval leg, or stop at ready-for-eval? Options: stop at ready-for-eval; a human runs the jam and normal evals and reads them against the pre-registered Metrics | include the eval run in the autonomous run. [Stop at ready-for-eval. Evals cost money and a full run uses the day's Spotify quota.]
- Is the per-site URL format verified now and written into the spec, or left to the implementer to check by hand? Options: author pastes the four verified search URL templates into Design now | implementer checks them and records them in Notes. [Paste them now. An autonomous run can't browse to confirm them, and `jamLinks.test.ts` needs exact hosts to assert.]

Fragile claims:

- `evals/generate.ts` passes the prompt only to `generateCard` — true at HEAD (`evals/generate.ts:73`, `curator.generateCard(p.prompt)`); say "at HEAD", not "today".
- Type parity between `WireCardSchema` and `client/src/types.ts` is a compile-time `Equals` assertion (`server/test/wire.test.ts:27-29`); it fails under `npm run typecheck`, not `node --test`, which strips types. "mode round-trips" needs a runtime `safeParse` assertion (`server/wire.ts:56-71` has no mode today).
- The agent picks its system prompt per run — possible since `makeAgent(run)` is built per run, but `systemPrompt` is the constant `SYSTEM` at `server/lc/curator-lc.ts:253-256`; a remembered thread's checkpointer history keeps the system it started with.
- The share page shows a jam card plain — relies on `toShareCard` dropping `mode` (`server/shares.ts:24`; `/m/:id` served at `server/index.ts:1349`); the press route's copying of `mode` was not checked.
- `server/env.ts` is the only ask-tier file possibly touched — `git grep JAM_MODE` has no hit outside the spec; settled above by reading the flag in `index.ts`.
- Research notes (no chords API, Chordonomicon 679,807 songs CC BY-NC, etc.) — not replayable from the repo; no `docs/research/` note for 0006 exists, and "Researched 2026-11-23" cites no path.

## Run record

- date: 2026-11-23
- attempts: 2
- gate: passed
- files:
  server/jamMode.ts
  server/test/jamMode.test.ts
  client/src/jamLinks.ts
  server/test/jamLinks.test.ts
  server/curator.ts
  server/test/curator.test.ts
  server/lc/curator-lc.ts
  server/test/lcCurator.test.ts
  server/curatorLoader.ts
  server/wire.ts
  server/test/wire.test.ts
  server/index.ts
  client/src/types.ts
  client/src/hooks/useSession.ts
  client/src/hooks/useGeneration.ts
  client/src/App.tsx
  client/src/components/Composer.tsx
  client/src/components/MixtapeCard.tsx
  client/src/components/TrackList.tsx
  client/src/components/TrackRow.tsx
  client/src/styles/jam.css
  client/src/styles/index.css
  evals/jam-prompts.json
  evals/generate.ts
  specs/0006-jam-session-set.md
- notes: mode is written onto the card by the generate route only (the agent's zod Card and runOnThread return were left without it, against W1, so the model cannot supply a mode and the key stays last); CURATOR_TOOL's tracks description still says "ordered like a DJ set" in jam mode (same tool per spec); useRefine.ts and analytics.ts needed no change.
- notes (attempt 2): the review's three findings are untracked files that were in the working tree before this run started (evals/runs/ dirs dated 2026-09-01..2026-11-22, docs/launch/post-assets/, specs/0005-save-to-apple-music.md); none is part of this change and none was touched. evals/runs/ is never tier, so the agent cannot remove or move them; the human staging this branch must stage only the files listed above (not `git add -A`).

### After the workflow (orchestrator, 2026-11-23)

- Factory verdict `needs-human`: the reviewer failed it only on unrelated untracked files (`evals/runs/`, `docs/launch/post-assets/`, `specs/0005`), and it never saw the edits below.
- `JAM_RULES` gained two lines: the jam order overrides the card tool's "DJ set with an arc" wording (the tool stays unchanged, so mix mode is byte-identical), and notes keep the words "chord" and "capo" out entirely. The second came from the first live jam card, where 2 of 8 notes said "two-chord groove" and "hand the capo around". Not yet re-run live; the jam eval is the check.
- Title cleaning widened (Design above), with five new test cases from live Spotify titles.
- Verified by hand on local servers: flag off → `/auth/status` `jamMode:false` and generate `{mode:"jam"}` → 400; flag on → toggle shown, jam card of 8 with 4 links each, " - Remastered" stripped, the jam link sits above the Spotify overlay, `target=_blank rel=noopener noreferrer`. A producer credit in the artist ("America, George Martin") still finds the song on Ultimate Guitar and Songsterr.
- Not exercised: `jam_link_opened` (no PostHog key locally), a live refine of a jam card, the share page.

### Invite-link access (2026-11-23, owner request)

The owner wants jam mode shown only to people given a specific link. Added
`JAM_INVITE` beside `JAM_MODE` (server/jamMode.ts `jamInviteToken` /
`jamAllowed`, server/index.ts `jamAllowedFor`):
- `JAM_MODE=1` still means everyone. `JAM_INVITE=<secret>` (≥ 16 characters,
  shorter is ignored with a boot warning) means only a browser that opened
  `/?jam=<secret>` once. That visit sets an HttpOnly `mixtape_jam` cookie
  holding a salted SHA-256 of the secret (never the secret), for a year, and
  redirects to strip the secret from the address bar. A wrong `jam` value is
  stripped too and costs a guess on the site gate's throttle.
- `/auth/status` `jamMode`, the generate route and the adjust route all ask
  the same `jamAllowedFor(req)`, so a visitor without the cookie gets no toggle
  and a 400 for any jam request, hand-edited card included.
- Verified locally: stranger → `jamMode:false` and 400; wrong link → redirect,
  no cookie; right link → cookie, `jamMode:true`, toggle shown, URL clean.
- One secret for everyone it's sent to; rotating `JAM_INVITE` revokes every
  invited browser at once. Per-person links would need a list of tokens — not
  built. If the site gate (`APP_SECRET`) is on, open the gate link first: the
  gate's redirect drops other query parameters.
- Owed by the owner: document `JAM_INVITE` in `server/.env.example` (never
  tier) and set it on Railway.

