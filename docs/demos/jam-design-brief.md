# Jam card: "Taped Setlist" — merged design brief (2026-11-23)

Merged from three read-only specialist proposals (visual identity, in-room UX,
frontend engineering). This is the build brief for one implementer.

## Rule from the owner (2026-11-23): no surprises
Every tappable thing on a jam card says what it does and where it goes. No
invisible whole-row link, no hidden link on the album art. A control does only
what its label says, plus side effects the card visibly explains.

## Concept
The jam card is the setlist a band gaffer-tapes to the stage floor: white
printer paper, Sharpie-black capitals, red marker numbers, two strips of tape.
Same wall, composer, toggle, refine box and save dock as a mixtape — only the
card changes. A mixtape card must stay pixel-identical.

## How to build (engineering rules)
- Modifier, not a fork: `card--jam` class + `data-mode` on the root
  `<div className="card">` in `MixtapeCard.tsx`; small gated markup in the same
  components on `card.mode === "jam"`. No JamCard/JamRow components (focus,
  dnd-kit and the row overlay would drift).
- Every new CSS rule in `client/src/styles/jam.css`, scoped under `.card--jam`
  (the existing `.mode-toggle` rules are the only exception). New colours are
  tokens declared on `.card--jam`, not `:root`. No unlayered CSS.
- Do not change: `card.css`, `tokens.css`, `index.css` layer order,
  `currentCard.ts`, anything under `server/`. `TrackList.tsx` only to pass
  per-row props through (now-playing), nothing else.
- Share page is out of scope and stays plain: `toShareCard` (server/shares.ts)
  drops `mode`, so `/m/<id>` never gets the jam look. Don't change that.
- Privacy: any anchor whose href holds artist/title gets `ph-no-capture`
  (PostHog autocapture records hrefs). That now includes the jam title link.
- "Leave site?": the unsaved-card guard (hooks/useUnsavedCardGuard.ts) stays
  quiet for Spotify hand-offs via `isHandingOff()` in spotifyLink.ts. Jam
  links (row tap, chips) must get the same treatment: add a tiny exported
  helper there (e.g. `noteOutboundLink()` setting a short-lived flag the guard
  also checks) and call it from every jam link's onClick. Safe because the
  card is restored from sessionStorage on Back. Keep the `justDragged` guard
  on the title link; route the album-art Spotify link through
  `followSpotifyLink` like the mix title link does.
- Anything clickable inside a row needs `position: relative; z-index: 1` (the
  title link's `::after` covers the row). Never set `position`/`transform` on
  `.track-row` or `.track-main`.
- Sizes from `--fs-*` (display title may be off-scale). Fonts: Archivo Black,
  Space Mono, Space Grotesk, Fraunces only. Tap targets ≥ 44px (chips ≥ 40px
  min-height acceptable inside the row). Motion only inside
  `@media (prefers-reduced-motion: no-preference)`. No horizontal scroll at 390px.
- No new deps, no new hosts (CSP).

## Palette (tokens on `.card--jam`; ratios measured)
| token | hex | use | contrast |
|---|---|---|---|
| `--set-paper` | #f6f4ee | sheet | 5.16:1 vs wall |
| `--set-ink` | #151311 | text, filled chip | 16.85:1 |
| `--set-dim` | #5c564d | artist, notes, meta | 6.60:1 (5.88 on hover) |
| `--set-marker` | #b3261e | numbers, arc labels | 5.94:1 (5.29 on hover) |
| `--set-chip-line` | #8a8378 | chip outlines, dashed rules | 3.41:1 (UI ≥3:1) |
| `--set-hover` | #ebe7dd | row/chip hover | — |
| `--set-tape` | #2a2724 | tape strips, decorative only | — |

## Card
- White sheet, no spine (the spine column is hidden; text takes the width),
  rotated +0.6deg (the cassette is -0.4deg). Same outer shadow, no inset
  highlight; `--grain` at ~0.07.
- Two tape strips (decorative, `pointer-events: none`, `aria-hidden`) over the
  top corners, ~72×22px, rotated -8° and +6°, slightly torn ends via clip-path.
  If `.card::after` is taken by the grain, use `.card-body` pseudo-elements or
  add two empty decorative spans — whichever leaves mix mode untouched.
- Eyebrow (Space Mono `--fs-2xs`): `SETLIST · 8 SONGS · 27 MIN` replacing
  "SIDE A … CUT" (keep the runtime fact from `cardFacts`).
- Title: Archivo Black, uppercase, ~30px, line-height 1. Vibe: Fraunces italic
  `--fs-md`, `--set-dim`, no left border.
- Footer: `MIXTAPE · JAM NIGHT`, no barcode.

## Set arc (CSS-only, positional)
Small labels before rows 1, 3 and 7: **WARM UP** (1–2), **EVERYONE SINGS**
(3–6), **WIND DOWN** (7–8). Space Mono `--fs-2xs`, letter-spacing 2px,
`--set-marker`, with a thin rule running right. Positional labels describe
slots, not songs, so they stay valid after a drag. Implement with
`::before` on `nth-child` rows if it doesn't disturb the overlay or drag;
otherwise a gated element in TrackRow keyed on index.

## Row
- Grid: 48px art | text. Number in Archivo Black ~22px `--set-marker` over the
  art's bottom-left with a 2px paper-coloured text stroke.
- **Display the cleaned title** (export `cleanTitle` from `jamLinks.ts`, reuse
  it): "Take Me Home, Country Roads", not "… - Original Version". Jam only.
- Title Space Grotesk 700 `--fs-md`; artist Space Mono `--fs-xs` `--set-dim`
  on its own line; note Fraunces italic `--fs-sm`.
- **No row overlay on a jam card.** The title is plain text (not a link), so
  tapping the row does nothing; the visible chips are the only links. (Scope
  this to `.card--jam`; the mixtape row keeps its Spotify overlay.)
- **Album art is not a link** on a jam card.
- Chip row under the whole entry (full width), each chip ends with ↗ (opens a
  new tab) and its accessible name names the site, e.g. "Chords for <title>
  by <artist> on Ultimate Guitar (opens in a new tab)"; a `title` tooltip
  names the site too: `Chords ↗` (filled: ink bg, paper text) · `Play along ↗`
  · `Tabs ↗` · `Lyrics ↗` · `Listen ↗` (Spotify; resolved tracks only, via
  `followSpotifyLink` like the mix title link). Outlined chips in
  `--set-chip-line`. Space Grotesk 600 `--fs-xs`, 4px radius, min-height
  40px, 6px gap. Five chips: lay them out as tidy as possible at 390px —
  one line if it fits, otherwise a deliberate 3+2 grid, never a ragged wrap.
  Keep `ph-no-capture`, analytics (`site: "listen"` is NOT a jam_link_opened
  site — Listen keeps the existing Spotify behaviour, no new event) and the
  drag stopPropagation already on the nav.
- Header hint (jam copy), replacing the mixtape's "tap a song to open it in
  Spotify": "each song links out: chords on Ultimate Guitar, play-along on
  Chordify, tabs on Songsterr, lyrics on Genius, listen on Spotify · drag ⋮⋮
  to reshuffle". Short enough for two lines at 390px; trim wording if needed,
  but keep the site names.
- Replace control moves to the right end of the artist line (saves a line);
  label "swap song" on jam. Grip unchanged.
- Rows divided by a 1px dashed `--set-chip-line`.

## Now playing (in-room)
- Opening any of a row's links marks that row **now playing**, and the card
  says so before it happens: under the hint, "the song you open is marked
  NOW". The marker is visible when you come back. Tapping the NOW tag (a
  labelled button "clear") unmarks it.
- Marking:
  thick `--set-marker` left bar + small "NOW" tag; the next row gets "UP NEXT".
  `aria-current="true"` on the current row, polite live-region line
  "Now on song 4, Wagon Wheel".
- Key it by the track's id (`trackId` in card.ts), NOT its index, so a drag,
  swap or refine never moves the marker onto a different song; if the id is no
  longer on the card, nothing is marked. Persist `{title, trackId}` in
  sessionStorage (`mixtape.jam.now.v1`) so Back from Ultimate Guitar shows the
  same song marked; ignore it if the card title differs. On restore don't
  auto-scroll (the browser restores scroll).
- Put the state in MixtapeCard (or a tiny `useJamNow` hook); pure helpers in a
  `client/src/jamNow.ts` with a `server/test/jamNow.test.ts` (parse/validate,
  next index, wrong-title ignored).

## Keep screen on
- `client/src/hooks/useWakeLock.ts` (re-acquire on `visibilitychange`, release
  on off/unmount). A small `aria-pressed` toggle in the jam card header,
  "keep screen on", hidden when `navigator.wakeLock` is missing. Opt-in only.

## Copy elsewhere (jam only)
- Refine label "not the right crowd?", placeholder "tweak it — easier songs,
  more singalongs, add a ukulele…" (RefinePanel, gated on card.mode).
- Loading chatter while a jam set is made (GeneratingProgress), if it has a
  copy pool: "tuning up…", "picking songs the whole circle knows", "saving the
  singalong for the middle", "finding a soft one to close". Never mention keys
  or difficulty. Skip if it needs the mode threaded through many files.

## Motion
Sheet drops in (rotate -2deg → 0.6deg, 380ms); tape strips press down (scale
0.6 → 1, 120ms stagger); Chords chip lifts 1px on hover. All off under reduced
motion.

## Build in two passes
1. Sheet, palette, header/footer, chips, row-tap-opens-Chords, art-opens-
   Spotify, cleaned titles, arc labels, copy, guard/privacy fixes. Then run the
   mix baseline `cmp` and look at the jam card before going on.
2. Now playing, keep screen on (the only stateful parts).

Arc labels as `::before` sit inside the row box: make sure they don't become
part of the clickable overlay area in a confusing way and that they stay on
slots 1/3/7 when rows are dragged (labels describe slots). If not, use the
gated-element fallback.

## Cut order if it gets heavy
now playing → keep screen on → loading copy → motion → torn tape ends → arc
labels. Never cut: white sheet +
ink palette, chip row, row-tap-opens-Chords.

## Checks
- `npm run gate`.
- Mix mode pixel-identical: baselines in
  `/private/tmp/claude-501/design-eng/baseline/` (script `shot.mjs` there);
  re-shoot and `cmp` the two `mix-*.png` files — must be byte-equal; phone
  `scrollWidth` must stay 390.
- Look at the jam card at 390x844 and 1280x800.
