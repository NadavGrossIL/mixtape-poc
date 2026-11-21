---
id: 0003
title: "Your mixtapes" — recent presses remembered in the browser
status: implemented      # draft → ready (human approves) → implemented (gate passed) → done | escalated
touches_prompt: false    # client only — no server, no curator, no eval case
flag: none               # client-only list; a revert is the switch
---

## Goal

A visitor who pressed a mixtape can find it again from Mixtape. Today a guest
(anyone outside the 5 allowlisted Spotify logins) gets the playlist link only
on the result screen; if they don't tap + in Spotify right then, "make another
one" or a reload loses it. The playlist still exists on the host "Mixtape"
account (ADR 0002) — Mixtape just offers no way back to it. After this, every
successful press is remembered in the browser's `localStorage`, and the
landing screen shows a quiet **your mixtapes** list — newest first, each title
opening its Spotify playlist — plus one line pointing at the Mixtape profile
on Spotify, where every press lives regardless.

## Non-goals

- No server change, no new route, no server-side history. Guest identity is an
  expiring cookie and the server disk is not a history store.
- No new Spotify call. The list stores what `/api/playlist`'s `done` event
  already returned; it never fetches titles, covers or follower state. The
  Spotify quota is small and shared by every visitor.
- No login, no sync across devices or browsers.
- No delete / clear control, no cover art, no track list in the entry.
- No change to `server/curator.ts`, `evals/`, or `spotifyLink.ts`.
- No client test runner, no new dependency: the pure part is tested from
  `server/test/` with `node:test`, as `share.ts` is (spec 0001).

## Limits, stated plainly

- **Per device and browser.** A press on a phone is not listed on the laptop.
- **Private mode or cleared site data loses it.** When storage throws or is
  empty the list simply doesn't render; the page works exactly as before.
- **The Mixtape profile on Spotify is the fallback for everything** — every
  press is a public playlist there, listed or not.
- Capped at 10 entries; the 11th press drops the oldest.

## Files touched, by tier

- free:
  - `client/src/recent.ts` (new) — pure, no DOM globals (typechecked by the
    root `tsconfig.json`, which has no DOM lib). Exports:
    - `type RecentMixtape = { title: string; url: string; pressedAt: number }`
    - `parseRecent(raw: string | null): RecentMixtape[]` — tolerant: bad
      JSON, a non-array, or a malformed entry yields `[]` / drops the entry.
      Only `https://open.spotify.com/…` URLs survive, so a tampered entry
      can't become a `javascript:` href.
    - `addRecent(list, entry, max = 10)` — newest first, deduped by `url`
      (a re-press of the same URL moves it to the top), capped.
    - `loadRecent(getStorage)` / `saveRecent(getStorage, list)` — take a
      function returning a `{ getItem, setItem }`, so a `localStorage`
      getter that throws (Safari private mode, blocked storage) is caught
      along with a throwing `getItem`/`setItem`. Neither ever throws.
  - `server/test/recent.test.ts` (new) — `node:test`, imports
    `../../client/src/recent.ts`.
  - `client/src/App.tsx` — `recent` state seeded from `loadRecent`; the press
    handler records `{ title: card.title, url, pressedAt: Date.now() }` right
    after `setPlaylistUrl(url)`; the landing screen renders the list after
    the example chips, only when non-empty.
  - `client/src/styles.css` — `.recent` list styles on existing tokens.
  - `specs/0003-your-mixtapes-recent-presses.md` — this file.
- ask: none
- never: none

## Acceptance checks (each one runnable)

```sh
cd server && node --test test/recent.test.ts
cd server && npm test
npm run typecheck
cd client && npm run typecheck
npm run gate
git diff --stat origin/main -- server evals   # only server/test/recent.test.ts
```

The test file guards: bad/empty storage parses to `[]`; non-Spotify URLs
and malformed entries are dropped; newest first; dedupe by URL moves a
re-press to the top; the cap holds; `loadRecent`/`saveRecent` never throw when
the storage getter or its methods throw; a round trip through a fake storage
preserves the list.

Checked by hand in the browser at `http://127.0.0.1:5173` (never
`localhost`), with a **seeded** `localStorage` entry rather than a real press
(each press creates a public playlist and spends shared quota):

- empty storage → no "your mixtapes" block on the landing screen;
- seeded entry → the block lists its title, linking to its URL;
- reload → the list is still there;
- a garbage value under the key → no block, no console error.

## Notes

- ADR 0002 is why this is needed (presses land on the host account, not the
  guest's library) and why the profile fallback is always true.
- Every press is recorded, including an allowlisted user's library save —
  the list is "what I pressed here", which is true for them too.
- The profile fallback line renders inside the block only: a first-time
  visitor with nothing pressed has no use for it, and the owner dislikes
  noisy landing screens. Its URL is the host account's Spotify user id
  (`31urgkolpmjmtftwah2ohwg3hzmy`, display name "Mixtape"), read from the
  masked `scripts/list-tokens.ts` output of the local token store.
- Storage key `mixtape.recent.v1` — versioned so a later shape change can
  ignore old data instead of mis-reading it.
- Playbook: none applies (not a route, eval case or prompt change).

## Run record

- date: 2026-11-21
- attempts: 1
- gate: passed
- files:
  - client/src/recent.ts
  - server/test/recent.test.ts
  - client/src/App.tsx
  - client/src/styles.css
  - specs/0003-your-mixtapes-recent-presses.md
- notes: browser-checked at 127.0.0.1 with a seeded key (empty → no block; seeded → titles + profile line; survives reload; garbage → no block; javascript: entry dropped; no horizontal scroll at 375px). No real press was made.
