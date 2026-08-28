# ADR 0001 — `tracks` is a keyed object, not an array, in the tool schema

**Status:** accepted · **Date:** 2026-08-16 (`4330264`)

## Context

`create_mixtape` is a strict tool. With `tracks` as an array, `minItems: 8`
was accepted by the API and silently ignored — strict tool use compiles
only what its grammar supports. Measured over 10 live runs the model closed
the array after one exemplar track 6 times: all eight searches done, "All
eight verified. Now let's finalize the mixtape.", clean stop at ~240 output
tokens. Prompt wording didn't move it; scoping the tool list per flow didn't
either (5/10 vs 6/10 — noise).

## Decision

`tracks` is an object with eight **required** keys `track1`…`track8`.
`required` on object properties *is* compiled into the sampling grammar, so
the call cannot close early. `toTrackList` rebuilds the array on arrival;
nothing downstream changed. `cardIncompleteReason` stays: `required`
guarantees the keys exist, not that they say anything.

## Consequences

- Same ten prompts: 6/10 → 0/10 hollow commits, no retry turns.
- The rule generalises: express a constraint the grammar enforces
  (`required`, `enum`, `type`), never one it accepts and ignores.
- `evals/reliability.ts` keeps this measurement repeatable (pass^k).

Sources: README "Constraints worth knowing"; commit `4330264`;
`docs/research/second-chance-readjustment.md` (support matrix).
