---
id: 0004
title: Split client styles.css into layered files, zero visual change
status: done
touches_prompt: false
flag: none
---

## Goal

`client/src/styles.css` (1,809 lines) becomes `client/src/styles/`, one file
per surface, ordered by cascade layers (`@layer tokens, base, primitives,
components`). Each component's styling lives in one file, including its
phone-width and reduced-motion overrides, and the six overrides that only
won by sitting later in the file now win by layer. Nobody sees any change:
every computed style in every reachable state must be identical.

## Non-goals

- No visual change, no token change, no new dependency, no `package.json` or
  `vite.config.ts` edit, no class renamed, no JSX touched beyond one comment.
- Dead rules (`.playlist-link`, `.seed-chip`) stay; deleting them is a
  separate change.
- No CSS Modules, Tailwind, CSS-in-JS (decided 2026-11-21, see Notes).

## Files touched, by tier

- free: `client/src/styles/*.css` (new), `client/src/styles.css` (deleted),
  `client/src/main.tsx` (import path), `client/src/App.tsx` and
  `client/public/favicon.svg` (one comment each), this spec.
- ask: `CLAUDE.md` line 41 still says tokens are in `src/styles.css`; the
  one-line fix is proposed in the PR for a human to apply.
- never: none

## Test plan

The risk in this change is the cascade, not the syntax. A rule that used to
win by specificity or by coming later in the file can lose once it moves
file or layer, and nothing in `tsc` or `vite build` would notice. So the
plan checks the cascade three independent ways, plus the gate.

**T1. Block integrity (mechanical).** The split is done by a script that
cuts the file into its 203 top-level blocks and writes each one, byte for
byte, into exactly one new file. The script asserts that the sorted block
list after the split equals the one before. Pass: the assertion holds and
the PR's only non-move CSS edit is T4's `.press-cta` rule.

**T2. Static cascade check over the built CSS.** Compare the old and new
built stylesheets declaration by declaration:
- the declaration sets must match, apart from the documented edit;
- for every pair of declarations that could conflict, the same one must
  win before and after.

A pair "could conflict" when all of these hold:
- same or overlapping property;
- media conditions that can both hold;
- subjects that can be the same element, judged from every `className` in
  the TSX.

Old winner = specificity, then source order. New winner = layer, then
specificity, then order. This covers states a browser run can't reach
(`:hover`, `:active`, `:focus-visible`, `:disabled`, `.dragging`). Pass: no
winner flips except reviewed false positives, each with a reason.

**T3. Computed-style diff in a real browser.** Build the client with a mock
backend (no Spotify, no Anthropic, no cost) and drive it through 24 UI
states:
- gate
- gate + log console
- empty with recent list
- log console open
- problems-only filter
- recent list expanded
- seed picker
- seed filter
- seed armed
- loading
- stopped
- error with owner detail
- outage
- daily cap
- card
- refining
- refine error
- refined
- save error
- saving
- pressed
- pressed details open
- pressed and saved
- seed reconnect

Run every state at 1280px and 375px, once with motion allowed and once
with reduced motion (the `prefers-reduced-motion` conditions are flipped
in the CSSOM, which changes no order or layer). That's 96 snapshots.
In each, record `getComputedStyle` for every element and its `::before` /
`::after`, with animations frozen deterministically. Then diff:
- a control run of the old build against itself, which must show zero
  noise;
- old against the commit-1 build;
- old against the final build.

Pass: zero differences across all snapshots.

**T4. The one deliberate edit.** With buttons in the lower `primitives`
layer, the phone-width `.press-cta` lift shadow would have beaten
`.btn-press:active` / `:disabled`, which used to win on specificity. The
rule now applies only `:not(:active):not(:disabled)`. Pass: reasoning
checks out: in every state (rest, hover, active, disabled, both) the
winning `box-shadow` is the same as before.

**T5. Gate.** `npm run gate` passes (protected-file check, typecheck, unit
tests, evals selftest, `tsc -b && vite build`). The final CSS bundle hash
from the real `vite.config.ts` must equal the harness build's, which proves
the mock config doesn't alter the CSS.

**T6. Independent verification.** Reviewers who didn't write the change
re-run T2–T5 from the harness, try to break the harness with a deliberate
one-property mutation (it must be caught), and read the diff for anything
the tests can't see: wrong layer for a file, a moved comment that now
describes the wrong rule, an unlayered import.

## Acceptance checks (each one runnable)

```sh
npm run gate
# harness (outside the repo; see Notes for the path):
node harness/cascade.mjs dist-base/assets/*.css dist-final/assets/*.css <wt>/client/src
node harness/diff.mjs base1 c2
```

## Results (2026-11-21)

- T1: pass. All 203 blocks were moved exactly once.
- T2: pass. Both builds have 982 declarations. 205 possibly-conflicting pairs
  were checked.
  - The first run found one real flip, the `.press-cta` shadow, fixed by T4.
  - Two flips remain, both false positives: `.pressed-mine b` against
    `.logs-funnel-line b` and `.logs-usage-row b`. Those `b` elements sit
    in different subtrees, the pressed details and the log console, so no
    element matches both.
- T3: pass.
  - The control run (old build against itself, desktop) showed 0 differences.
  - Old against the commit-1 build: 0 differences across 96 snapshots and
    5,382,384 values.
  - Old against the final build: also 0.
- T4: pass (reasoned; also covered by T2's declaration check).
- T5: pass. The final CSS bundle is `index-BaqzZR4W.css` from both the real
  config and the harness config.
- T6: see the PR.

## Notes

- **Why layered global CSS:** it was chosen over CSS Modules, Tailwind v4,
  vanilla-extract, styled-components and MUI after a research pass on
  2026-11-21. It needs no dependency and no JSX churn, the comments that
  explain the design survive, and it fixes the two real problems: one
  component's rules scattered across up to three places, and overrides
  that won only because of where they sat in the file. CSS Modules (each
  module wrapped in `@layer components`) is the upgrade path if the app
  grows more screens.
- **Overrides as trailing blocks, not nested:** each file ends with its own
  `@media` blocks instead of using native nesting. Most overrides are
  compound selectors with no single parent rule to nest under, and the
  build lowers nesting for the default targets anyway.
- **The harness:** mock backend, capture driver, diff and cascade checker.
  It is kept outside the repo, at `~/Library/Application Support/Claude/side-session-notes/local_ccea6bdc-71c7-467b-87c7-228fef9aaffc/css-harness/`,
  because the cascade checker borrows Vite's transitive `postcss`. Turning
  T3 into a committed visual-regression check is a separate decision, since
  it would need Playwright and therefore your approval.
- **Watch-out for future edits:** a rule outside any layer beats every
  layered rule. Every file is imported with `layer(...)` in `index.css`.
  Keep it that way.
