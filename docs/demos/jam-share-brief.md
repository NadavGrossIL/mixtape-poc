# Sharing a jam set — build brief (2026-11-23)

Owner request: a jam set must be shareable two ways, both offered on the jam
card: **save to Spotify and share**, and **share without saving**. Today a
share page exists only after a Spotify save, and it drops the jam look and
every link (`toShareCard` drops `mode`). Owner rules that apply: no surprises
(every button says exactly what it does — memory/feedback), mix mode must not
change.

Read first: CLAUDE.md; server/shares.ts (the whole header comment: the share
page shows only words this server's curator wrote; the trusted-card map; the
press lookup `cardForPress`); server/index.ts around `trustedCards`,
`sharedMixtape`, `/api/mixtape/:id`, `/m/:id`, and the `/api/playlist` press
route; client/src/components/SharedMixtape.tsx, ShareButton.tsx (and its
`shareUrlFor`), PressedPanel.tsx, SaveDock.tsx, MixtapeCard.tsx; the jam
modules (jamMode.ts, jamLinks.ts, TrackRow.tsx jam branch, styles/jam.css);
docs/playbooks/add-a-server-route.md (a new route follows it).

## 1. Share pages keep jam mode (both options need it)
- `ShareCard` gains `mode?: "jam"`; `toShareCard` keeps `mode` only when it
  is exactly `"jam"` (anything else dropped, so mixtape share files and pages
  are byte-identical to today). `adjustedShareCard`/`cardForPress` carry it.
- The trusted card the generate route records must carry the mode (today the
  route sets `card.mode = "jam"` AFTER/BEFORE `trustedCards.add`? — check the
  order and make the trusted copy include it).
- `/m/<id>` for a jam share renders the Taped Setlist card with its chips,
  read-only (not editable, no refine, no swap). The now-playing marker and
  keep-screen-on may work there too (they're client-only). Viewing a shared
  jam page needs NO jam access — it costs nothing; making or refining a jam
  set still does.
- Link preview (`shareMeta`/`withShareMeta`): fine as is; optionally say
  "jam set" in the description for a jam share.

## 2. Option A — Save & share
- On a jam card the save button's label says both: **"Save to Spotify &
  share"**. Its behaviour is the existing press. After it succeeds the
  pressed panel's share button reads **"Share the set"** on a jam card and
  shares `/m/<playlist id>` as today. Mixtape labels unchanged.

## 3. Option B — Share without saving
- New route `POST /api/share` (sameOriginOnly, JSON body `{ title, vibe, uris }`
  where `uris` is the card's verified track uris in the order on screen — the
  same inputs the press uses). It looks up `trustedCards` by the shelf key and
  runs `cardForPress(trusted, uris)`; no match → 404 with a plain error
  ("This set can't be shared — make it again."). Only jam cards may use it
  (trusted card's `mode === "jam"`), else 400 — mixtapes keep save-then-share.
- The share id: **23** characters, base62, derived deterministically from the
  share card's content (e.g. sha256 of the JSON, base62-encoded, first 23),
  so the same set shared twice is one file and the endpoint can't be used to
  write unbounded files for one card. 23 chars can never be a Spotify playlist
  id (22). Add `SET_ID_RE = /^[A-Za-z0-9]{23}$/`; `shares.record/get/remove`
  and `/api/mixtape/:id` and `/m/:id` accept either shape.
- Store `playlistUrl: null` semantics: for a 23-char id `sharedMixtape`
  returns `url: null` (never builds an open.spotify.com/playlist URL from it);
  SharedMixtape hides OPEN IN SPOTIFY / "make it yours" Spotify bits when
  `url` is null and keeps "make your own". Each track's own Listen chip still
  works (its track URL is in the card).
- Response `{ id, url: "<origin>/m/<id>" }`. Count nothing against the guest
  caps (no model call, no Spotify call). Don't put it on the "latest" shelf.
- Client: on a jam card, under/next to the save button, a second button
  **"Share the set — no Spotify needed"**. On tap it calls `/api/share`, then
  opens the native share sheet / copies the link exactly like ShareButton does
  (reuse it — give ShareButton a direct `url` prop alongside `spotifyUrl`), and
  says so on screen ("Link copied" / the share sheet). Errors shown with the
  existing ErrorAlert pattern. Analytics: reuse the share event the app already
  sends, with a property distinguishing `kind: "set"` — never title/artist.
- Restored cards (sessionStorage) after a server restart have no trusted copy
  → the 404 message above; that's expected (same as press today).

## 4. Tests (node:test, server/test)
- shares: `toShareCard` keeps `mode:"jam"` only; a mix share card is unchanged
  (no `mode` key); the 23-char id function is deterministic, base62, length
  23, differs for different cards; `record/get` accept 22 and 23, reject other
  shapes.
- Pure decision for `/api/share` extracted (e.g. `shareSetDecision(trusted,
  uris)` → card | error) and tested: no trusted card, uris mismatch, not jam,
  ok.
- Everything else stays green; `npm run gate`.

## 5. Must not change
Mixtape share pages, mix cards (pixel-identical; re-check with
`node /private/tmp/claude-501/design-eng/baseline/shot.mjs <repo>/.claude/skills/record-demo/fixtures/jam-mode.sse <out>` and `cmp` the two mix-*.png against
/private/tmp/claude-501/design-eng/baseline/), the press route's behaviour,
caps, anything on the ask/never tiers (server/spotify.ts, caps.ts,
session.ts, env.ts, package.json, .claude/**, CLAUDE.md, evals/thresholds…).
