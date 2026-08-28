---
id: NNNN
title:
status: draft            # draft → ready (human approves) → done | escalated
touches_prompt: false    # true = one eval run after review, human-read
flag:                    # env var that turns it off, or "none"
---

## Goal

One paragraph. What a user can do after this that they couldn't before.

## Non-goals

- What this deliberately does not do.

## Files touched, by tier

- free:
- ask (identity, caps, tokens — a headless run stops here):
- never (thresholds, runs, CI, CLAUDE.md, .claude, .env — humans only): none

## Acceptance checks (each one runnable)

```sh
cd server && node --test test/<name>.test.ts
cd server && npm test
npm run typecheck
cd client && npm run build
# touches_prompt only: docs/playbooks/change-the-curator-prompt.md steps 2–5
```

## Notes

Playbook used · ADRs that apply · open questions.
