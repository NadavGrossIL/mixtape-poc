// Mixtape POC server — Express on 8888.
// Spotify OAuth (authorization code flow) + Claude curator + track resolution.

import "./env.ts";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import * as spotify from "./spotify.ts";
import * as curator from "./curator.ts";
import * as logbook from "./logbook.ts";
import * as usage from "./usage.ts";
import { signUser, verifyUser } from "./session.ts";

// Tee console.* into the in-app logbook before anything logs, so even the
// startup config warnings below are readable from the browser.
logbook.patchConsole();

// PORT is injected by the host in production (Railway/Render); HOST must be
// 0.0.0.0 there so the platform router can reach the container. The loopback
// default keeps local dev LAN-invisible.
const PORT = Number(process.env.PORT) || 8888;
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

const app = express();
// req.secure must reflect the platform's TLS terminator, not the internal hop
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

// ── owner gate ───────────────────────────────────────────────

// This server proxies two private credentials (Anthropic key, Spotify tokens).
// Locally the loopback bind is the protection; deployed, APP_SECRET turns on
// a cookie gate so only people who were given the shared key get in. WHO they
// are is a separate question, answered by the Spotify session cookie below.
// The gate cookie carries a hash of the secret, never the secret itself.
const APP_SECRET = process.env.APP_SECRET || "";
const GATE_COOKIE = "mixtape_gate";
const GATE_TOKEN = APP_SECRET
  ? crypto.createHash("sha256").update(APP_SECRET).digest("hex")
  : null;

function timingSafeMatch(a: unknown, b: unknown): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readCookie(req: Request, name: string): string | null {
  const pair = String(req.headers.cookie || "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

function hasGateCookie(req: Request): boolean {
  const value = readCookie(req, GATE_COOKIE);
  return value !== null && timingSafeMatch(value, GATE_TOKEN);
}

const GATE_PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mixtape</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111;font-family:system-ui">
<form method="post" action="/gate" style="display:grid;gap:12px;width:min(280px,80vw)">
<input type="password" name="secret" placeholder="secret key" autofocus
  style="padding:12px;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee;font-size:16px">
<button style="padding:12px;border-radius:8px;border:0;background:#eee;color:#111;font-size:16px">enter</button>
</form>`;

if (APP_SECRET) {
  app.post("/gate", (req, res) => {
    if (!timingSafeMatch(req.body?.secret || "", APP_SECRET)) {
      return res.status(401).type("html").send(GATE_PAGE);
    }
    res.setHeader(
      "Set-Cookie",
      `${GATE_COOKIE}=${GATE_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` +
        (req.secure ? "; Secure" : "")
    );
    res.redirect("/");
  });
  app.use((req, res, next) => {
    // /callback is exempt: Spotify lands there mid-OAuth, and the state
    // check (issued only to a gated /auth/login) already gates it.
    if (req.path === "/callback" || hasGateCookie(req)) return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
      return res.status(401).json({ error: "Locked — reload the page and enter the secret key." });
    }
    res.status(401).type("html").send(GATE_PAGE);
  });
}

// ── who is this browser? ─────────────────────────────────────

// Friends log in with their own Spotify accounts (each added to the app's
// allowlist in the Spotify dashboard — dev mode caps that list at 5). After
// the OAuth callback identifies the account, an HMAC-signed cookie remembers
// it, so login is once per browser. The gate cookie answers "may you enter";
// this one answers "whose Spotify is this".
const SESSION_COOKIE = "mixtape_user";
// short-lived carrier for the OAuth state, set by /auth/login, checked and
// cleared by /callback
const OAUTH_COOKIE = "mixtape_oauth";
// APP_SECRET is the natural signing key. Local dev (no APP_SECRET) falls
// back to the Spotify client secret, then to a per-boot random key — which
// only means re-login after a restart, harmless on loopback.
const SESSION_KEY =
  APP_SECRET ||
  process.env.SPOTIFY_CLIENT_SECRET ||
  crypto.randomBytes(32).toString("hex");

function callerUser(req: Request): string | null {
  return verifyUser(readCookie(req, SESSION_COOKIE), SESSION_KEY);
}

// The caller's Spotify user id, or null AFTER sending the 401 — so routes
// can bail with a plain `if (!user) return`.
function requireSpotifyUser(req: Request, res: Response): string | null {
  const user = callerUser(req);
  if (user && spotify.isLoggedIn(user)) return user;
  res.status(401).json({ error: "Not logged in to Spotify." });
  return null;
}

// ── owner-only routes ────────────────────────────────────────

// The gate lets every friend in; logs and usage must not — they show other
// people's prompts and activity. The owner is whoever's Spotify id matches
// the owner token's /me (resolved once, no config). A server with NO owner
// token configured (fresh local clone) has no users to leak, so it keeps
// the old gate-only behavior there.
async function requireOwner(req: Request, res: Response): Promise<boolean> {
  if (!spotify.isLoggedIn()) return true; // no owner identity configured
  const ownerId = await spotify.getOwnerId();
  if (ownerId && callerUser(req) === ownerId) return true;
  res.status(401).json({ error: "Owner only." });
  return false;
}

// ── per-user daily cap ───────────────────────────────────────

// Generation spends two budgets SHARED by every user: the Anthropic key and
// Spotify's per-developer-account daily search quota (low hundreds of
// searches/day — one enthusiastic friend could lock the whole app out for
// ~19h). In-memory is enough: it resets on redeploy, which at friends scale
// is a feature, not a bug.
const DAILY_CAP = Number(process.env.DAILY_GENERATIONS_PER_USER) || 25;
const generationsToday = new Map<string, { day: string; count: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function underDailyCap(user: string): boolean {
  const entry = generationsToday.get(user);
  return !entry || entry.day !== today() || entry.count < DAILY_CAP;
}

function countGeneration(user: string) {
  const entry = generationsToday.get(user);
  if (entry && entry.day === today()) entry.count += 1;
  else generationsToday.set(user, { day: today(), count: 1 });
}

// ── auth ─────────────────────────────────────────────────────

// states issued by /auth/login, consumed by /callback — state → issued-at.
// Expired lazily on the two auth routes; abandoned logins must not make a
// state valid forever (or grow the map unboundedly).
const pendingStates = new Map<string, number>();
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
  // The state also rides a short-lived cookie so /callback can check that it
  // came back on the SAME browser that started the login — otherwise a forged
  // callback link could attach an attacker's Spotify account to a victim's
  // session (login CSRF). SameSite=Lax still sends it on the top-level
  // redirect back from accounts.spotify.com.
  res.setHeader(
    "Set-Cookie",
    `${OAUTH_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600` +
      (req.secure ? "; Secure" : "")
  );
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
  if (!state || !pendingStates.has(state as string)) {
    return res.status(400).send("State mismatch — restart the login flow.");
  }
  if (readCookie(req, OAUTH_COOKIE) !== state) {
    return res.status(400).send("State mismatch — restart the login flow.");
  }
  pendingStates.delete(state as string);
  try {
    const { userId, displayName } = await spotify.exchangeCode(code as string);
    usage.record(userId, displayName, "login");
    res.setHeader("Set-Cookie", [
      `${SESSION_COOKIE}=${signUser(userId, SESSION_KEY)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` +
        (req.secure ? "; Secure" : ""),
      `${OAUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
    ]);
    console.log(`[auth] ${displayName || userId} connected their Spotify`);
    res.redirect(CLIENT_URL);
  } catch (err: any) {
    console.error("[auth] token exchange failed:", err.message);
    res.status(500).send("Token exchange with Spotify failed. Check the server logs.");
  }
});

app.get("/auth/status", async (req, res) => {
  const user = callerUser(req);
  const loggedIn = Boolean(user && spotify.isLoggedIn(user));
  // `owner` lets the client show owner-only surfaces (the log console's
  // usage strip) to the right person; the server still enforces it per route
  const owner = loggedIn && user === (await spotify.getOwnerId());
  res.json({ loggedIn, owner, name: loggedIn ? spotify.getDisplayName(user!) : null });
});

// ── api ──────────────────────────────────────────────────────

// SSE helpers — every event sent is driven by a real backend event.
function sseInit(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function sseSend(res: Response, event: string, data?: unknown) {
  // A resolver worker can outlive the response (peer throws → route ends the
  // stream); writing then would emit an uncaught stream error and crash.
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
}

// ── logbook ──────────────────────────────────────────────────

// The server's own log tail — OWNER only, not merely gated: log lines carry
// every user's prompts and activity.
app.get("/api/logs", async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  res.json({ entries: logbook.since(Number(req.query.since) || 0) });
});

// Live tail. `since` lets a reconnecting client resume without duplicating
// or dropping lines it already has.
app.get("/api/logs/stream", async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  sseInit(res);
  for (const entry of logbook.since(Number(req.query.since) || 0)) {
    sseSend(res, "log", entry);
  }
  // A quiet server would otherwise look like a dropped connection to any
  // proxy that times idle streams out.
  const beat = setInterval(() => sseSend(res, "ping"), 25_000);
  const unsubscribe = logbook.subscribe((entry) => sseSend(res, "log", entry));
  req.on("close", () => {
    clearInterval(beat);
    unsubscribe();
  });
});

// Who has been using the app — per-account login/generation/save counts.
// OWNER only, same reasoning as the logs.
app.get("/api/usage", async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  res.json({ users: usage.list() });
});

// The caller's playlists, for the "in the spirit of" seed picker.
app.get("/api/playlists", async (req, res) => {
  const user = requireSpotifyUser(req, res);
  if (!user) return;
  try {
    res.json({ playlists: await spotify.listPlaylists(user) });
  } catch (err: any) {
    console.error("[playlists] failed:", err.message);
    if (err.status === 401) {
      return res.status(401).json({ error: "Not logged in to Spotify." });
    }
    if (err.status === 403) {
      // token predates the playlist-read scopes — one re-login fixes it
      return res.status(403).json({ error: "insufficient_scope" });
    }
    res
      .status(500)
      .json({ error: "Listing playlists failed — check the server logs." });
  }
});

// Streaming generate. Emits, in order:
//   [seeding → seeded (when a seed playlist is set)]
//   → curating → track (per track, as Claude streams it) → curated (count)
//   → resolving / resolved (per track) → done (full card) | error
app.post("/api/generate/stream", async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  // seed: {id, name} — an existing playlist to build "in the spirit of".
  // The name is client-provided display text; the id is what gets fetched.
  const seedId = String(req.body?.seed?.id || "").trim();
  const seedName = String(req.body?.seed?.name || "").trim();
  if (seedId && !/^[A-Za-z0-9]{8,64}$/.test(seedId)) {
    return res.status(400).json({ error: "Invalid seed playlist id" });
  }
  if (!prompt && !seedId) {
    return res.status(400).json({ error: "Missing prompt" });
  }
  if (!curator.anthropicConfigured()) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }
  const user = requireSpotifyUser(req, res);
  if (!user) return;
  if (!underDailyCap(user)) {
    return res.status(429).json({
      error: `Daily mixtape limit reached (${DAILY_CAP}/day) — try again tomorrow.`,
    });
  }
  countGeneration(user);
  usage.record(user, spotify.getDisplayName(user), "generation");
  sseInit(res);
  // Client abort (STOP) must stop the paid upstream work too. `close` also
  // fires after a normal end — writableEnded distinguishes the two.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  try {
    let seed: { name: string; tracks: { artist: string; title: string }[]; total: number } | null =
      null;
    if (seedId) {
      sseSend(res, "seeding", { name: seedName });
      const { tracks, total } = await spotify.getSeedTracks(seedId, user);
      if (tracks.length === 0) {
        sseSend(res, "error", {
          message: "Couldn't read that playlist — it may be empty.",
        });
        return res.end();
      }
      seed = { name: seedName || "this playlist", tracks, total };
      sseSend(res, "seeded", { count: tracks.length, total });
    }
    console.log(
      `[generate/stream] (${spotify.getDisplayName(user) || user}) ` +
        `prompt=${JSON.stringify(prompt)}` +
        (seedId ? ` seed=${seedId}` : "")
    );
    sseSend(res, "curating", { prompt });
    const card = await curator.generateCard(prompt, {
      seed,
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
    if (seed) card.seed = { id: seedId, name: seed.name };
    const verified = card.tracks.filter((t) => t.resolved).length;
    console.log(
      `[generate/stream] done: "${card.title}" — ${verified}/${card.tracks.length} verified on Spotify`
    );
    sseSend(res, "done", { card, verified });
  } catch (err: any) {
    if (abort.signal.aborted) {
      console.log("[generate/stream] client disconnected — stopped");
      return res.end();
    }
    console.error("[generate/stream] failed:", err.message);
    // The only client is the gated owner, and the logbook they'd be sent to
    // is one tap away in the same page — so the real reason goes on screen
    // rather than being paraphrased as "check the server logs".
    sseSend(res, "error", {
      // Quota exhaustion is a wait-until-tomorrow condition, not a bug to retry
      // into — say so, or the obvious response is to hammer the button.
      message: err.quotaExceeded
        ? "Spotify's daily limit for this app is used up."
        : "Generation failed.",
      detail: err.message,
    });
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
  const user = requireSpotifyUser(req, res);
  if (!user) return;
  if (!underDailyCap(user)) {
    return res.status(429).json({
      error: `Daily mixtape limit reached (${DAILY_CAP}/day) — try again tomorrow.`,
    });
  }
  countGeneration(user);
  usage.record(user, spotify.getDisplayName(user), "adjust");
  sseInit(res);
  // Same disconnect handling as /api/generate/stream.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  console.log(
    `[adjust/stream] (${spotify.getDisplayName(user) || user}) ` +
      `adjustment=${JSON.stringify(adjustment)}`
  );
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
        sseSend(res, event, { ...payload, index: diff.changes[payload.index]!.index }),
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
      verified: tracks.filter((t: any) => t.resolved).length,
    });
  } catch (err: any) {
    if (abort.signal.aborted) {
      console.log("[adjust/stream] client disconnected — stopped");
      return res.end();
    }
    console.error("[adjust/stream] failed:", err.message);
    sseSend(res, "error", {
      message: err.quotaExceeded
        ? "Spotify's daily limit for this app is used up."
        : "Adjustment failed.",
      detail: err.message,
    });
  }
  res.end();
});

app.post("/api/playlist", async (req, res) => {
  const { title, uris, prompt } = req.body || {};
  if (!title || !Array.isArray(uris) || uris.length === 0) {
    return res.status(400).json({ error: "Missing title or uris" });
  }
  const user = requireSpotifyUser(req, res);
  if (!user) return;
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
        (event, data) => sseSend(res, event, data),
        user
      );
      usage.record(user, spotify.getDisplayName(user), "save");
      console.log(
        `[playlist] (${spotify.getDisplayName(user) || user}) saved ${JSON.stringify(title)}`
      );
      sseSend(res, "done", { playlistUrl });
      return res.end();
    }
    const playlistUrl = await spotify.createPlaylist(
      {
        name: title,
        description: `made from prompt: ${prompt || ""}`.trim(),
        uris,
      },
      undefined,
      user
    );
    usage.record(user, spotify.getDisplayName(user), "save");
    console.log(
      `[playlist] (${spotify.getDisplayName(user) || user}) saved ${JSON.stringify(title)}`
    );
    res.json({ playlistUrl });
  } catch (err: any) {
    console.error("[playlist] failed:", err.message);
    // detail stays in the server log — clients get a generic line
    const message = err.quotaExceeded
      ? "Spotify's daily limit for this app is used up — try again tomorrow."
      : err.status === 401
        ? "Not logged in to Spotify."
        : "Saving the playlist failed — check the server logs.";
    if (wantsStream && res.headersSent) {
      sseSend(res, "error", { message });
      return res.end();
    }
    res.status(err.status === 401 ? 401 : 500).json({ error: message });
  }
});

// ── production static client ─────────────────────────────────

// In dev the Vite server proxies /api, /auth and /callback here; deployed,
// Express serves the built client itself so everything stays same-origin
// (no CORS, relative fetches keep working). Registered last: API routes win.
const CLIENT_DIST = path.join(import.meta.dirname, "..", "client", "dist");
if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

if (HOST !== "127.0.0.1" && !APP_SECRET) {
  console.warn(
    "[config] HOST is not loopback but APP_SECRET is unset — anyone who can " +
      "reach this server can spend the Anthropic key and write to the Spotify " +
      "account. Set APP_SECRET."
  );
}

app.listen(PORT, HOST, () => {
  console.log(`Mixtape POC server listening on http://${HOST}:${PORT}`);
});
