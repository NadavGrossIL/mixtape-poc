// Mixtape POC server — Express on 8888.
// Spotify OAuth (authorization code flow) + Claude curator + track resolution.

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const spotify = require("./spotify");
const curator = require("./curator");

const PORT = 8888;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

const app = express();
app.use(express.json());

// ── startup credential check (warn, never crash) ─────────────

if (!spotify.credentialsConfigured()) {
  console.warn(
    "\n[config] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are missing or still " +
      "placeholders.\n[config] Copy server/.env.example to server/.env and fill in " +
      "your Spotify app credentials.\n[config] The server will run, but Spotify " +
      "login and search will fail until then.\n"
  );
}
if (!curator.anthropicConfigured()) {
  console.warn(
    "[config] ANTHROPIC_API_KEY is missing or still a placeholder.\n" +
      "[config] Fill it in server/.env — /api/generate will fail until then.\n"
  );
}

// ── auth ─────────────────────────────────────────────────────

// states issued by /auth/login, consumed by /callback — state → issued-at.
// Expired lazily on the two auth routes; abandoned logins must not make a
// state valid forever (or grow the map unboundedly).
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function evictStaleStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, issuedAt] of pendingStates) {
    if (issuedAt < cutoff) pendingStates.delete(state);
  }
}

app.get("/auth/login", (req, res) => {
  if (!spotify.credentialsConfigured()) {
    return res
      .status(500)
      .send(
        "Spotify credentials are not configured. Fill in server/.env (see .env.example) and restart the server."
      );
  }
  evictStaleStates();
  const state = spotify.makeState();
  pendingStates.set(state, Date.now());
  res.redirect(spotify.authorizeUrl(state));
});

app.get("/callback", async (req, res) => {
  evictStaleStates();
  const { code, state, error } = req.query;
  if (error) {
    // text/plain, not HTML — `error` is attacker-controlled query input
    return res
      .status(400)
      .type("text/plain")
      .send(`Spotify authorization failed: ${String(error)}`);
  }
  if (!state || !pendingStates.has(state)) {
    return res.status(400).send("State mismatch — restart the login flow.");
  }
  pendingStates.delete(state);
  try {
    await spotify.exchangeCode(code);
    res.redirect(CLIENT_URL);
  } catch (err) {
    console.error("[auth] token exchange failed:", err.message);
    res.status(500).send("Token exchange with Spotify failed. Check the server logs.");
  }
});

app.get("/auth/status", (req, res) => {
  res.json({ loggedIn: spotify.isLoggedIn() });
});

// ── api ──────────────────────────────────────────────────────

// SSE helpers — every event sent is driven by a real backend event.
function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function sseSend(res, event, data) {
  // A resolver worker can outlive the response (peer throws → route ends the
  // stream); writing then would emit an uncaught stream error and crash.
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
}

// Streaming generate. Emits, in order:
//   curating → track (per track, as Claude streams it) → curated (count)
//   → resolving / resolved (per track) → done (full card) | error
app.post("/api/generate/stream", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt" });
  }
  if (!curator.anthropicConfigured()) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }
  if (!spotify.isLoggedIn()) {
    return res.status(401).json({ error: "Not logged in to Spotify." });
  }
  sseInit(res);
  // Client abort (STOP) must stop the paid upstream work too. `close` also
  // fires after a normal end — writableEnded distinguishes the two.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  sseSend(res, "curating", { prompt });
  try {
    const card = await curator.generateCard(prompt, {
      signal: abort.signal,
      onTrack: (index, t) =>
        sseSend(res, "track", { index, artist: t.artist, title: t.title }),
    });
    sseSend(res, "curated", { count: card.tracks.length, title: card.title });
    card.tracks = await spotify.resolveTracks(
      card.tracks,
      3,
      (event, payload) => sseSend(res, event, payload),
      abort.signal
    );
    if (abort.signal.aborted) {
      console.log("[generate/stream] client disconnected — stopped");
      return res.end();
    }
    card.prompt = prompt;
    sseSend(res, "done", {
      card,
      verified: card.tracks.filter((t) => t.resolved).length,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      console.log("[generate/stream] client disconnected — stopped");
      return res.end();
    }
    console.error("[generate/stream] failed:", err.message);
    // detail stays in the server log — clients get a generic line
    sseSend(res, "error", { message: "Generation failed — check the server logs." });
  }
  res.end();
});

// Streaming refine ("second chance"). Body: { card, adjustment } — the client's
// card is authoritative (the user may have drag-reordered it). Emits, in order:
//   adjusting → change (per change, as Claude streams it) → adjusted (count)
//   → resolving / resolved (changed indices only) → done (merged card) | error
// Unchanged tracks never round-trip through the model or Spotify — their
// spotifyUri/albumArt/resolved fields survive byte-identical by construction.
app.post("/api/adjust/stream", async (req, res) => {
  const card = req.body?.card;
  const adjustment = String(req.body?.adjustment || "").trim();
  if (!adjustment || !card || !Array.isArray(card.tracks) || card.tracks.length === 0) {
    return res.status(400).json({ error: "Missing card or adjustment" });
  }
  if (!curator.anthropicConfigured()) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }
  if (!spotify.isLoggedIn()) {
    return res.status(401).json({ error: "Not logged in to Spotify." });
  }
  sseInit(res);
  // Same disconnect handling as /api/generate/stream.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  sseSend(res, "adjusting", { adjustment });
  try {
    const diff = await curator.adjustCard(card, adjustment, {
      signal: abort.signal,
      onChange: (_, c) =>
        sseSend(res, "change", {
          index: c.index,
          artist: c.track.artist,
          title: c.track.title,
        }),
    });
    sseSend(res, "adjusted", { count: diff.changes.length });
    // Resolve ONLY the replacements; remap the subset index back to the
    // track's position on the card so the client updates the right row.
    const replacements = diff.changes.map((c) => c.track);
    const resolved = await spotify.resolveTracks(
      replacements,
      3,
      (event, payload) =>
        sseSend(res, event, { ...payload, index: diff.changes[payload.index].index }),
      abort.signal
    );
    if (abort.signal.aborted) {
      console.log("[adjust/stream] client disconnected — stopped");
      return res.end();
    }
    const tracks = card.tracks.slice();
    diff.changes.forEach((c, i) => {
      tracks[c.index] = resolved[i];
    });
    const merged = {
      ...card,
      tracks,
      title: diff.title ?? card.title,
      vibe: diff.vibe ?? card.vibe,
      accent: diff.accent ?? card.accent,
      prompt: card.prompt, // the original prompt stays on the card
    };
    sseSend(res, "done", {
      card: merged,
      verified: tracks.filter((t) => t.resolved).length,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      console.log("[adjust/stream] client disconnected — stopped");
      return res.end();
    }
    console.error("[adjust/stream] failed:", err.message);
    sseSend(res, "error", { message: "Adjustment failed — check the server logs." });
  }
  res.end();
});

app.post("/api/playlist", async (req, res) => {
  const { title, uris, prompt } = req.body || {};
  if (!title || !Array.isArray(uris) || uris.length === 0) {
    return res.status(400).json({ error: "Missing title or uris" });
  }
  if (!spotify.isLoggedIn()) {
    return res.status(401).json({ error: "Not logged in to Spotify." });
  }
  // With Accept: text/event-stream, the two real steps (creating playlist →
  // adding N tracks) stream as SSE events; otherwise plain JSON as before.
  const wantsStream = String(req.headers.accept || "").includes("text/event-stream");
  try {
    if (wantsStream) {
      sseInit(res);
      const playlistUrl = await spotify.createPlaylist(
        {
          name: title,
          description: `made from prompt: ${prompt || ""}`.trim(),
          uris,
        },
        (event, data) => sseSend(res, event, data)
      );
      sseSend(res, "done", { playlistUrl });
      return res.end();
    }
    const playlistUrl = await spotify.createPlaylist({
      name: title,
      description: `made from prompt: ${prompt || ""}`.trim(),
      uris,
    });
    res.json({ playlistUrl });
  } catch (err) {
    console.error("[playlist] failed:", err.message);
    // detail stays in the server log — clients get a generic line
    const message =
      err.status === 401
        ? "Not logged in to Spotify."
        : "Saving the playlist failed — check the server logs.";
    if (wantsStream && res.headersSent) {
      sseSend(res, "error", { message });
      return res.end();
    }
    res.status(err.status === 401 ? 401 : 500).json({ error: message });
  }
});

// Loopback only: this server proxies two private credentials (Anthropic key,
// Spotify tokens) with no per-request auth — it must not be LAN-reachable.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Mixtape POC server listening on http://127.0.0.1:${PORT}`);
});
