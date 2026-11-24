---
name: record-demo
description: Records a short screen video (MP4, plus a GIF) of a feature being used in the real Mixtape app, driven by a JSON scenario in headless Chromium. Use after a feature is implemented, or when the user asks for a demo, recording, screen capture or video of a feature.
---

# record-demo

One script, `record-demo.mjs` (beside this file), plays a scenario — a JSON
list of steps — against a running server, records it with Playwright, and
writes `docs/demos/<name>.mp4` (H.264, yuv420p: plays on a Mac and a phone)
and `<name>.gif` when it fits under ~10 MB.

Playwright is not a project dependency (every `package.json` is on the ask
tier); it lives in `~/.cache/mixtape-record-demo`, pinned to 1.62.1 because
that release uses the chromium build already cached. If it is missing:
`npm i --prefix ~/.cache/mixtape-record-demo playwright@1.62.1`.

## Steps

1. **Start the server from the feature branch**, on a spare port, with the
   feature's flag. Express serves `client/dist`, so build the client first or
   the video shows the last build, not the feature:
   ```sh
   cd client && npm run build
   cd ../server && PORT=8889 JAM_MODE=1 node index.ts   # run_in_background
   ```
   Not 8888: a `node --watch` from the owner usually holds it.

2. **Write or reuse a scenario** `<feature>.json` in a scenarios folder
   (copy `scenarios/jam-mode.json` beside this file). Fixtures are read from
   and captured into `../fixtures/` next to that folder (`--fixtures DIR`
   overrides), so once this skill sits under `.claude/` (never tier) keep new
   scenarios and fixtures outside it, e.g. `docs/demos/scenarios/`.
   Step kinds: `goto` (path), `click`, `hover` (selector; the mouse glides
   there so the red cursor dot is followable),
   `type` `{selector, text, delay}`, `press` (key), `waitFor` (selector, or
   `{selector, min, timeout}` for "at least n of these"), `pause` (ms),
   `scroll` (selector, or `{selector, block, ms}`: smooth into view),
   `scrollBy` `{y, ms}` (slow read-along scroll). Aim for 20–40 s; pause on
   every result a viewer should read. Selectors gotcha: the landing page has
   a sample card, so scope the real one with `.card:not(.sample-card)`.

3. **Prefer replay.** A generation is a paid Anthropic run plus a slice of
   the day's Spotify quota, and a demo gets re-recorded many times. Replay
   (the default) streams `fixtures/<fixture>.sse` (raw `text/event-stream`
   body of `/api/generate/stream`; `<fixture>.adjust.sse` for
   `/api/adjust/stream`) into the page with a delay per event, so the card
   still streams in; any stream request it can't answer is aborted, never
   sent. Only when no fixture exists, capture one — **tell the user it costs
   one paid generation** — then render in replay:
   ```sh
   node <skill dir>/record-demo.mjs <scenarios dir>/<feature>.json --mode capture
   ```
   Replay never reads the request body: change the scenario's typed prompt
   and the old card (and its "prompted:" line) still plays. Recapture after
   changing the prompt, the card's wire shape (`server/wire.ts`) or the
   feature's events.

4. **Record:**
   ```sh
   node <skill dir>/record-demo.mjs <scenarios dir>/<feature>.json \
     [--base http://127.0.0.1:8889] [--viewport phone|laptop|1440x900] [--out DIR] [--gif false]
   ```
   Default viewport is phone (390x844, a LinkedIn-friendly portrait clip);
   `laptop` (1280x800) fits more of the card per frame.
   A failed step leaves `<name>.failure.png` in the out dir — read it.

5. **Look at the video before sending it.** The script printing a path is
   not evidence the video shows the feature:
   ```sh
   for t in 3 12 20 30; do ffmpeg -loglevel error -y -ss $t -i docs/demos/<name>.mp4 -frames:v 1 /tmp/f$t.png; done
   ```
   Read the PNGs: the feature's control is visible, the card streams, the
   new UI is on screen, nothing is blank or a grey band.

6. **Hand the file over** — give the user the absolute MP4/GIF paths
   (they're not committed; `docs/demos/` is not ignored, so don't `git add -A`).

7. **Stop the server you started** (not one the user started).
