# Never-tier patches — from the 2026-09-01 security pass

> **Status (2026-09-02): applied.** A human landed every patch below —
> `d768ccf` (`.claude/settings.json`, `.github/workflows/ci.yml`, the
> `.claude/rules/curator.md` rule) and `8a79ce5` (`server/.env.example`).
> The one remaining item is the eval run owed for the `SYSTEM` prompt change:
> it is half-done — `evals/runs/2026-09-01T16-02-29-317Z/` holds `cards.json`
> (generated) but no judge or aggregate output yet. The diffs below stay as
> the record of what was proposed.

From the 2026-09-01 security pass (`docs/factory/handoff-security-2026-09-01.md`,
implemented in `7e4d6e9`). These findings land on paths the agent tier forbids it
to edit — `.claude/**`, `.github/**`, `server/.env*` — so the fixes were prepared
by the agent and were not applied at the time. Each was a human action, since
taken.

A note on #20 in particular: the `scripts/protected-check.sh` half of it was
applied in the same pass, so `npm run gate` already failed when `scripts/**`, a
`package.json` or `factory.config.json` changed. The `.claude/settings.json`
half below is what makes the *Edit tool* prompt on them; until `d768ccf` landed,
the gate caught those paths and the permission rules did not.

## #20 — `.claude/settings.json`: close the `gate.sh` shell escape

`npm run gate` is on the factory agent's Bash allowlist and maps to
`scripts/gate.sh`, which is **free tier**. An agent running `--permission-mode
acceptEdits` can append a line to `gate.sh` and reach an arbitrary shell through
the one allowlisted command — including `cat server/.env`. The same edit
disables `protected-check.sh`, because `gate.sh` is what calls it.
`factory.config.json` is likewise free tier and sets the *next* run's
`permissionMode` and `maxBudgetUsd`.

The `scripts/protected-check.sh` half of this fix was applied in `7e4d6e9` (the
`ASK_TIER` regex covers these paths). This half was not at the time; it landed
in `d768ccf`:

```diff
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@
       "ask": [
         "Edit(server/session.ts)",
         "Edit(server/caps.ts)",
         "Edit(server/env.ts)",
         "Edit(server/spotify.ts)",
-        "Edit(CLAUDE.md)"
+        "Edit(CLAUDE.md)",
+        "Edit(scripts/**)",
+        "Edit(package.json)",
+        "Edit(factory.config.json)"
       ],
```

## #21 — `.github/workflows/ci.yml`: pin the token to read-only

The workflow leaves `GITHUB_TOKEN` at the repository default. There is no
`pull_request_target` and no `${{ github.event.* }}` interpolated into a `run:`,
so the injection surface is clean — this is defence in depth, two lines:

```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@
 on:
   push:
     branches: [main]
   pull_request:

+# The gate only reads the tree. Nothing here needs write access, and the
+# repository default is wider than that.
+permissions:
+  contents: read
+
 jobs:
   ci:
```

## #22 — `server/.env.example`: drift from the code

Two lines are wrong. No real values are in the file. (I could not read it —
`Read(server/.env*)` is denied — so these are stated as replacements, from the
audit's reading plus the code defaults I verified at `server/index.ts:331-334`.)

1. `GUEST_TOTAL_DAILY_CAP=40` contradicts the code default of **12**
   (`server/index.ts:334`). Change the value to `12`.

2. `APP_SECRET` is described as "REQUIRED off-loopback". It is not — `index.ts`
   explicitly supports public mode without it, and that is how the app is
   deployed today (`server/index.ts:850-857` logs the public-mode banner and
   says spend is bounded by the daily caps). Replace that description with:

   ```
   # APP_SECRET — optional. Set it to run invite-only: visitors must enter this
   # key once, and the link /?key=<secret> lets them in with one tap. Unset is
   # public mode, where the daily caps below are what bound the spend.
   ```

## Extra — `.claude/rules/curator.md` (never tier, found during the work)

The path-scoped rule file still says `SEARCH_BUDGET` is "20/run". After #13 that
is the **curator loop's share** of a request-scoped allowance of 30 that the
loop and track resolution now draw from together. Suggested addition:

```diff
- `SEARCH_BUDGET` (20/run)
+ `SEARCH_BUDGET` (20) is the agent loop's share of a request-scoped allowance
+ of 30 (`server/searchBudget.ts`, built in `index.ts`) that the loop and track
+ resolution now spend from together — resolution used to be uncounted, which
+ is how a worst-case run reached ~44 searches against a documented 8-20.
```

## Deferred, not a patch — the owed eval run and two stale rule files

**The eval run.** Finding #11 changed `SYSTEM` in `server/curator.ts` (one added
rule, plus fenced user blocks and a labelled tool result). That is a
`touches_prompt` change under `docs/playbooks/change-the-curator-prompt.md`,
which means **one eval run, human-read**, against `evals/thresholds.json`. It was
deliberately not run here — evals cost money and are not in CI. The debt is real
and still outstanding: `generate` ran on 2026-09-01 (`cards.json` in
`evals/runs/2026-09-01T16-02-29-317Z/`); `judge` and `aggregate` have not.

**`.claude/rules/curator.md` is now stale in three places** (never tier, so it
needs a human):

```diff
- `SEARCH_BUDGET` (20/run, cache hits free)
+ `SEARCH_BUDGET` (20) is the agent loop's share of a request-scoped allowance
+ of 30 (`REQUEST_SEARCH_BUDGET` in `index.ts`, `server/searchBudget.ts`) that
+ the loop and track resolution now spend from together — resolution used to be
+ uncounted, which is how a worst-case run reached ~44 searches against a
+ documented 8-20. Cache hits are still free to both.

- `SYSTEM` (line ~289)
+ `SYSTEM` (line ~345)

- 61 cases
+ 83 cases
```
