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
nothing is invented for show. Tracks appear one at a time because the card is
parsed out of the model's tool-input stream as it is written, not after.

The **logs** tab in the bottom-right corner opens the server's own log tail —
the prompt, each curator turn, every Spotify resolution, and any error, live
over SSE. The server tees `console.*` into a 500-entry ring buffer
(`server/logbook.ts`) and serves it from `/api/logs` and `/api/logs/stream`,
behind the same owner gate as the rest of `/api/`. stdout still gets every
line, so the host's own log view is unaffected. This exists because deployed,
"check the server logs" meant opening a hosting dashboard — which is not a
thing you do from a phone halfway through a run.

The same panel's top strip is the **funnel** — page views (and how many were
first-time browsers), prompts pressed, cards made, refines, playlists
pressed, errors, and anything a daily cap refused — for today and the last
30 days. It is aggregate only: `server/metrics.ts` keeps one row of counts
per day and nothing per person (the per-person ledger is `server/usage.ts`,
owner-only for that reason). Page views are counted from a one-line beacon
the client posts on load, not from the HTML request, so crawlers and
link-preview fetchers don't read as people. The counts are a file
(`.metrics.json`), and a file is exactly what a host's ephemeral disk drops
on every redeploy — the refresh tokens come back only because they are env
vars, not because anything on disk survived. Point `DATA_DIR` at a volume to
keep the history.

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
| `APP_SECRET` | optional — set it for **invite-only** mode (a cookie gate; the invite link is `/?key=<APP_SECRET>`). Unset = public mode: the daily caps below are the protection |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `ANTHROPIC_API_KEY` | as in local dev |
| `SPOTIFY_REFRESH_TOKEN` | the OWNER's token — paste from `server/.tokens.json` after one login; survives the host's ephemeral disk and powers catalog search |
| `SPOTIFY_HOST_REFRESH_TOKEN` | the **Mixtape host account's** token — every mixtape is pressed into this account, public. Unset = the owner's account hosts them (fine for testing, not for sharing widely). See *Sharing* below |
| `DATA_DIR` | optional — a writable directory for the counters (`.metrics.json`). Unset, they sit on the host's ephemeral disk and reset on every redeploy; point it at a Railway volume to keep the history |
| `DAILY_GENERATIONS_PER_USER` | optional, default 25 — per-account generate/adjust cap (Anthropic spend and Spotify's daily quota are shared by everyone) |
| `GUEST_DAILY_CAP` / `GUEST_IP_DAILY_CAP` / `GUEST_TOTAL_DAILY_CAP` | optional, defaults 5 / 10 / 12 — caps for visitors who never connect Spotify: per guest cookie, per IP, and all guests together (the last one bounds the bill). Pressing a playlist is capped separately, at these numbers plus headroom (`server/pressCaps.ts`) |

Log in once (from any device — the callback is same-origin in production),
copy the owner `refresh_token` from `.tokens.json` into the env var, and the
server re-auths itself on every cold start from then on.

## Monitoring

`GET /healthz` is the outside world's view of the deployment — unauthenticated
(a pinger carries no cookie) and exempt from the `APP_SECRET` gate, because
"the monitor can't reach it" and "it's down" have to be different answers.

```json
{ "ok": true, "uptime": 5231,
  "checks": { "spotifyCredentials": true, "anthropicKey": true,
              "ownerToken": true, "hostAccount": true } }
```

**200 when `ok`, 503 when not**, so a free uptime monitor needs no keyword
rules — the default "is it 200?" check is the whole configuration. A 503 is
never "a request failed"; it means the deployment is misconfigured in a way
only a human can clear, and it will keep saying so until one does. Three
checks decide it: `spotifyCredentials` and `anthropicKey` (the client id /
secret / API key the app cannot run without), and `ownerToken`, which on a
deployed host means `SPOTIFY_REFRESH_TOKEN` resolved to a real token —
without it catalog search is dead and the owner-only routes are shut to
everyone, per *Sharing* below. Run locally, `ownerToken` is always true: a
loopback server with no token is a fresh clone, not an outage.

`hostAccount` is reported and never fails the check. It tests the host token
on its own — `SPOTIFY_HOST_REFRESH_TOKEN`, not the owner fallback that serves
in its place — so false is an honest "no dedicated Mixtape account here",
meaning mixtapes press into the owner's own account. That is degraded, not
down, and worth seeing in the payload without waking anyone.

Spotify's daily quota is deliberately **not** in here. It is a
wait-until-tomorrow condition that clears itself, and paging someone at 3am for
it teaches them to ignore the page that matters. It shows up in the log panel.

Point any free uptime monitor at `https://<app-host>/healthz` on a 5-minute
check (UptimeRobot and BetterStack both do this on their free tier) and let it
mail or push you when it goes red. That is the only monitoring this app needs:
the in-app log panel and the funnel strip cover everything else, and they are
both unreachable exactly when the server is down — which is what the pinger is
for.

## Sharing

Anyone with the invite link can make a mixtape — no Spotify login. Every
mixtape is pressed into the **Mixtape host account** as a *public* playlist
(the only kind Spotify lets a link open — there is no "unlisted"), and the
visitor keeps it with one tap: **Open in Spotify → +**. The playlist link is
shareable from birth; whoever gets it does the same tap. A prompt never goes
on the playlist (it sits on a public profile); only the curator's title does.

Why this shape: Spotify caps dev-mode apps at **5 allowlisted accounts,
permanently**, and extended quota is business-only. So the app can't put a
playlist in a stranger's library — but a public playlist on its own account
is Spotify's officially suggested alternative ("link to a playlist where the
user can follow it manually"), and it's what setlist.fm's bot does at scale.
Never delete or privatize a pressed playlist: both revoke it from every
library it was saved to.

**Public by default.** With `APP_SECRET` unset the URL is the whole invite —
post it anywhere. What bounds the Anthropic bill and the per-developer daily
Spotify quota (one burst can lock everyone out for ~19h) is the caps: per
guest, per IP, and **all guests together** (`GUEST_TOTAL_DAILY_CAP`). Size
that last one to the Spotify search quota, not the bill — a run costs ~8–20
searches and the quota is a few hundred a day, so ~12 is the honest public
ceiling; when it's spent, visitors see *"today's tapes are all pressed —
come back tomorrow"*, which is meant to read as scarcity, not an error.

**Invite-only mode:** set `APP_SECRET` and share `https://<app-host>/?key=<APP_SECRET>`
— one tap sets the gate cookie and strips the key from the address bar.

**Link previews:** `client/index.html` carries the Open Graph tags and
`client/public/og.png` (1200×630, rendered from the deck hero) so a post on
LinkedIn/WhatsApp/Slack unfurls as a card. `og:image`/`og:url` are absolute
and point at the deployed host — update them if the domain changes.

**Setting up the host account (once):**

1. Create a free Spotify account for the app (e.g. "Mixtape"). Free is fine —
   only the app *owner* needs Premium.
2. Spotify dashboard → the app → **User Management** → add it (name + the
   exact email). That's one of the 5 slots.
3. Run the app locally, connect with that account, then
   `node scripts/list-tokens.ts --reveal` and put its `refresh_token` in
   `SPOTIFY_HOST_REFRESH_TOKEN` on the host. Until then the owner's account
   hosts the mixtapes (the server warns at boot).

**Seeding from a playlist:** a connected account gets the shelf picker; a
guest pastes a playlist link (Share → Copy link in Spotify). Public,
user-made playlists only — Spotify-made ones are unreadable for dev-mode
apps, and the app says so.

**The allowlisted few** (owner + up to 4 friends) still connect their own
Spotify — quietly, from the "on the list?" line under the composer. They get
the shelf picker and a 0-tap save: the pressed playlist is followed straight
into their library. Two one-time steps per friend:

1. Spotify dashboard → the app → **User Management** → name + the email on
   their Spotify account.
2. Send them the invite link.

An HMAC-signed cookie (`mixtape_user`) remembers them per browser; guests
get the same cookie with a random `anon:` id, which is what the caps and the
usage ledger key on. The token store (`server/.tokens.json`) lives on the
ephemeral disk, so a redeploy logs everyone out — reconnecting is one click,
and a guest keeps working regardless. Catalog search and the host's playlist
writes run on the env-bootstrapped tokens; only the picker and the 0-tap
follow use the caller's.

Visibility is asymmetric on purpose: `/api/logs*`, `/api/usage` (who
generated / pressed, and when — persisted in `server/.usage.json`, guests
included) and `/api/metrics` (the funnel) answer ONLY to the owner — the
caller whose Spotify id matches the owner token's `/me`. Everyone else gets
a 401 there; the log console renders its "who's used it" strip and its funnel
strip only for the owner, and all three APIs are enforced server-side, not
hidden client-side.

That gate fails **closed** when it matters. Deciding who the owner is needs
an owner token, and a server that has none used to answer those three routes
for *everyone* — reasonable for a fresh local clone, which has no users to
leak. But the same condition on a deployed host — an instance that never got
`SPOTIFY_REFRESH_TOKEN`, a rotated secret, a typo in the env var — would have
published every visitor's prompts to anyone holding the URL. So the open path
now requires a loopback bind: locally it is the bind that protects you;
deployed, a missing or empty owner token 401s logs, usage and metrics for
everybody, the owner included, and the server says so in a warning at boot.
Being locked out of your own logs is the safe half of that trade, and
`/healthz` goes red for the same reason (*Monitoring*, above).

## Tests

```sh
cd server && npm test      # unit tests: streaming JSON extraction, track matching
node evals/selftest.ts     # eval-harness enforcement + aggregation, offline
```

Tests and evals answer different questions and neither replaces the other.
Anything with one right answer — the streaming brace matcher, the
completeness gates, track matching, the pass^k arithmetic — is a test: it
runs offline, in CI, on every push. Anything graded on model output is an
eval: it costs money, needs keys, and can't gate a PR.

## Evals

**Truthfulness** — does the card lie? `generate.ts` produces cards through
the real server code paths, `judge.ts` has an Opus judge with web search
verify every checkable claim (a "true" verdict without cited evidence is
downgraded in code, not just by prompt), and `aggregate.ts` computes the
headline rates (invented / verified-true / unverifiable, split by whether
the track resolved on Spotify).

```sh
node evals/generate.ts --limit 3   # pilot; drop --limit for all 18 prompts
node evals/judge.ts                # judges the latest run
node evals/aggregate.ts            # rates + threshold gate -> summary.json
```

**Reliability** — does the agent obey its own output contract?
`reliability.ts` runs each prompt k times and reports how often the curator
commits a complete mixtape *on the first try*. The app hides this: an
incomplete commit is handed back as a failed tool_result and repaired on the
next turn, so a regression costs latency and tokens without ever showing a
broken card. That is the bug that shipped once — with `tracks` as an array a
strict schema ignored `minItems`, and the model closed the array after one
track 6 times in 10. Reported as pass@k (ever clean) and pass^k (always
clean); pass^k is the one that matters, because 6/10 was "usually fine" too.

```sh
node evals/reliability.ts --only app-fastest-rap --trials 10
```

**Thresholds** — `evals/thresholds.json` turns a run into a gate: breaching
one exits non-zero. It ships empty on purpose. Anthropic publishes no
recommended numbers (they're task- and risk-specific), so these get set from
a baseline run, never from a guess. Unset = report-only; a metric with an
empty denominator reports "no data — skipped" rather than failing a build on
an absence.

Generation, judging and reliability cost real API money; the selftest doesn't.

## Docs

- `docs/reviews/` — architecture + code review (2026-08-14): production
  path, framework decisions, and the reasoning behind them.
- `docs/research/` — design research with citations (refine-flow UX/API).

## Constraints worth knowing

**A strict tool schema enforces what it can compile, and silently drops the
rest.** JSON Schema array-length constraints (`minItems`) aren't supported by
strict tool use, so `"tracks": [oneTrack]` was a perfectly valid
`create_mixtape` call. Measured over 10 live runs, the model closed that array
after a single exemplar track **6 times** — it ran all eight Spotify searches,
said "All eight verified. Now let's finalize the mixtape.", then stopped
cleanly at ~240 output tokens. Not truncation, not malformed JSON: it decided
one was enough, and nothing in the schema said otherwise.

Prompt wording didn't move it, and neither did removing the other
record-the-result tool from the request (5/10 vs 6/10 — noise). What fixed it
was changing the shape of the ask: the card's tracks are an **object with
eight required keys** (`track1`…`track8`), not an array. `required` on object
properties *is* compiled into the grammar, so the call cannot close until all
eight exist. Same ten prompts, keyed schema: **0/10 failures**. The array is
rebuilt from the keys on arrival (`toTrackList`), so nothing downstream knows.

The generalisable rule: if a constraint must hold, express it as one the
grammar can enforce — `required`, `enum`, `type` — rather than one it will
accept and ignore. `cardIncompleteReason` still gates the call afterwards,
because `required` guarantees the keys exist, not that they say anything:
`{"artist": "placeholder"}` is still a valid string. Substance is never a
thing a schema checks.

Spotify dev-mode apps are capped at 5 allowlisted users, permanently, for
individual developers — so "sign in with Spotify" can never be this app's
growth path. Multi-user login exists (see "Sharing with friends") but only
inside that cap; the production shape for everyone else remains
owner-generates / anyone-views-the-shared-card. Details in the architecture
review.
