---
id: 0001
title: Share control on the pressed card
status: draft            # draft → ready (human approves) → done | escalated
touches_prompt: false    # client only — no server, no curator, no eval case
flag: none               # client-only button; a build-time VITE_ var can't switch it off at runtime — a revert is the switch
---

## Goal

After pressing a mixtape, every user sees a **share** button next to
"copy link" on the pressed card. On a device with the Web Share API
(phones, Safari on macOS) it opens the native share sheet with the card's
title and the playlist's `https://open.spotify.com/playlist/…` URL.
Everywhere else it copies that URL to the clipboard — the same clipboard
path "copy link" uses — and the button reads **copied ✓** for a beat, with
the same screen-reader announcement. Today (`4385a75`) the button exists
only when `"share" in navigator` (`client/src/App.tsx:1767`); desktop
Chrome/Firefox users never see it and there is no fallback.

## Non-goals

- No server change, no new route, no `server/curator.ts` or
  `evals/prompts.json` change.
- "copy link" stays as it is; this does not merge or remove it (see open
  question 2).
- No share of the track list, cover art, or a text blurb — the payload is
  exactly `{ title: card.title, url: playlistUrl }`.
- No `navigator.canShare` pre-check and no capability sniffing beyond
  "is `navigator.share` a function".
- No toast, no new CSS: the existing `.btn-ghost` and `.pressed-actions`
  styles are enough.
- No change to `spotifyLink.ts` (deep-linking is untouched).

## Files touched, by tier

- free:
  - `client/src/share.ts` (new) — pure, no DOM globals (it is typechecked
    by both `tsconfig.json` (no DOM lib) and `client/tsconfig.app.json`).
    Exports:
    ```ts
    export type ShareOutcome = "shared" | "dismissed" | "copied" | "failed";
    export async function shareOrCopy(
      data: { title: string; url: string },
      deps: {
        share?: (d: { title: string; url: string }) => Promise<void>; // navigator.share, bound
        copy: (text: string) => Promise<void>;                        // clipboard write
      },
    ): Promise<ShareOutcome>;
    ```
    Rules: `deps.share` absent → `copy(url)` → `"copied"`; `share` resolves →
    `"shared"`; `share` rejects with an error whose `name === "AbortError"`
    (user closed the sheet) → `"dismissed"`, `copy` **not** called; `share`
    rejects with anything else → fall back to `copy(url)` → `"copied"`;
    `copy` rejects (in any path) → `"failed"`, never throws.
  - `server/test/share.test.ts` (new) — `node:test` + `node:assert`, first
    line a comment naming the property it guards; imports
    `../../client/src/share.ts` with fake `share`/`copy` functions.
  - `client/src/App.tsx` —
    - `copied` state widens to `"link" | "tracks" | "share" | null`
      (`App.tsx:583`).
    - `shareMixtape` (`App.tsx:1099`) calls `shareOrCopy` with
      `share: navigator.share ? navigator.share.bind(navigator) : undefined`
      and `copy: (t) => navigator.clipboard.writeText(t)`, then maps the
      outcome: `"copied"` → `setCopied("share")`, `setAnnounce("Link
      copied.")`, clear after 1800 ms exactly as `copyText` does;
      `"failed"` → `setAnnounce("Couldn't copy — select it by hand.")`;
      `"shared"` / `"dismissed"` → nothing.
    - The `"share" in navigator` guard around the button (`App.tsx:1767`)
      is removed; the button always renders inside `.pressed-actions`,
      after "copy link", label `copied === "share" ? "copied ✓" : "share"`,
      `aria-label="Share this mixtape"`.
  - `specs/0001-share-pressed-card.md` — run record.
- ask (identity, caps, tokens — a headless run stops here): none
- never (thresholds, runs, CI, CLAUDE.md, .claude, .env — humans only): none

## Acceptance checks (each one runnable)

```sh
cd server && node --test test/share.test.ts
# asserts, at minimum (fakes record their calls):
#   no share, copy ok            → "copied";   copy called once with data.url
#   share resolves               → "shared";   copy never called
#   share rejects AbortError     → "dismissed"; copy never called
#   share rejects TypeError      → "copied";   copy called once with data.url
#   share rejects, copy rejects  → "failed";   promise resolves (does not throw)
#   no share, copy rejects       → "failed"
#   share receives exactly { title, url } (deep-equal, no extra keys)
cd server && npm test
npm run typecheck
cd client && npm run build
npm run gate
```

Observable, with `cd server && npm run dev` and `cd client && npm run dev`
running, after pressing a mixtape (checked by hand — there is no client
test runner):

- Chrome/Firefox on desktop (no `navigator.share`): `.pressed-actions`
  holds two buttons, "copy link" then "share". Clicking "share" puts the
  playlist URL on the clipboard, the button reads "copied ✓" for ~1.8 s,
  the `aria-live` region says "Link copied." "copy link" behaves exactly as
  before.
- Safari on macOS or any phone browser: clicking "share" opens the OS share
  sheet showing the card title and the `open.spotify.com/playlist/…` URL.
  Cancelling the sheet changes nothing on the card (no "copied ✓", no
  announcement).
- `grep -n '"share" in navigator' client/src/App.tsx` → no matches.
- `git diff --stat origin/main -- server evals` → only
  `server/test/share.test.ts` added; nothing else under `server/` or
  `evals/` changes.

## Notes

- Playbook: none applies — this is neither a route, an eval case, nor a
  prompt change. `.claude/rules/` has no client rule.
- ADR 0003 (tests vs evals): the share/copy/abort decision has one right
  answer per input, so it is a unit test, not an eval. The DOM wiring in
  `App.tsx` is thin and checked by hand, as `0000`'s `curl` lines were.
- ADR 0002 (host-account public playlists) is what makes the shared URL
  useful to a stranger: the playlist is public, so the link works without
  the recipient signing in. Nothing here changes that.
- Why a separate pure module rather than inlining in `shareMixtape`: the
  root `tsconfig.json` has no DOM lib and Node's type-stripping runs the
  test, so the testable part must take `share`/`copy` as parameters. It
  also keeps the AbortError rule — "dismissing the sheet is not a copy" —
  out of JSX where it would be easy to regress.
- Node runs `.ts` with erasable syntax only: `share.ts` must use no enums,
  namespaces or parameter properties (both tsconfigs already enforce
  `erasableSyntaxOnly`).
- Open questions (headless run — reading taken in brackets):
  1. A `share` button already exists behind `"share" in navigator`. Is this
     a new control or the delta? [The delta: make it unconditional and add
     the copy fallback. The request says "Add a 'Share' control"; the
     observable result is the same either way.]
  2. On desktops the fallback makes "share" and "copy link" do the same
     thing. Should "share" replace "copy link" where `navigator.share` is
     absent? [No — the request says add and reuse, not replace. Removing
     "copy link" is a separate, one-line spec if wanted.]
  3. Should a non-Abort `navigator.share` failure (e.g. `NotAllowedError`
     when the click wasn't a user gesture, or a platform rejecting the
     payload) fall back to copy or announce an error? [Fall back to copy —
     the user asked to share; a copied link is the nearest thing to that.]
