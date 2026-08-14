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

// states issued by /auth/login, consumed by /callback
const pendingStates = new Set();

app.get("/auth/login", (req, res) => {
  if (!spotify.credentialsConfigured()) {
    return res
      .status(500)
      .send(
        "Spotify credentials are not configured. Fill in server/.env (see .env.example) and restart the server."
      );
  }
  const state = spotify.makeState();
  pendingStates.add(state);
  res.redirect(spotify.authorizeUrl(state));
});

app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Spotify authorization failed: ${error}`);
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
  res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
}

// Streaming variant of generate. Emits, in order:
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
  sseSend(res, "curating", { prompt });
  try {
    const card = await curator.generateCard(prompt, {
      onTrack: (index, t) =>
        sseSend(res, "track", { index, artist: t.artist, title: t.title }),
    });
    sseSend(res, "curated", { count: card.tracks.length, title: card.title });
    card.tracks = await spotify.resolveTracks(card.tracks, 3, (event, payload) =>
      sseSend(res, event, payload)
    );
    card.prompt = prompt;
    sseSend(res, "done", {
      card,
      verified: card.tracks.filter((t) => t.resolved).length,
    });
  } catch (err) {
    console.error("[generate/stream] failed:", err.message);
    sseSend(res, "error", { message: err.message });
  }
  res.end();
});

app.post("/api/generate", async (req, res) => {
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
  try {
    const card = await curator.generateCard(prompt);
    // Resolve every track; unresolved tracks are kept and flagged —
    // the resolved/unresolved split is the hallucination-rate measurement.
    card.tracks = await spotify.resolveTracks(card.tracks, 3);
    card.prompt = prompt;
    res.json(card);
  } catch (err) {
    console.error("[generate] failed:", err.message);
    res.status(err.status === 401 ? 401 : 500).json({ error: err.message });
  }
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
    if (wantsStream && res.headersSent) {
      sseSend(res, "error", { message: err.message });
      return res.end();
    }
    res.status(err.status === 401 ? 401 : 500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Mixtape POC server listening on http://127.0.0.1:${PORT}`);
});
