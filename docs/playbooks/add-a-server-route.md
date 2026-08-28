# Playbook — add a server route and its test

All routes live in `server/index.ts` (one file; the 2026-08-14 review's
`routes/` split is not done). There are no HTTP-level tests in this repo:
the route is thin, the logic is a pure module, and the module is what gets
tested (ADR 0003). Free tier unless the route touches identity, caps or
tokens — then `session.ts` / `caps.ts` / `spotify.ts` are ask-tier.

1. **Put the logic in a pure module**, `server/<name>.ts`, parameterized
   so it needs no server, keys or clock — `caps.ts` and `session.ts` are
   the models.
2. **Write its test** at `server/test/<name>.test.ts` with `node:test` +
   `node:assert`; start the file with a one-line comment saying what
   property it guards (every existing test file does).
3. **Register the route** in `index.ts` *before* the static-client block at
   the bottom ("Registered last: API routes win"). Pick the identity helper:
   - `callerIdentity(req, res)` — guests welcome; call it **before** any
     streaming headers go out (it may set a cookie).
   - `requireSpotifyUser(req, res)` — 401 without a token; `if (!user) return`.
   - `requireOwner(req, res)` — logs/usage-style, owner only.
   Anything that spends Anthropic or Spotify goes through
   `capExceeded` / `countGeneration`. Streaming: `sseInit` / `sseSend`.
   Errors: generic line to the client, detail to `console.*` (it lands in
   the in-app logbook).
4. **Client side**: relative URL under `/api/`, `/auth/` or `/callback` —
   those are what `client/vite.config.ts` proxies; a new prefix needs an
   entry there and must stay same-origin (no CORS, ever).

## Verify

```sh
cd server && node --test test/<name>.test.ts   # just yours
cd server && npm test                          # all tests + selftest
npm run typecheck                              # server tsc
cd server && npm run dev && curl -s http://127.0.0.1:8888/api/<route>
```

A route that changes the SSE event vocabulary changes an implicit contract
with `App.tsx`'s `readSSE` handlers — grep for the event name on both sides.
