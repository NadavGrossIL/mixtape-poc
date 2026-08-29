---
name: review
description: Sends an implemented spec's diff to the read-only reviewer subagent and returns its JSON verdict verbatim. Use after /implement, when the user or a workflow asks for a review of a spec.
argument-hint: specs/NNNN-slug.md
---

Review the work for the spec at `$0`.

The reviewer is a separate agent on purpose: it sees the contract and the code, not the implementer's story. Your job is to assemble exactly that input and pass the verdict through untouched.

## Steps

1. **Extract the contract.** Read `$0`. Copy the text of two sections only: `## Goal` and `## Acceptance checks`. Leave out Non-goals, Files touched, Notes, and the Run record.
2. **Collect the diff**, running each command from the repo root:
   - `git diff origin/main...HEAD` — committed work on this branch
   - `git diff` — uncommitted changes to tracked files
   - `git status --porcelain` — for every `??` line (an untracked file), run `git diff --no-index /dev/null <file>`; exit code 1 is normal and the output is the diff
   Concatenate all of it. If the total is empty, stop and reply `{ "verdict": "fail", "findings": [ { "file": "", "line": 0, "severity": "high", "title": "empty diff", "why": "no changes found against origin/main" } ] }`.
3. **Launch the reviewer.** Use the Agent tool with `subagent_type: "reviewer"`. The prompt is exactly these three parts, each under its heading, and nothing else:

   ```
   ## Goal
   <text from step 1>

   ## Acceptance checks
   <text from step 1>

   ## Diff
   <output from step 2>
   ```

   Do not add your own opinion, the spec's notes, the run record, or a summary of what the implementer did.
4. **Return the verdict.** Your last message is the reviewer's JSON object, verbatim, with nothing before or after it. If the reviewer returned anything that is not a single JSON object, reply `{ "verdict": "fail", "findings": [ { "file": "", "line": 0, "severity": "high", "title": "reviewer output not JSON", "why": "<first 200 characters of what it returned>" } ] }`.
