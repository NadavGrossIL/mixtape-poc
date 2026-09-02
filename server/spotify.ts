// Spotify auth + Web API helpers (2026 API surface).
// - Playlists are created via POST /v1/me/playlists (the /users/{id}/playlists
//   route was removed in the Feb 2026 API update).
// - Playlist item endpoints are /v1/playlists/{id}/items (renamed from /tracks).
//   The add-items request body still uses the "uris" key (verified against
//   developer.spotify.com/documentation/web-api/reference/add-items-to-playlist).
// - Dev-mode apps: search max limit=10; track objects no longer include
//   popularity / available_markets — do not reference those. external_ids.isrc,
//   duration_ms, track_number, album.album_type and album.total_tracks were
//   re-verified on the wire against the current /search reference (2026-08-18).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { SearchBudget } from "./searchBudget.ts";

// quotaExceeded marks the dev-mode DAILY quota (see the 429 handling below),
// which callers must treat as a hard stop rather than a transient error.
type HttpError = Error & { status?: number; quotaExceeded?: boolean };

const TOKENS_PATH = path.join(import.meta.dirname, ".tokens.json");
const ACCOUNTS = "https://accounts.spotify.com";
const API = "https://api.spotify.com/v1";
// Deployed, this must be the app's public https://<host>/callback and match
// the Spotify dashboard exactly; the loopback default is for local dev.
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:8888/callback";
const SCOPES =
  "playlist-modify-private playlist-modify-public " +
  // read scopes power the "in the spirit of" seed picker; tokens issued
  // before these were added get 403s on the read endpoints until re-login
  "playlist-read-private playlist-read-collaborative";

const PLACEHOLDER_RE = /^(your_|sk-ant-your|<|\.\.\.|xxx)/i;

function credentialsConfigured(): boolean {
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
//
// One file, many users: friends log in with their own Spotify accounts
// (each added to the app's dashboard allowlist — dev mode caps that list at
// 5 accounts, permanently). Keys are Spotify user ids, plus the reserved
// key "owner" for the account bootstrapped from SPOTIFY_REFRESH_TOKEN —
// the identity for catalog search and for anything that runs outside a
// request (evals, scripts).

const OWNER = "owner";
// The HOST is the account every mixtape is pressed into — a dedicated
// "Mixtape" Spotify account whose public profile is the product's shelf.
// Visitors beyond the 5-user allowlist can't log in, so the playlist can't
// land in THEIR library; it lands here, public, and they keep it with one
// tap (+) in Spotify. Bootstrapped from SPOTIFY_HOST_REFRESH_TOKEN; falls
// back to the owner so a deploy without a host account still works.
const HOST = "host";

interface StoredTokens {
  access_token: string | null;
  refresh_token: string;
  expires_at: number;
  display_name?: string | null;
}

interface TokenStore {
  users: Record<string, StoredTokens>;
}

// Pure, exported for tests. Accepts both shapes: the current {users: {...}}
// and the pre-multi-user flat record, which belonged to the owner.
function parseTokenStore(parsed: unknown): TokenStore {
  const p = parsed as any;
  if (p && typeof p === "object" && p.users && typeof p.users === "object") {
    return { users: p.users };
  }
  if (p && typeof p === "object" && typeof p.refresh_token === "string") {
    return { users: { [OWNER]: p } };
  }
  return { users: {} };
}

function loadStore(): TokenStore {
  try {
    return parseTokenStore(JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")));
  } catch {
    return { users: {} };
  }
}

function loadTokens(user: string): StoredTokens | null {
  const stored = loadStore().users[user];
  if (stored) return stored;
  // No stored entry (fresh container, ephemeral disk wiped on redeploy):
  // the two service identities bootstrap from env so a deployed server
  // comes back logged in. expires_at 0 forces a refresh on first use.
  const envRefresh =
    user === OWNER
      ? process.env.SPOTIFY_REFRESH_TOKEN
      : user === HOST
        ? process.env.SPOTIFY_HOST_REFRESH_TOKEN
        : "";
  const refresh = envRefresh || "";
  if (refresh && !PLACEHOLDER_RE.test(refresh)) {
    return { access_token: null, refresh_token: refresh, expires_at: 0 };
  }
  return null;
}

function saveTokens(user: string, tokens: StoredTokens) {
  // Read-modify-write of the whole store, all synchronous — no await point
  // for another user's save to interleave with. temp-then-rename: a crash
  // mid-write must never corrupt .tokens.json (a corrupt file silently
  // reads as everyone-logged-out).
  const store = loadStore();
  store.users[user] = tokens;
  const tmp = `${TOKENS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  // The mode option only applies when the file is CREATED. A .tokens.json.tmp
  // left behind by a crash — written under a wider umask, or by an older
  // build — is reopened and reused, keeping whatever mode it already had, and
  // this file holds plaintext refresh tokens. The chmod is not redundant with
  // the line above; it is the half that covers the leftover.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, TOKENS_PATH);
}

function isLoggedIn(user: string = OWNER): boolean {
  const t = loadTokens(user);
  return Boolean(t && t.refresh_token);
}

function getDisplayName(user: string): string | null {
  return loadTokens(user)?.display_name ?? null;
}

// The owner's Spotify user id — the admin identity for owner-only routes
// (logs, usage). Resolved lazily from the owner token's /me and cached for
// the process; a failed resolution is retried on the next call rather than
// cached, so a transient error can't lock the owner out for the boot.
let ownerIdCache: string | null = null;
async function getOwnerId(): Promise<string | null> {
  if (ownerIdCache) return ownerIdCache;
  if (!isLoggedIn(OWNER)) return null;
  try {
    const me = await spotifyFetch("/me", {}, {}, OWNER);
    ownerIdCache = String(me?.id || "") || null;
  } catch (err: any) {
    console.warn(`[spotify] resolving the owner identity failed: ${err.message}`);
    return null;
  }
  return ownerIdCache;
}

// The identity catalog search runs as. Search results are user-agnostic, so
// any logged-in account works; preferring the owner keeps deployed behavior
// (the env-bootstrapped token), and the fallback keeps local dev working
// when someone logged in through the browser without setting the env var.
function catalogUser(): string {
  if (isLoggedIn(OWNER)) return OWNER;
  return Object.keys(loadStore().users)[0] || OWNER;
}

// The account playlists are pressed into. Without a configured host token
// the owner's own account hosts them (local dev, or a deploy that hasn't
// set up the Mixtape account yet).
function hostUser(): string {
  return isLoggedIn(HOST) ? HOST : catalogUser();
}

// ── pasted playlist references ───────────────────────────────

// Visitors who can't log in seed from a playlist LINK instead of the picker.
// Accepts the share URL (with ?si= and locale prefixes), the spotify: URI,
// or a bare id. Pure; null means "not a playlist reference".
const PLAYLIST_ID_RE = /^[A-Za-z0-9]{22}$/;
function parsePlaylistRef(input: unknown): string | null {
  const text = String(input || "").trim();
  if (!text) return null;
  if (PLAYLIST_ID_RE.test(text)) return text;
  const uri = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(text);
  if (uri) return uri[1]!;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0]?.startsWith("intl-")) parts.shift();
  if (parts[0] === "playlist" && parts[1] && PLAYLIST_ID_RE.test(parts[1])) {
    return parts[1];
  }
  return null;
}

// The pressed playlist's name on a PUBLIC profile — the visitor's title,
// tidied: no control characters, no runaway whitespace, Spotify's 100-char
// limit respected, never empty. The prompt itself never goes on the playlist.
const PLAYLIST_NAME_MAX = 100;
function sanitizePlaylistName(input: unknown): string {
  const name = String(input || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PLAYLIST_NAME_MAX)
    .trim();
  return name || "Mixtape";
}

// ── OAuth (authorization code flow) ──────────────────────────

function makeState(): string {
  return crypto.randomBytes(16).toString("hex");
}

function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID!,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
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

async function exchangeCode(
  code: string
): Promise<{ userId: string; displayName: string | null }> {
  const data = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  // /me tells us WHO just logged in — the token store and the session
  // cookie are both keyed by the Spotify user id. Direct fetch rather than
  // spotifyFetch: that helper only serves already-stored users.
  const res = await fetch(`${API}/me`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!res.ok) {
    throw new Error(`Spotify /me failed after login: ${res.status}`);
  }
  const me = await res.json();
  const userId = String(me?.id || "");
  if (!userId) throw new Error("Spotify /me returned no user id");
  const displayName = me?.display_name || null;
  saveTokens(userId, {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    display_name: displayName,
  });
  return { userId, displayName };
}

async function refreshAccessToken(user: string): Promise<StoredTokens> {
  const tokens = loadTokens(user);
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Not logged in to Spotify");
  }
  const data = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  saveTokens(user, {
    ...tokens,
    access_token: data.access_token,
    // Spotify may or may not rotate the refresh token
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
  return loadTokens(user)!;
}

// Single-flight PER USER: concurrent resolver workers seeing an expired
// token must share ONE refresh. Parallel refreshes race on .tokens.json
// (last-write-wins can persist a stale refresh_token when Spotify rotates
// it → silent logout).
const refreshInFlight = new Map<string, Promise<StoredTokens>>();
function refreshOnce(user: string): Promise<StoredTokens> {
  let inflight = refreshInFlight.get(user);
  if (!inflight) {
    inflight = refreshAccessToken(user).finally(() => {
      refreshInFlight.delete(user);
    });
    refreshInFlight.set(user, inflight);
  }
  return inflight;
}

async function getAccessToken(user: string = OWNER): Promise<string> {
  let tokens = loadTokens(user);
  if (!tokens || !tokens.refresh_token) {
    const err: HttpError = new Error("Not logged in to Spotify");
    err.status = 401;
    throw err;
  }
  if (!tokens.access_token || Date.now() > tokens.expires_at - 30_000) {
    tokens = await refreshOnce(user);
  }
  return tokens.access_token!;
}

// ── rate limits vs quota ─────────────────────────────────────
//
// Spotify returns 429 for two DIFFERENT mechanisms, and conflating them is why
// a "retry in 30s" loop can spin against a wall for hours:
//
//   1. Rate limit — the rolling 30-second window. Short, recoverable, retry it.
//   2. Quota (`"reason": "QUOTA_EXCEEDED"`) — a dev-mode-only, largely DAILY
//      allowance shared across the whole developer account, with endpoints
//      grouped into buckets. Observed Retry-After: 6-24 HOURS (we measured
//      69,785s / 19.4h on /search). Retrying is pointless; the only correct
//      move is to stop and say so.
//      https://developer.spotify.com/documentation/web-api/concepts/quota-modes
//
// The `reason` field was added 2026-07-23 precisely so clients can tell them
// apart — so branch on it rather than on the status code alone.

const MAX_RETRY_WAIT = 30; // seconds — the ceiling for a real rate-limit retry
// Retry-After is documented as only "normally" present, and quota 429s have
// been reported without it. No header + a quota marker = assume hours, not
// seconds; one wasted probe an hour beats a hot loop.
const DEFAULT_QUOTA_COOLDOWN = 60 * 60;

// When the quota breaker is open, every Spotify call fails locally without
// touching the network. A blocked app that keeps firing requests is just
// digging — and each attempt can push the cooldown further out.
let quotaBlockedUntil = 0;

function quotaBlockedFor(): number {
  const left = quotaBlockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// Track length as "M:SS" — the shape a liner note quotes. formatDuration above
// is for waits ("4m" would round 4:08 and 4:52 to the same string, which is
// useless against a ±30s grounding check).
function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  const s = total % 60;
  return `${Math.floor(total / 60)}:${String(s).padStart(2, "0")}`;
}

// Decide what a 429 actually was. Pure, so the branch that matters most can be
// tested without a network or a token.
//   quota:    stop entirely; `cooldown` seconds until the app may call again
//   !quota:   a real rate limit; sleep `wait` seconds and retry once
function classify429(
  body: string,
  retryAfterHeader: string | null
): { quota: boolean; cooldown: number; wait: number } {
  const retryAfter = Number(retryAfterHeader) || 0;
  // The marker is authoritative; a Retry-After past the retry ceiling implies
  // the same thing for the older responses that don't carry it.
  const quota = /QUOTA_EXCEEDED/i.test(body) || retryAfter > MAX_RETRY_WAIT;
  return {
    quota,
    cooldown: quota ? retryAfter || DEFAULT_QUOTA_COOLDOWN : 0,
    wait: quota ? 0 : Math.min(Math.max(retryAfter || 1, 1), MAX_RETRY_WAIT),
  };
}

function quotaError(seconds: number): HttpError {
  const err: HttpError = new Error(
    `Spotify's daily quota for this app is used up — it can't be called again ` +
      `for about ${formatDuration(seconds)}. This is a per-developer-account ` +
      `limit on development-mode apps, not a login problem.`
  );
  err.status = 429;
  err.quotaExceeded = true;
  return err;
}

// Authenticated fetch. One refresh-and-retry on 401, one backoff-and-retry on a
// genuine rate limit, and NO retry on a quota 429 (see above).
async function spotifyFetch(
  pathname: string,
  options: RequestInit & { headers?: Record<string, string> } = {},
  // Separate flags: a request that already spent its 401 retry must still be
  // allowed its rate-limit retry, and vice versa.
  retried: { auth?: boolean; rate?: boolean } = {},
  // whose token to call with — /me endpoints are per-user; catalog search
  // stays on catalogUser() (quota is charged per developer app either way)
  user: string = OWNER
): Promise<any> {
  const blocked = quotaBlockedFor();
  if (blocked > 0) throw quotaError(blocked);

  const token = await getAccessToken(user);
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && !retried.auth) {
    await refreshOnce(user);
    return spotifyFetch(pathname, options, { ...retried, auth: true }, user);
  }
  if (res.status === 429) {
    const body = await res.text().catch(() => "");
    const verdict = classify429(body, res.headers.get("retry-after"));
    if (verdict.quota) {
      quotaBlockedUntil = Date.now() + verdict.cooldown * 1000;
      console.error(
        `[spotify] DAILY QUOTA EXHAUSTED on ${pathname} — no further calls ` +
          `for ${formatDuration(verdict.cooldown)} ` +
          `(Retry-After: ${res.headers.get("retry-after") || "absent"})`
      );
      throw quotaError(verdict.cooldown);
    }
    if (!retried.rate) {
      // Real rolling-window limit. Jitter matters: a batch of parallel searches
      // all computing the same wait would wake together and re-trip it.
      const wait = verdict.wait;
      const jittered = wait + Math.random() * Math.min(wait, 5);
      console.warn(
        `[spotify] rate-limited on ${pathname} — retrying in ${jittered.toFixed(1)}s`
      );
      await new Promise((resolve) => setTimeout(resolve, jittered * 1000));
      return spotifyFetch(pathname, options, { ...retried, rate: true }, user);
    }
    const err: HttpError = new Error(`Spotify API 429 on ${pathname}: ${body}`);
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: HttpError = new Error(`Spotify API ${res.status} on ${pathname}: ${text}`);
    err.status = res.status;
    throw err;
  }
  // 201/200 with JSON bodies everywhere we call — except DELETE
  // /playlists/{id}/followers, which returns an empty body
  const text = await res.text().catch(() => "");
  return text ? JSON.parse(text) : null;
}

// ── track resolution ─────────────────────────────────────────

function normalize(s: unknown): string {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/\(.*?\)|\[.*?\]/g, " ") // drop parentheticals like (Remastered)
    .replace(/&/g, " and ") // "&" ≈ "and"
    // keep every script's letters, not just a-z — a Hebrew (or Japanese, or
    // Cyrillic) title normalized to "" scores 0 against anything, so the
    // track can never verify no matter what Spotify returns
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
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
function stripSuffixes(s: unknown): string {
  return String(s)
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s+.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Featured-artist-tolerant artist score: the curated artist counts as a match
// if it is ANY of the candidate's artists (or the joined list), and a curated
// "X ft. Y" also matches on its primary artist X alone.
function artistScore(itemArtists: { name: string }[] | undefined, curatedArtist: string): number {
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
function buildQueries(track: { artist: string; title: string }): { strategy: string; q: string }[] {
  // `"` inside a value terminates the field filter early and malforms the query
  const fArtist = String(track.artist).replace(/"/g, "");
  const fTitle = String(track.title).replace(/"/g, "");
  const raw = [
    { strategy: "field", q: `artist:"${fArtist}" track:"${fTitle}"` },
    { strategy: "plain", q: `${track.artist} ${track.title}` },
    {
      strategy: "normalized",
      q: `${normalize(stripSuffixes(track.artist))} ${normalize(stripSuffixes(track.title))}`.trim(),
    },
  ];
  const seen = new Set<string>();
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

// ── search cache ─────────────────────────────────────────────
//
// Every /search call spends from a small daily allowance, so a repeated query
// is a real cost, not just latency. Catalog results for a given query are
// near-static, which makes a long TTL safe.
//
// Two layers, both fed by the same searches:
//   - byQuery: query → results, so an identical query is free forever after.
//   - byTitle: normalized title → every track record ever seen under it. This
//     is the one that matters. The curator agent searches each track to verify
//     it, and resolution then searches THE SAME TRACK AGAIN under a different
//     query shape ('Busta Rhymes Break Ya Neck' vs 'artist:"..." track:"..."'),
//     so a query-only cache would miss every time. Indexing the records
//     themselves lets resolution reuse what verification already fetched.

const CACHE_PATH = path.join(import.meta.dirname, ".search-cache.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Empty results get a MUCH shorter life. Caching a genuine "this track does not
// exist" is the point — but `[]` is indistinguishable from a silently malformed
// success, and Spotify has renamed response envelopes before (Feb 2026 moved
// playlist `tracks` → `items`). At the 7-day TTL, one bad hour would look like
// a week of hallucinated tracks; at an hour, it heals itself.
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;
// byTitle and byRef are fed by byQuery, and every query seeds up to 10 records,
// so a full query cache legitimately produces ~10x as many keys here — hence
// 20000 rather than 2000. They used to have no bound at all and grew for the
// life of the process. Sizing them tightly would be the wrong fix: byTitle is
// what lets resolution reuse the records verification already fetched (see the
// two-layers note above), so an entry evicted early is a search re-paid out of
// a daily quota measured in the low hundreds.
const RECORD_MAX_ENTRIES = CACHE_MAX_ENTRIES * 10;

// Cheapest possible eviction for a map with no timestamps: JS Maps iterate in
// insertion order, so the first keys are the least recently added. One pass, a
// tenth dropped at a time, so this runs rarely rather than on every insert.
// (byQuery evicts by its own `at` field instead — it has one, these don't.)
function evictOldest<V>(map: Map<string, V>, max: number): void {
  if (map.size < max) return;
  let drop = Math.ceil(max / 10);
  for (const key of map.keys()) {
    if (drop-- <= 0) break;
    map.delete(key);
  }
}

interface CacheEntry {
  items: any[];
  at: number;
}

let byQuery: Map<string, CacheEntry> | null = null;
const byTitle = new Map<string, any[]>();
// ref → the exact record the server fetched. `ref` is the Spotify track id, so
// it is stable, self-describing, and survives a restart via the cached entries.
const byRef = new Map<string, any>();

function isFresh(entry: CacheEntry | undefined): boolean {
  if (!entry) return false;
  const ttl = entry.items.length === 0 ? NEGATIVE_TTL_MS : CACHE_TTL_MS;
  return Date.now() - entry.at < ttl;
}

// The id half of "spotify:track:6rqhFgbbKwnb9MLmUQDhG6" — what the model quotes
// back as `ref` to say "this exact record is the one I verified".
function refOf(item: any): string {
  return String(item?.uri || "").split(":").pop() || "";
}

// Keep only the fields the resolver, the card, and the note-grounding gate
// actually read — the cache is persisted, and whole Spotify item objects would
// bloat it for nothing.
//
// Cache entries written before a field was added simply lack it, so every
// consumer must treat a missing field as null. No version bump, no
// invalidation: the 7-day TTL self-heals, and invalidating would re-spend the
// daily quota that already paid for these entries.
function trimItem(item: any): any {
  const images = item?.album?.images || [];
  return {
    name: item?.name,
    uri: item?.uri,
    artists: (item?.artists || []).map((a: any) => ({ name: a?.name })),
    external_urls: { spotify: item?.external_urls?.spotify || null },
    duration_ms: item?.duration_ms ?? null,
    isrc: item?.external_ids?.isrc ?? null,
    track_number: item?.track_number ?? null,
    album: {
      name: item?.album?.name || "",
      release_date: item?.album?.release_date || "",
      album_type: item?.album?.album_type ?? null,
      total_tracks: item?.album?.total_tracks ?? null,
      // smallest only — that is the one resolveTrack picks for album art
      images: images.length ? [{ url: images[images.length - 1].url }] : [],
    },
  };
}

function cacheKey(q: string): string {
  // Normalized, so 'Beyoncé Halo' and 'Beyonce Halo' share one entry. Field
  // filters normalize to a distinct shape ('artist x track y'), which is
  // correct — they return different results than the same words as free text.
  return normalize(q) || String(q).trim().toLowerCase();
}

function titleKey(title: unknown): string {
  return normalize(stripSuffixes(title));
}

function rememberItems(items: any[]) {
  for (const item of items) {
    const ref = refOf(item);
    if (ref) {
      evictOldest(byRef, RECORD_MAX_ENTRIES);
      byRef.set(ref, item);
    }
    const key = titleKey(item?.name);
    if (!key) continue;
    const bucket = byTitle.get(key);
    if (!bucket) {
      // only a NEW key grows the map; appending to a bucket does not
      evictOldest(byTitle, RECORD_MAX_ENTRIES);
      byTitle.set(key, [item]);
    } else if (!bucket.some((i) => i.uri === item.uri)) {
      bucket.push(item);
    }
  }
}

function loadSearchCache(): Map<string, CacheEntry> {
  if (byQuery) return byQuery;
  byQuery = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    for (const [key, entry] of Object.entries<any>(raw?.entries || {})) {
      if (!isFresh(entry)) continue;
      byQuery.set(key, entry);
      rememberItems(entry.items || []);
    }
    console.log(`[spotify] search cache: ${byQuery.size} queries loaded`);
  } catch {
    // No cache file, or a corrupt one — an empty cache is always safe.
  }
  return byQuery;
}

let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;

function flushSearchCache() {
  if (!byQuery) return;
  try {
    const tmp = `${CACHE_PATH}.tmp`;
    // No secrets in here, unlike .tokens.json — but it sits in the same
    // directory and is written the same way, so it gets the same owner-only
    // mode rather than whatever the umask happens to be.
    fs.writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(byQuery) }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err: any) {
    // A read-only or full disk must degrade to an in-memory cache, not a crash.
    console.warn(`[spotify] search cache write failed: ${err.message}`);
  }
}

function scheduleCacheWrite() {
  if (cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(() => {
    cacheWriteTimer = null;
    flushSearchCache();
  }, 5000);
  // must never hold the process open (tests, one-shot scripts)
  cacheWriteTimer.unref?.();
}

// The debounce above is unref'd, so without this every shutdown discards up to
// 5s of writes — and those writes are spent quota that can't be re-earned. A
// Railway redeploy (SIGTERM) and the eval harness (process.exit on its error
// path) both hit this, and the eval harness is the biggest spender of all.
// flushSearchCache is fully synchronous, so it is safe in an exit handler.
//
// Only SIGINT is handled here, and it exits at once: dev ctrl-C must stay
// instant. SIGTERM is NOT — it is handled in index.ts, which drains the open
// SSE streams first (a redeploy used to cut in-flight curator runs that were
// already charged to the visitor's cap) and then calls process.exit, which
// runs the "exit" handler below, so the cache is still flushed on that path.
// Scripts that import this module without index.ts (evals/, scripts/) get
// Node's default SIGTERM: immediate exit, no exit handlers — the eval
// harness already flushes on its own error path, and nobody SIGTERMs a
// one-shot script mid-run on purpose.
let flushedOnExit = false;
function flushOnce() {
  if (flushedOnExit) return;
  flushedOnExit = true;
  if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
  flushSearchCache();
}
process.on("exit", flushOnce);
process.on("SIGINT", () => {
  flushOnce();
  process.exit(130);
});

// True when this query can be answered without spending quota. Both spenders
// check it first — the curator's agent loop (curator.ts, `free`) and resolveTrack
// below — so a cache hit never claims from the one request-scoped allowance they
// now share (searchBudget.ts).
function isSearchCached(q: string): boolean {
  return isFresh(loadSearchCache().get(cacheKey(q)));
}

// Every Spotify search in the app goes through here.
// limit=10 always: quota counts REQUESTS, not items, so asking for fewer buys
// nothing and costs candidates. (10 is also the dev-mode max since Feb 2026.)
async function searchTracks(q: string): Promise<any[]> {
  const cache = loadSearchCache();
  const key = cacheKey(q);
  const hit = cache.get(key);
  if (isFresh(hit)) return hit!.items;

  const params = new URLSearchParams({ q, type: "track", limit: "10" });
  const data = await spotifyFetch(`/search?${params}`, {}, {}, catalogUser());
  const items = (data?.tracks?.items || []).map(trimItem);

  rememberQuery(q, items);
  scheduleCacheWrite();
  return items;
}

// File one search's results under its query, into both layers. Split out of
// searchTracks so a test can prime the query cache without a real request —
// resolution's "a cached query is free" rule is otherwise untestable offline.
function rememberQuery(q: string, items: any[]) {
  const cache = loadSearchCache();
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // oldest-first eviction — one pass, no LRU bookkeeping needed at this size
    const oldest = [...cache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, Math.ceil(CACHE_MAX_ENTRIES / 10));
    for (const [k] of oldest) cache.delete(k);
  }
  cache.set(cacheKey(q), { items, at: Date.now() });
  rememberItems(items);
}

// Track records already seen under this title, from any earlier search.
function recallByTitle(title: unknown): any[] {
  loadSearchCache();
  return byTitle.get(titleKey(title)) || [];
}

function recallByRef(ref: unknown): any | null {
  if (!ref || typeof ref !== "string") return null;
  loadSearchCache();
  return byRef.get(ref) || null;
}

// A memory-only match needs a HIGHER bar than a live search.
//
// MATCH_THRESHOLD is calibrated for Spotify's own relevance ranking, where the
// candidates are the ones Spotify chose for this query. The title index has no
// such ranking — its candidates are whatever any earlier search happened to
// surface. A grazing 0.56 from memory would permanently block a live search
// that would have scored 0.95. Genuine memory hits (the model copied Spotify's
// exact spelling, which is what it is instructed to do) score ~1.0, so this
// costs essentially nothing and closes the grazing case.
const MEMORY_ACCEPT_THRESHOLD = 0.8;

// Verify a `ref` the model quoted against what it actually committed.
//
// This is the hallucination gate's strongest form: `resolved` stops meaning "a
// fuzzy score cleared a threshold" and starts meaning "the model pointed at a
// record the server itself fetched from Spotify". A model that invents a track
// cannot invent a ref that is in this index.
//
// The one new failure mode is transcription — the model quoting the ref of a
// DIFFERENT row than the track it wrote down. So the committed artist/title is
// still scored against the ref'd record, and a mismatch is rejected rather than
// trusted. Returns null when there is no usable ref, which sends the caller
// down the normal search path.
function verifyRef(
  ref: unknown,
  track: { artist: string; title: string }
): { item: any; score: number } | null {
  const item = recallByRef(ref);
  if (!item) return null;
  const { best } = rank([item], track, "ref");
  if (!best || best.score < MATCH_THRESHOLD) {
    console.warn(
      `[resolve] ref ${ref} does not match committed "${track.artist} — ${track.title}"` +
        ` (got "${item.name}", ${best ? best.score.toFixed(2) : "below artist floor"}) — ignoring it`
    );
    return null;
  }
  return { item: best.item, score: best.score };
}

// ── candidate scoring ────────────────────────────────────────

interface Candidate {
  item: any;
  score: number;
  strategy: string;
}

// Score a batch of search results against a curated track. Pure — the caller
// merges. `best` respects ARTIST_FLOOR; `bestAny` ignores it and exists only so
// a failure can be logged honestly ("best 0.42") instead of as "no results".
function rank(
  items: any[],
  track: { artist: string; title: string },
  strategy: string
): { best: Candidate | null; bestAny: Candidate | null } {
  let best: Candidate | null = null;
  let bestAny: Candidate | null = null;
  for (const item of items) {
    const titleScore = similarity(item.name, track.title);
    const aScore = artistScore(item.artists, track.artist);
    const score = 0.6 * titleScore + 0.4 * aScore;
    if (!bestAny || score > bestAny.score) bestAny = { item, score, strategy };
    if (aScore >= ARTIST_FLOOR && (!best || score > best.score)) {
      best = { item, score, strategy };
    }
  }
  return { best, bestAny };
}

function better(a: Candidate | null, b: Candidate | null): Candidate | null {
  if (!a) return b;
  if (!b) return a;
  return b.score > a.score ? b : a;
}

// The fields resolution adds to a curated track.
interface ResolvedFields {
  resolved: boolean;
  spotifyUrl?: string | null;
  spotifyUri?: string;
  albumArt?: string | null;
  matchedName?: string;
}

// Resolve one curated track against Spotify search (multi-strategy).
// Dev-mode search cap is limit=10 — use all of it.
// budget (optional): the request's shared search allowance — see the seam in
// step 3 and the reasoning in searchBudget.ts.
async function resolveTrack<T extends { artist: string; title: string; ref?: string }>(
  track: T,
  budget?: SearchBudget
): Promise<T & ResolvedFields> {
  const label = `"${track.artist} — ${track.title}"`;
  let best: Candidate | null = null; // best candidate meeting the artist floor
  let bestAny: Candidate | null = null; // best overall, for honest fail logging

  // 1. The ref the model quoted from a search result it saw. Costs no request
  //    and is a stronger guarantee than any score — see verifyRef.
  const byQuotedRef = verifyRef(track.ref, track);
  if (byQuotedRef) {
    best = { item: byQuotedRef.item, score: byQuotedRef.score, strategy: "ref" };
  }

  // 2. Failing that, records already seen under this title. The curator
  //    searched this track before committing it, so the matching record is
  //    often in hand even without a usable ref. This skips the REQUEST, not the
  //    gate — same scoring, same ARTIST_FLOOR, and a STRICTER accept bar.
  if (!best) {
    const r = rank(recallByTitle(track.title), track, "memory");
    if (r.best && r.best.score >= MEMORY_ACCEPT_THRESHOLD) best = r.best;
    bestAny = better(bestAny, r.bestAny);
  }

  // 3. Otherwise pay for a real search.
  if (!best || best.score < MATCH_THRESHOLD) {
    for (const { strategy, q } of buildQueries(track)) {
      // The request's search allowance is shared with the curator's agent loop,
      // and resolution runs after it — so this is the half that yields when the
      // allowance runs out. Two rules, both load-bearing:
      //   - a query the cache can answer costs no quota, so it never spends;
      //     the agent loop applies the same rule (curator.ts, `free`).
      //   - out of budget means stop issuing searches, not throw: the track
      //     comes back resolved:false, which the card already renders and the
      //     product already reads as "we could not find it", rather than
      //     failing the whole mixtape.
      // No budget passed = unbounded, exactly as before, which is what the
      // evals harness and any other four-argument caller get.
      if (!isSearchCached(q) && budget && !budget.spend()) {
        console.log(
          `[resolve] search budget exhausted — leaving ${label} unresolved (at ${strategy})`
        );
        break;
      }
      let items: any[] = [];
      try {
        items = await searchTracks(q);
      } catch (err: any) {
        // 401 = login problem, 429 = rate limit or exhausted quota — all must
        // surface as errors, never as "unresolved" (which the product reads as
        // a hallucination).
        if (err.status === 401 || err.status === 429) throw err;
        console.warn(`[resolve] search error (${strategy}) for ${label}: ${err.message}`);
        continue;
      }

      const r = rank(items, track, strategy);
      best = better(best, r.best);
      bestAny = better(bestAny, r.bestAny);
      if (best && best.score >= MATCH_THRESHOLD) break; // confident — stop here
    }
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
  const matchedName = `${(item.artists || []).map((a: any) => a.name).join(", ")} — ${item.name}`;
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

// Compact catalog search backing the curator's search_spotify tool — just
// enough for the model to confirm a track exists and how Spotify spells it.
// Every row the request paid for goes to the model — showing 5 of 10 halved the
// pool it could pick from for no saving at all, since the request cost is the
// same either way. More rows per search is the cheapest way to need fewer
// searches.
//
// `ref` is the point of this shape: the model quotes it back on the track it
// commits, and resolution becomes a lookup instead of a second search.
// One cached record → one model-visible row. Pure, exported for tests.
// Adding a key to this tool_result JSON touches no tool schema, so the
// compiled-grammar cache is unaffected.
//
// artist / title / album are third-party strings: uploaders write them, not us,
// and this function is the choke point where they become model-visible text
// inside a tool_result. A row carrying a paragraph of "ignore your previous
// instructions" is an injection vector with no upper bound on length, so the
// three free-text fields are clipped here. 200 characters each cannot
// plausibly cut a real release — the longest legitimate titles and featured-
// artist lists run well under that — while a clipped field is far too short to
// carry an instruction. `ref`, `year`, `length` and `position` are server-
// derived or format-constrained and are left exactly as they are.
const MAX_CATALOG_FIELD_CHARS = 200;

// Non-strings pass through untouched: the "omit, never null" rule below depends
// on absent fields staying absent, and an empty string is not the same as no
// key. The ellipsis is visible on purpose — without it the model reads a
// truncated title as the complete one and writes it into a note.
function clipField(value: any): any {
  if (typeof value !== "string" || value.length <= MAX_CATALOG_FIELD_CHARS) {
    return value;
  }
  return value.slice(0, MAX_CATALOG_FIELD_CHARS - 1) + "…";
}

function catalogRow(item: any): {
  ref: string;
  artist: string;
  title: string;
  album: string;
  year: string;
  length?: string;
  position?: string;
} {
  const trackNo = item.track_number;
  const totalTracks = item.album?.total_tracks;
  return {
    ref: refOf(item),
    artist: clipField((item.artists || []).map((a: any) => a.name).join(", ")),
    title: clipField(item.name),
    album: clipField(item.album?.name || ""),
    year: String(item.album?.release_date || "").slice(0, 4),
    // Omit — never null — on cache rows that predate the field expansion: a
    // literal "length": null is a value the model could parrot into a note.
    // Same rule for position below.
    ...(typeof item.duration_ms === "number"
      ? { length: formatClock(item.duration_ms) }
      : {}),
    ...(Number.isInteger(trackNo) && trackNo > 0 &&
    Number.isInteger(totalTracks) && totalTracks > 0
      ? { position: `${trackNo} of ${totalTracks}` }
      : {}),
  };
}

async function searchCatalog(query: string): Promise<ReturnType<typeof catalogRow>[]> {
  const items = await searchTracks(query);
  return items.map(catalogRow);
}

// Resolve all tracks with a small concurrency pool (respects rate limits).
// onProgress(event, payload) fires per track: "resolving", then "resolved".
// signal (optional): an aborted signal stops the pool between tracks — the
// caller checks it and discards the partial results.
// budget (optional): the request's remaining search allowance, shared with the
// curator loop that ran before this. Omitted = unbounded, the old behaviour.
async function resolveTracks<T extends { artist: string; title: string }>(
  tracks: T[],
  concurrency = 3,
  onProgress?: (event: string, payload: any) => void,
  signal?: AbortSignal,
  budget?: SearchBudget
): Promise<(T & ResolvedFields)[]> {
  const results: (T & ResolvedFields)[] = new Array(tracks.length);
  let next = 0;
  let failed = false; // one worker throwing must stop the others, not orphan them
  async function worker() {
    while (!failed && !signal?.aborted && next < tracks.length) {
      const i = next++;
      if (onProgress) {
        onProgress("resolving", {
          index: i,
          artist: tracks[i]!.artist,
          title: tracks[i]!.title,
        });
      }
      try {
        results[i] = await resolveTrack(tracks[i]!, budget);
      } catch (err) {
        failed = true;
        throw err;
      }
      if (onProgress) {
        onProgress("resolved", {
          index: i,
          artist: tracks[i]!.artist,
          title: tracks[i]!.title,
          resolved: Boolean(results[i]!.resolved),
          matched: results[i]!.matchedName || null,
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tracks.length) }, worker)
  );
  return results;
}

// ── playlist reading (the "in the spirit of" seed picker) ────

// How many seed tracks reach the curator prompt: enough signal to read a
// playlist's spirit without paying for a 500-track context.
const SEED_TRACK_CAP = 80;
// Pages fetched before sampling — 4 requests, 200 tracks.
const SEED_FETCH_MAX = 200;

// Evenly-spaced sample preserving order — a playlist's arc is part of its
// spirit, so never sample from just the top.
function sampleTracks<T>(tracks: T[], cap: number = SEED_TRACK_CAP): T[] {
  if (tracks.length <= cap) return tracks;
  const step = tracks.length / cap;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) out.push(tracks[Math.floor(i * step)]!);
  return out;
}

// List the caller's playlists for the picker. Paginated at 50 (the API max);
// capped at 4 pages — a picker doesn't need more than 200 entries.
async function listPlaylists(user: string = OWNER) {
  const playlists: {
    id: string;
    name: string;
    total: number | null;
    owner: string | null;
    mine: boolean;
  }[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const params = new URLSearchParams({ limit: "50", offset: String(offset) });
    const data = await spotifyFetch(`/me/playlists?${params}`, {}, {}, user);
    const items = data?.items || [];
    for (const p of items) {
      if (!p?.id) continue;
      // Mixtapes the caller's own account hosts are not a seed library —
      // without this the owner-as-host picker fills with them. Compared by
      // Spotify id, not store key: the same account can be "owner" here and
      // its Spotify id in the cookie.
      if (
        p.owner?.id === user &&
        String(p.description || "").startsWith("Made with Mixtape")
      ) {
        continue;
      }
      playlists.push({
        id: p.id,
        name: p.name || "(untitled)",
        // Feb 2026 renamed playlist "tracks" to "items" — accept either shape
        total: p.items?.total ?? p.tracks?.total ?? null,
        owner: p.owner?.display_name || null,
        // followed playlists can 403 on item reads for dev-mode apps
        // (Spotify-made ones always do) — the client sorts and labels by this
        mine: p.owner?.id === user,
      });
    }
    if (!data?.next || items.length === 0) break;
  }
  return playlists;
}

// A playlist's name and size, for a pasted link the picker never saw.
async function getPlaylistMeta(playlistId: string, user: string = OWNER) {
  try {
    const p = await spotifyFetch(
      `/playlists/${encodeURIComponent(playlistId)}`,
      {},
      {},
      user
    );
    return {
      name: String(p?.name || "").trim() || null,
      total: p?.items?.total ?? p?.tracks?.total ?? null,
    };
  } catch (err: any) {
    if (err?.status === 403 || err?.status === 404) {
      err.message =
        "Spotify doesn't let this app read that playlist — Spotify-made " +
        "and private playlists are off-limits. Paste a link to a public " +
        "playlist someone made.";
    }
    throw err;
  }
}

// Fetch a playlist's tracks (artist/title only) to seed the curator.
// No `fields` trim: the Feb 2026 renames make exact field paths risky, and a
// wrong fields path silently returns nothing instead of erroring.
// The caller's token, not the owner's — the seed is often one of THEIR
// private playlists.
async function getSeedTracks(playlistId: string, user: string = OWNER) {
  const tracks: { artist: string; title: string }[] = [];
  let total: number | null = null;
  for (let offset = 0; offset < SEED_FETCH_MAX; offset += 50) {
    const params = new URLSearchParams({ limit: "50", offset: String(offset) });
    let data;
    try {
      data = await spotifyFetch(
        `/playlists/${encodeURIComponent(playlistId)}/items?${params}`,
        {},
        {},
        user
      );
    } catch (err: any) {
      // Dev-mode apps can't read Spotify-made playlists (and some followed
      // ones) — measured live 2026-08-23. Without this, the user sees a raw
      // "Spotify API 403 … Forbidden" with no way to know what to do.
      if (err?.status === 403) {
        err.message =
          "Spotify doesn't let this app read that playlist — Spotify-made " +
          "and some followed playlists are off-limits. Pick one you made.";
      }
      throw err;
    }
    total = data?.total ?? total;
    const items = data?.items || [];
    for (const entry of items) {
      // Feb 2026 renamed the wrapper key too (/tracks → /items) — accept both
      const t = entry?.item || entry?.track;
      // skip podcast episodes and local files — no artists to curate from
      if (!t?.name || !Array.isArray(t.artists) || t.artists.length === 0) continue;
      tracks.push({
        artist: t.artists.map((a: any) => a?.name).filter(Boolean).join(", "),
        title: t.name,
      });
    }
    if (!data?.next || items.length === 0) break;
  }
  return { tracks: sampleTracks(tracks), total: total ?? tracks.length };
}

// ── playlist creation ────────────────────────────────────────

// onProgress(event, payload) fires on the two real steps:
// "creating" (playlist create request) and "adding" (adding N tracks).
async function createPlaylist(
  {
    name,
    description,
    uris,
    isPublic = false,
  }: { name: string; description: string; uris: string[]; isPublic?: boolean },
  onProgress?: (event: string, data?: any) => void,
  // the playlist lands in THIS account's library
  user: string = OWNER
): Promise<{ id: string; url: string | null }> {
  // POST /v1/me/playlists — NOT /users/{id}/playlists (removed Feb 2026)
  if (onProgress) onProgress("creating", { name });
  // public: a private playlist can't be opened by ANYONE, link or not
  // (Spotify has no "unlisted") — so a playlist meant to be handed to a
  // visitor must be public, and must never be made private again later:
  // that revokes it from every library it was saved to.
  const playlist = await spotifyFetch(
    "/me/playlists",
    {
      method: "POST",
      body: JSON.stringify({ name, description, public: isPublic }),
    },
    {},
    user
  );
  if (uris.length) {
    // POST /v1/playlists/{id}/items (renamed from /tracks); body key is "uris"
    if (onProgress) onProgress("adding", { count: uris.length });
    try {
      await spotifyFetch(
        `/playlists/${playlist.id}/items`,
        {
          method: "POST",
          body: JSON.stringify({ uris }),
        },
        {},
        user
      );
    } catch (err) {
      // Best-effort orphan cleanup — otherwise every retry after a failed add
      // leaves another empty playlist. There is no delete endpoint; unfollowing
      // your own playlist removes it. A failed cleanup must not mask the
      // original error.
      try {
        await spotifyFetch(
          `/playlists/${playlist.id}/followers`,
          { method: "DELETE" },
          {},
          user
        );
      } catch (cleanupErr: any) {
        console.warn(
          `[playlist] cleanup of orphaned ${playlist.id} failed: ${cleanupErr.message}`
        );
      }
      throw err;
    }
  }
  return { id: String(playlist.id), url: playlist.external_urls?.spotify || null };
}

// Save a (host-owned) playlist into THIS user's library — the 0-tap save
// for the allowlisted few. PUT /v1/playlists/{id}/followers.
async function followPlaylist(playlistId: string, user: string): Promise<void> {
  await spotifyFetch(
    `/playlists/${encodeURIComponent(playlistId)}/followers`,
    { method: "PUT", body: JSON.stringify({ public: true }) },
    {},
    user
  );
}

export {
  credentialsConfigured,
  isLoggedIn,
  getDisplayName,
  getOwnerId,
  parseTokenStore, // pure, exported for tests
  makeState,
  authorizeUrl,
  exchangeCode,
  resolveTracks,
  searchCatalog,
  isSearchCached,
  createPlaylist,
  followPlaylist,
  hostUser,
  parsePlaylistRef, // pure, exported for tests
  sanitizePlaylistName, // pure, exported for tests
  listPlaylists,
  getPlaylistMeta,
  getSeedTracks,
  SEED_TRACK_CAP,
  sampleTracks, // pure, exported for tests
  // pure matching internals, exported for tests only
  normalize,
  similarity,
  artistScore,
  buildQueries,
  rank,
  better,
  trimItem,
  stripSuffixes,
  formatDuration,
  formatClock,
  catalogRow,
  clipField,
  MAX_CATALOG_FIELD_CHARS,
  classify429,
  rememberItems,
  rememberQuery, // files results under a query; searchTracks real ones, tests fake ones
  evictOldest,
  CACHE_MAX_ENTRIES,
  RECORD_MAX_ENTRIES,
  recallByTitle,
  recallByRef,
  verifyRef,
  refOf,
  isFresh,
  NEGATIVE_TTL_MS,
  CACHE_TTL_MS,
  MAX_RETRY_WAIT,
  DEFAULT_QUOTA_COOLDOWN,
  MEMORY_ACCEPT_THRESHOLD,
  ARTIST_FLOOR,
  MATCH_THRESHOLD,
};
