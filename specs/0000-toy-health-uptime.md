---
id: 0000
title: GET /api/health returns uptimeSeconds
status: toy              # used to verify M3 on 2026-08-28; not merged
touches_prompt: false    # true = one eval run after review, human-read
flag: none               # read-only endpoint; a flag would be theatre
---

## Goal

An operator (or a platform health checker) can `GET /api/health` and get a
200 JSON body `{ "ok": true, "uptimeSeconds": <integer> }`, where
`uptimeSeconds` is whole seconds since the Node process started. Today the
server has no health route at all (the 2026-08-14 architecture review, item
9, asks for one); this adds the smallest one that carries uptime.

## Non-goals

- No dependency status in the body: no Spotify token-refresh state, no
  Anthropic reachability, no quota-breaker state. `ok` is a constant `true`
  meaning "the process answered"; it never turns `false`.
- No `/healthz` alias and no SSE heartbeat (the review's other items).
- No change to the `APP_SECRET` gate middleware: behind a gate, an
  un-cookied `/api/health` keeps returning the existing 401 JSON.
- No identity, no cookie set, no cap counting — nothing is spent.
- No client change: `client/vite.config.ts` already proxies `/api/`.

## Files touched, by tier

- free:
  - `server/health.ts` (new) — pure: `healthBody(uptime: number)` →
    `{ ok: true, uptimeSeconds: Math.floor(uptime) }`, non-negative
    (negative or `NaN` input → `0`). Takes the float, not the clock.
  - `server/test/health.test.ts` (new) — `node:test` + `node:assert`, first
    line a comment naming the property it guards.
  - `server/index.ts` — register `app.get("/api/health", …)` that responds
    `res.json(healthBody(process.uptime()))`, placed before the
    "production static client" block (API routes win) and without an
    identity helper.
- ask (identity, caps, tokens — a headless run stops here): none
- never (thresholds, runs, CI, CLAUDE.md, .claude, .env — humans only): none

## Acceptance checks (each one runnable)

```sh
cd server && node --test test/health.test.ts
# asserts, at minimum:
#   healthBody(0)            → { ok: true, uptimeSeconds: 0 }
#   healthBody(12.9)         → uptimeSeconds === 12 (floored, not rounded)
#   healthBody(3600.0001)    → uptimeSeconds === 3600
#   healthBody(-1), (NaN)    → uptimeSeconds === 0
#   Number.isInteger(healthBody(x).uptimeSeconds) for each case
#   Object.keys(healthBody(1)) deep-equals ["ok", "uptimeSeconds"]
cd server && npm test
npm run typecheck
cd client && npm run build
```

Observable, with `cd server && npm run dev` running and no `APP_SECRET`:

- `curl -si http://127.0.0.1:8888/api/health` → `HTTP/1.1 200`,
  `Content-Type: application/json`, body `{"ok":true,"uptimeSeconds":N}`
  with `N` a non-negative integer and no other keys.
- Two calls a few seconds apart: the second `N` is ≥ the first.
- With `APP_SECRET=x` and no gate cookie: `curl -si` → `401` with the
  existing `{"error":"Locked — …"}` body (gate untouched).

## Notes

- Playbook: `docs/playbooks/add-a-server-route.md` (pure module → test →
  register before the static block). The "pick the identity helper" step
  is deliberately skipped: this route identifies no one and spends nothing.
- ADR 0003 (tests vs evals): the floor/clamp logic is a unit test, not an
  eval; there are no HTTP-level tests in this repo, so the `curl` lines are
  checked by hand.
- `process.uptime()` is chosen over `Date.now() - startedAt` because it is
  monotonic (hrtime-based): wall-clock adjustments can't make uptime go
  backwards or negative. The clamp in `healthBody` is defence for bad input,
  not for the clock.
- Open questions (headless run — reading taken in brackets):
  1. The request says the route "also" returns `uptimeSeconds`, but
     `GET /api/health` does not exist yet (grep: no `health` in `server/`).
     [Create it with the minimal body `{ ok, uptimeSeconds }`. The
     dependency-status `/healthz` the review sketched is a separate spec.]
  2. Should `/api/health` be exempt from the `APP_SECRET` gate so a
     platform checker without the cookie sees 200? [No — that edits the gate
     middleware, a security change beyond this request. A 401 still proves
     the process is up; exemption can be its own spec.]

## Run record

- date: 2026-08-28
- attempts: 1
- gate: passed
- files:
  - server/health.ts
  - server/test/health.test.ts
  - server/index.ts
  - specs/0001-health-uptime-seconds.md
- notes: none — the curl checks were not run (no live server in a headless run; the route is a one-liner over the tested module).
