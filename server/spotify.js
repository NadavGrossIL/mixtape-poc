// Spotify auth + Web API helpers (2026 API surface).
// - Playlists are created via POST /v1/me/playlists (the /users/{id}/playlists
//   route was removed in the Feb 2026 API update).
// - Playlist item endpoints are /v1/playlists/{id}/items (renamed from /tracks).
//   The add-items request body still uses the "uris" key (verified against
//   developer.spotify.com/documentation/web-api/reference/add-items-to-playlist).
// - Dev-mode apps: search max limit=10; track objects no longer include
//   popularity / external_ids / available_markets — do not reference those.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOKENS_PATH = path.join(__dirname, ".tokens.json");
const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = "playlist-modify-private playlist-modify-public";

const PLACEHOLDER_RE = /^(your_|sk-ant-your|<|\.\.\.|xxx)/i;

function credentialsConfigured() {
  const id = process.env.SPOTIFY_CLIENT_ID || "";
  const secret = process.env.SPOTIFY_CLIENT_SECRET || "";
  return (
    id.length > 0 &&
    secret.length > 0 &&
    !PLACEHOLDER_RE.test(id) &&
    !PLACEHOLDER_RE.test(secret)
  );
}

// ── token persistence ────────────────────────────────────────

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
}

function isLoggedIn() {
  const t = loadTokens();
  return Boolean(t && t.refresh_token);
}

// ── OAuth (authorization code flow) ──────────────────────────

function makeState() {
  return crypto.randomBytes(16).toString("hex");
}

function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

async function tokenRequest(body) {
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Spotify token endpoint ${res.status}: ${text}`);
  }
  return res.json();
}

async function exchangeCode(code) {
  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Not logged in to Spotify");
  }
  const data = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  saveTokens({
    access_token: data.access_token,
    // Spotify may or may not rotate the refresh token
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return loadTokens();
}

async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    const err = new Error("Not logged in to Spotify");
    err.status = 401;
    throw err;
  }
  if (!tokens.access_token || Date.now() > tokens.expires_at - 30_000) {
    tokens = await refreshAccessToken();
  }
  return tokens.access_token;
}

// Authenticated fetch with one automatic refresh-and-retry on 401.
async function spotifyFetch(pathname, options = {}, retried = false) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    await refreshAccessToken();
    return spotifyFetch(pathname, options, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Spotify API ${res.status} on ${pathname}: ${text}`);
    err.status = res.status;
    throw err;
  }
  // 201/200 with JSON bodies everywhere we call
  return res.json();
}

// ── track resolution ─────────────────────────────────────────

function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/\(.*?\)|\[.*?\]/g, " ") // drop parentheticals like (Remastered)
    .replace(/&/g, " and ") // "&" ≈ "and"
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(ta.size, tb.size);
}

const MATCH_THRESHOLD = 0.55;

// Strip parenthetical suffixes and trailing feat./ft./featuring/with segments.
// "Krizz Kaliko ft. Tech N9ne" → "Krizz Kaliko"
// "Look at Me Now (verse)"     → "Look at Me Now"
function stripSuffixes(s) {
  return String(s)
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Featured-artist-tolerant artist score: the curated artist counts as a match
// if it is ANY of the candidate's artists (or the joined list), and a curated
// "X ft. Y" also matches on its primary artist X alone.
function artistScore(itemArtists, curatedArtist) {
  const names = (itemArtists || []).map((a) => a.name);
  const candidates = names.length > 1 ? names.concat(names.join(" ")) : names;
  const variants = [curatedArtist, stripSuffixes(curatedArtist)];
  let best = 0;
  for (const v of variants) {
    for (const c of candidates) {
      const s = similarity(c, v);
      if (s > best) best = s;
    }
  }
  return best;
}

// Search strategies, tried in order until one produces a confident match:
// 1. field-filtered as curated, 2. plain free text, 3. normalized variant
// (parenthetical / feat. suffixes and punctuation stripped).
function buildQueries(track) {
  const raw = [
    { strategy: "field", q: `artist:"${track.artist}" track:"${track.title}"` },
    { strategy: "plain", q: `${track.artist} ${track.title}` },
    {
      strategy: "normalized",
      q: `${normalize(stripSuffixes(track.artist))} ${normalize(stripSuffixes(track.title))}`.trim(),
    },
  ];
  const seen = new Set();
  return raw.filter(({ q }) => {
    if (!q.trim() || seen.has(q)) return false;
    seen.add(q);
    return true;
  });
}

// A candidate must show SOME artist overlap — a perfect title with a wrong
// artist (covers, karaoke, same-name songs) must never count as a match,
// or hallucinated tracks silently "resolve" to the wrong record.
const ARTIST_FLOOR = 0.3;

// Resolve one curated track against Spotify search (multi-strategy).
// Dev-mode search cap is limit=10 — use all of it.
async function resolveTrack(track) {
  const label = `"${track.artist} — ${track.title}"`;
  let best = null; // best candidate meeting the artist floor
  let bestAny = null; // best overall, for honest fail logging

  for (const { strategy, q } of buildQueries(track)) {
    let items = [];
    try {
      const params = new URLSearchParams({ q, type: "track", limit: "10" });
      const data = await spotifyFetch(`/search?${params}`);
      items = data?.tracks?.items || [];
    } catch (err) {
      if (err.status === 401) throw err; // login problem — surface it
      console.warn(`[resolve] search error (${strategy}) for ${label}: ${err.message}`);
      continue;
    }

    for (const item of items) {
      const titleScore = similarity(item.name, track.title);
      const aScore = artistScore(item.artists, track.artist);
      const score = 0.6 * titleScore + 0.4 * aScore;
      if (!bestAny || score > bestAny.score) {
        bestAny = { item, score, strategy };
      }
      if (aScore >= ARTIST_FLOOR && (!best || score > best.score)) {
        best = { item, score, strategy };
      }
    }
    if (best && best.score >= MATCH_THRESHOLD) break; // confident — stop here
  }

  if (!best || best.score < MATCH_THRESHOLD) {
    // The product's hallucination measurement — keep this line honest.
    console.log(
      `[resolve] ✗ ${label} unresolved after all strategies` +
        (bestAny ? ` (best ${bestAny.score.toFixed(2)})` : " (no results)")
    );
    return { ...track, resolved: false };
  }

  const { item, score, strategy } = best;
  const matchedName = `${(item.artists || []).map((a) => a.name).join(", ")} — ${item.name}`;
  console.log(
    `[resolve] ✓ ${label} via ${strategy} → "${matchedName}" (${score.toFixed(2)})`
  );
  const images = item.album?.images || [];
  const albumArt = images.length ? images[images.length - 1].url : null; // smallest
  return {
    ...track,
    resolved: true,
    spotifyUrl: item.external_urls?.spotify || null,
    spotifyUri: item.uri,
    albumArt,
    matchedName,
  };
}

// Resolve all tracks with a small concurrency pool (respects rate limits).
// onProgress(event, payload) fires per track: "resolving", then "resolved".
async function resolveTracks(tracks, concurrency = 3, onProgress) {
  const results = new Array(tracks.length);
  let next = 0;
  async function worker() {
    while (next < tracks.length) {
      const i = next++;
      if (onProgress) {
        onProgress("resolving", {
          index: i,
          artist: tracks[i].artist,
          title: tracks[i].title,
        });
      }
      results[i] = await resolveTrack(tracks[i]);
      if (onProgress) {
        onProgress("resolved", {
          index: i,
          artist: tracks[i].artist,
          title: tracks[i].title,
          resolved: Boolean(results[i].resolved),
          matched: results[i].matchedName || null,
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tracks.length) }, worker)
  );
  return results;
}

// ── playlist creation ────────────────────────────────────────

// onProgress(event, payload) fires on the two real steps:
// "creating" (playlist create request) and "adding" (adding N tracks).
async function createPlaylist({ name, description, uris }, onProgress) {
  // POST /v1/me/playlists — NOT /users/{id}/playlists (removed Feb 2026)
  if (onProgress) onProgress("creating", { name });
  const playlist = await spotifyFetch("/me/playlists", {
    method: "POST",
    body: JSON.stringify({ name, description, public: false }),
  });
  if (uris.length) {
    // POST /v1/playlists/{id}/items (renamed from /tracks); body key is "uris"
    if (onProgress) onProgress("adding", { count: uris.length });
    await spotifyFetch(`/playlists/${playlist.id}/items`, {
      method: "POST",
      body: JSON.stringify({ uris }),
    });
  }
  return playlist.external_urls?.spotify || null;
}

module.exports = {
  credentialsConfigured,
  isLoggedIn,
  makeState,
  authorizeUrl,
  exchangeCode,
  resolveTracks,
  createPlaylist,
};
