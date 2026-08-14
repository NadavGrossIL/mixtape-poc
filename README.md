# mixtape-poc

Type a music prompt → Claude curates an 8-track mixtape with liner notes →
tracks are resolved against Spotify → a record-sleeve card renders → save it
to your Spotify account.

The card is honest about hallucination: tracks the curator invented that
don't resolve on Spotify are kept and marked `unverified` — the
resolved/unverified split is the measurement, not a bug to hide.

## Setup

1. Fill in credentials:

   ```sh
   cp server/.env.example server/.env
   # edit server/.env — SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, ANTHROPIC_API_KEY
   ```

   The Spotify app's redirect URI must be exactly `http://127.0.0.1:8888/callback`.

2. Install:

   ```sh
   (cd server && npm install)
   (cd client && npm install)
   ```

## Run

In two terminals:

```sh
cd server && npm run dev   # Express on http://127.0.0.1:8888
cd client && npm run dev   # Vite — open the printed URL (http://localhost:5173)
```

Visit the Vite URL, connect Spotify, type a prompt, press it.

On the finished card you can:

- **Refine** — a prompt box reworks the mixtape ("swap track 3 for something
  slower", "more 90s"); only changed tracks round-trip through the model, the
  rest survive byte-identical. Each track also has a one-tap ↻ swap.
- **Drag to reorder** — the saved playlist follows the card's order.
- **Press it** — saves the verified tracks as a private playlist in your
  Spotify account. Track links deep-link into the installed Spotify app.

Progress stages during generation are real backend events streamed over SSE —
nothing is invented for show.

The tiny control in the bottom-right corner (dev only) cycles the candidate
wordmarks: MADE YOU A MIXTAPE / DEEP/CUTS / PROMP/TAPE.

## Deploy (Railway)

The repo deploys as one always-on service: the root `package.json` builds the
client and Express serves `client/dist` same-origin (the Vite proxy is
dev-only). Required env vars on the host:

| Var | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `CLIENT_URL` | `/` |
| `SPOTIFY_REDIRECT_URI` | `https://<app-host>/callback` — must also be registered in the Spotify dashboard |
| `APP_SECRET` | owner key; gates every request behind a cookie (required off-loopback) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `ANTHROPIC_API_KEY` | as in local dev |
| `SPOTIFY_REFRESH_TOKEN` | paste from `server/.tokens.json` after one login — survives the host's ephemeral disk |

Log in once (from any device — the callback is same-origin in production),
copy `refresh_token` from `.tokens.json` into the env var, and the server
re-auths itself on every cold start from then on.

## Tests

```sh
cd server && npm test      # unit tests: streaming JSON extraction, track matching
node evals/selftest.js     # eval-harness enforcement + aggregation, offline
```

## Evals

`evals/` measures whether the liner notes tell the truth: `generate.js`
produces cards through the real server code paths, `judge.js` has an
Opus judge with web search verify every checkable claim (a "true" verdict
without cited evidence is downgraded in code, not just by prompt), and
`aggregate.js` computes the headline rates (invented / verified-true /
unverifiable, split by whether the track resolved on Spotify). Generation
and judging cost real API money; the selftest doesn't.

## Docs

- `docs/reviews/` — architecture + code review (2026-08-14): production
  path, framework decisions, and the reasoning behind them.
- `docs/research/` — design research with citations (refine-flow UX/API).

## Constraints worth knowing

Spotify dev-mode apps are capped at 5 allowlisted users, permanently, for
individual developers — so "sign in with Spotify" can never be this app's
growth path. The intended production shape is owner-generates /
anyone-views-the-shared-card. Details in the architecture review.
