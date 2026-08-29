---
name: implement
description: Implements an approved spec test-first, runs the gate, records the run in the spec. Use when a spec under specs/ has status ready and the user or a workflow asks to implement it.
argument-hint: specs/NNNN-slug.md
---

Implement the spec at `$0`.

You are the implementer in a factory: the spec is the contract, the gate is the judge, and a separate reviewer reads your diff afterwards. Your last message is parsed by a program, so its shape matters as much as the code.

## Before writing code

1. **Read the spec.** If its frontmatter is not `status: ready`, stop: change nothing and return `needs-human` with `notes: "spec status is <value>, not ready"`.
2. **Check the tiers.** The spec lists files by tier. If any file the spec needs, or any file you discover you must change, is in the ask tier — `server/session.ts`, `server/caps.ts`, `server/env.ts`, `server/spotify.ts` — or the never tier (CLAUDE.md, "Protection tiers"), stop and return `needs-human` naming the file. Those files are out of scope for you in every case; do not work around a rule with a script or a shell redirect.
3. **Read the playbook** that CLAUDE.md ("Read before touching") maps to the files in the spec — `docs/playbooks/add-a-server-route.md` for a route, and so on. Follow its steps and its file layout.

## Writing the code

4. **Work test-first** with the `mattpocock-skills:tdd` skill (invoke it with the Skill tool; it owns the red-green-refactor loop). The acceptance checks in the spec are the tests to write first. Logic lives in a pure module, the route stays thin (ADR 0003).
5. **Commands.** Only these run without a prompt; use them in exactly this form, from the repo root:
   - `node --test server/test/<name>.test.ts` — one test file
   - `npm run typecheck`
   - `node evals/selftest.ts`
   - `npm run gate`
   - `git status`, `git diff`
   Type each command exactly as written: no environment variable in front, no argument, pipe, `tail`, or redirect after it. Read the output the tool returns. A command outside this list is a sign the plan is wrong, not a reason to ask for it.

## The gate

6. Run `npm run gate`. Read the first failing step. Fix it and run the gate again. You may fix at most twice: three gate runs in total. If the third run fails, stop with `needs-human`.
7. Add no dependency to any `package.json` unless the spec names it.

## Recording the run

8. Append this block to the end of the spec file, then set the frontmatter `status:` to `implemented` (gate passed) or `escalated` (needs-human):

   ```
   ## Run record

   - date: <YYYY-MM-DD>
   - attempts: <number of gate runs>
   - gate: passed | failed at "<step name>"
   - files: <every file created or changed, one per line>
   - notes: <one line: what was surprising, or "none">
   ```

9. **Last message.** Reply with this JSON object and nothing else — no prose before or after it:

   `{ "status": "gate-passed" | "needs-human", "attempts": <number>, "files": ["<path>", ...], "notes": "<one line>" }`
