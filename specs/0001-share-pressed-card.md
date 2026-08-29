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
- No client test runner, no new dependency, no mocking library: the tests
  are plain `node:test` with hand-written fake functions, like
  `server/test/caps.test.ts`.

## Files touched, by tier

- free:
  - `server/test/share.test.ts` (new, written **first**) — `node:test` +
    `node:assert`, first line a comment naming the property it guards
    ("dismissing the share sheet is not a copy; a share that can't happen
    becomes a copy; nothing here ever throws at the button"). Imports
    `../../client/src/share.ts` and passes fake `share`/`copy` functions —
    the only things the module needs from the browser. The fakes are the
    test's own: a clipboard is `{ written: string[] }` plus a `copy` that
    pushes to it; a share sheet is a `share` that records the payload it
    received and then resolves or rejects as the test says. No spies, no
    library.
  - `client/src/share.ts` (new, written **second**, one slice at a time) —
    pure, no DOM globals (it is typechecked by both `tsconfig.json` (no DOM
    lib) and `client/tsconfig.app.json`). The seam under test is its one
    export:
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
    Rules (each one is a test below): `deps.share` absent → `copy(url)` →
    `"copied"`; `share` resolves → `"shared"`; `share` rejects with an
    error whose `name === "AbortError"` (user closed the sheet) →
    `"dismissed"`, `copy` **not** called; `share` rejects with anything
    else → fall back to `copy(url)` → `"copied"`; `copy` rejects (in any
    path) → `"failed"`, never throws.
  - `client/src/App.tsx` (wired **third**, after the tests are green) —
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

### 1. The test list — `server/test/share.test.ts`, one slice at a time

Written before `share.ts` exists. Each line is one `test(...)` with one
logical assertion; type it, watch it fail, write the least code that
passes it, then the next line. Test names say what the button does, not
what the function is called. `URL` below is the literal
`"https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd"`; `TITLE` is
`"late-night drive"`; the fake clipboard starts as `{ written: [] }`.

1. `without a native share sheet the link is copied` — Arrange: no
   `share`, a fake clipboard. Act: `shareOrCopy({ title: TITLE, url: URL },
   { copy })`. Assert: resolves `"copied"` and `clipboard.written` deep-equals
   `[URL]`.
2. `with a native share sheet the link is shared, not copied` — Arrange: a
   `share` that resolves, a fake clipboard. Act: same call with both deps.
   Assert: resolves `"shared"` and `clipboard.written` deep-equals `[]`.
3. `closing the share sheet is not a copy` — Arrange: a `share` that rejects
   with an error whose `name` is `"AbortError"`, a fake clipboard. Act: same
   call. Assert: resolves `"dismissed"` and `clipboard.written` deep-equals
   `[]`.
4. `a share sheet that refuses the payload falls back to copying the link`
   — Arrange: a `share` that rejects with a `TypeError`, a fake clipboard.
   Act: same call. Assert: resolves `"copied"` and `clipboard.written`
   deep-equals `[URL]`.
5. `without a share sheet a refused clipboard reports failure instead of
   throwing` — Arrange: no `share`, a `copy` that rejects. Act: same call.
   Assert: the promise resolves (`await assert.doesNotReject(...)`) with
   `"failed"`.
6. `when both the share sheet and the clipboard refuse, the outcome is failed`
   — Arrange: a `share` that rejects with a `TypeError`, a `copy` that
   rejects. Act: same call. Assert: resolves `"failed"`, no throw.
7. `the share sheet receives exactly the title and the url` — Arrange: a
   `share` that records its argument and resolves. Act: same call. Assert:
   the recorded argument deep-equals `{ title: TITLE, url: URL }`
   (`assert.deepStrictEqual` — no extra keys).

A slice that comes up green with no code change (7 may, depending on how 2
was written) is kept as a guard; write no code for it.

### 2. Runnable gates

```sh
cd server && node --test test/share.test.ts   # red on the missing import first, then 7/7
cd server && npm test
npm run typecheck
cd client && npm run build
npm run gate
```

### 3. Hand-checked browser behaviour

Checked by hand — the repo has no client test runner and this spec adds
none. With `cd server && npm run dev` and `cd client && npm run dev`
running, after pressing a mixtape:

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

- Build order (the `tdd` skill's loop, one seam — `shareOrCopy` — and
  vertical slices):
  1. Create `server/test/share.test.ts` with test 1 only; run
     `cd server && node --test test/share.test.ts` and watch it fail on the
     missing `../../client/src/share.ts` import.
  2. Create the smallest `client/src/share.ts` that passes test 1 (copy,
     return `"copied"`). Then tests 2 → 7 in order: add one, see it red,
     add only the branch it needs, see it green.
  3. Wire `App.tsx` (`copied` state, `shareMixtape`, the button) — no new
     tests here; the DOM wiring is thin and covered by the hand checks.
  4. `npm run gate`.
  Refactoring is not a step of this loop: per the skill it belongs to
  review (`code-review`), after the run record is written.
- Two things changed to fit the `tdd` skill: (a) the old "asserts, at
  minimum" block was a horizontal batch of seven; it is now an ordered list
  of slices, one test → one implementation, because the skill rejects
  writing all tests before any code; (b) the old assertions counted
  `copy` calls ("copy called once"), which the skill lists as a red flag —
  they now assert what the fake clipboard *holds* (`written` deep-equals
  `[URL]` or `[]`), which is the observable outcome at this seam. `share`
  and `copy` are the system boundary (`navigator.share`, the clipboard),
  injected exactly as the skill's `mocking.md` prescribes, so faking them
  is not mocking an internal collaborator.
- Seam agreement: the skill wants the seams confirmed before any test is
  written. The one seam here is `shareOrCopy(data, deps)`; a human flipping
  this spec from draft to ready is that confirmation.
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
