---
name: spec
description: Turns a one-line feature request into a spec file under specs/ for a human to approve.
argument-hint: <one-line request>
disable-model-invocation: true
---

Write a spec for this request:

$ARGUMENTS

The spec is the contract the implementer works from and the reviewer grades against. A human approves it before any code is written, so it must be precise enough to grade and short enough to read in a minute.

## Steps

1. **Read the ground truth.** Open `specs/_template.md` — the spec is that file, filled in, with the same sections in the same order. Find the code the request touches (`Grep`, `Read`); do not guess whether a route, module, or test already exists.
2. **Clarify only if you must.** Ask at most three questions, and only when two reasonable readings of the request would produce different acceptance checks. If you cannot ask (a headless run), write each question and the reading you took under `## Notes` → "Open questions" and continue.
3. **Pick the id and file name.** `NNNN` is the largest four-digit prefix among `specs/*.md` plus one, zero-padded, `0001` when there is none. The slug is the title in kebab-case, at most five words. Write to `specs/NNNN-slug.md`.
4. **Fill every field of the template honestly.**
   - `status: draft`.
   - `touches_prompt: true` if and only if `server/curator.ts` or `evals/prompts.json` would change. Anything else, including new routes and client changes, is `false`.
   - `flag:` the env var that turns the feature off, or `none` when a flag would be theatre (a read-only endpoint, a test).
   - **Files touched, by tier**: list every file that will change or be created, under the tier CLAUDE.md gives it. A spec that needs an ask- or never-tier file says so here; the implementer stops on it.
   - **Acceptance checks**: each line is a command with an expected result, or an observable behaviour (`curl` output, an HTTP status, a JSON field and its type). Name the test file that will hold the new assertions. Keep the template's standard commands.
   - **Notes**: the playbook from `docs/playbooks/` that applies and the ADRs that bind.
5. **End the reply** with the file path and this line, verbatim:

Set `status: ready` in the spec to approve it.
