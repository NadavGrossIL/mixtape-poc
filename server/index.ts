// Mixtape POC server — Express on 8888.
// Spotify OAuth (authorization code flow) + Claude curator + track resolution.

import "./env.ts";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import * as spotify from "./spotify.ts";
import * as curator from "./curator.ts";
import * as logbook from "./logbook.ts";
import * as usage from "./usage.ts";
import { makeMetrics } from "./metrics.ts";
import { healthBody, publicHealthBody } from "./health.ts";
import { signUser, verifyUser, newAnonId, isAnon, SESSION_MAX_AGE_MS } from "./session.ts";
import { makeCaps, today } from "./caps.ts";
import { makePressCaps } from "./pressCaps.ts";
import { makeSearchBudget } from "./searchBudget.ts";
import { originAllowed, allowedOriginsFromUrls, isRemoteUrl } from "./httpOrigin.ts";
import { parseTrackUris } from "./trackUris.ts";
import { makeGateThrottle } from "./gateThrottle.ts";

// Tee console.* into the in-app logbook before anything logs, so even the
// startup config warnings below are readable from the browser.
logbook.patchConsole();

// PORT is injected by the host in production (Railway/Render); HOST must be
// 0.0.0.0 there so the platform router can reach the container. The loopback
// default keeps local dev LAN-invisible.
const PORT = Number(process.env.PORT) || 8888;
const HOST = process.env.HOST || "127.0.0.1";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
// "Is this process reachable from off the machine?" — the one bit that decides
// how the owner gate fails (below) and what the startup warnings are about.
//
// It used to be `HOST !== "127.0.0.1"` alone, which is right for Railway and
// wrong for the other real deployment: nginx or Caddy on a box, proxying to an
// app bound to loopback. That host is on the internet, the bind says otherwise,
// and /api/logs would have served every visitor's prompts to anyone with the
// URL. So the bind is now one signal among several, and any of them is enough:
// an explicit DEPLOYED=1, a non-loopback bind, an APP_SECRET (nobody sets a
// shared entry key for a server only they can reach), or a CLIENT_URL that
// names somewhere other than this machine. Every one of them is absent in
// `npm run dev` with no .env, so local dev stays permissive.
const DEPLOYED =
  process.env.DEPLOYED === "1" ||
  HOST !== "127.0.0.1" ||
  Boolean(process.env.APP_SECRET) ||
  isRemoteUrl(CLIENT_URL);

// The funnel counters. DATA_DIR is the host's volume when there is one, else
// beside the code — see metrics.ts for what that costs. Built here rather
// than imported as a singleton so a test can point one at a temp dir; the
// price is that the process owning the counters also owns their last flush,
// so the clean-exit write is registered here and nowhere else.
const metrics = makeMetrics({ dir: process.env.DATA_DIR || import.meta.dirname });
process.on("exit", metrics.flush);

const app = express();
// req.secure must reflect the platform's TLS terminator, not the internal hop
app.set("trust proxy", 1);

// 32kb, not body-parser's 100kb default. Nothing this app accepts is large —
// the biggest legitimate body is an 8-track card being refined — and the cost
// of a big one is not the parse, it is downstream: the curator's message array
// only grows, so an oversized card is re-sent as input on every turn of the
// agent loop. A 100kb card is roughly 200k input tokens for one request, paid
// for by us, from an unauthenticated caller. The per-field caps on the routes
// below are the same argument at finer grain.
app.use(express.json({ limit: "32kb" }));

// A body over the limit makes body-parser throw, and an unhandled parser error
// is a 500 with a stack trace. Registered right after the parser so it catches
// the parser's errors and nothing else's.
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === "entity.too.large") {
    return res.status(400).json({ error: "That request is too large." });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON body." });
  }
  next(err);
});

// Security headers by hand rather than helmet: this server has three
// dependencies, and keeping it that way is worth more than the convenience of
// a fourth for what amounts to five setHeader calls we can read.
//
// The CSP is written against what the built client actually loads — grep
// before narrowing any of these:
//   script-src 'self'   — Vite emits external module scripts, no inline ones.
//   style-src …unsafe-inline — client/index.html has an inline <style> for the
//     pre-paint colour, React inlines element styles, and the gate page below
//     is all style attributes. Google Fonts serves the stylesheet itself.
//   img-src data: + *.scdn.co — album art comes from Spotify's CDN at runtime;
//     some inline SVG is data:.
//   frame-src open.spotify.com — the playlist embed on the pressed card.
// In dev none of this reaches the page: Vite serves the client on :5173 and
// only proxies the API here, so these headers ride the JSON and SSE responses.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.scdn.co",
  "connect-src 'self'",
  "frame-src https://open.spotify.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // frame-ancestors already says this to modern browsers; the header is for
  // the ones that don't read CSP, and it costs nothing.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Only over TLS. Sent on plain HTTP it is ignored by the spec, but pinning
  // a developer's browser to https://127.0.0.1:8888 if anything ever honoured
  // it is a bad afternoon for no gain.
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// ── cross-site guard ─────────────────────────────────────────

// Applied to the state-changing POSTs: the two paid streams, the playlist
// write and the view beacon. Without it, a plain <form> on someone else's page
// could drive all four — no preflight, no CORS check, and SameSite=Lax buys
// nothing because none of them need an existing session (callerIdentity mints
// a guest cookie for whoever asks). The rule and its trade-offs live in
// httpOrigin.ts; this is the wiring and the 403.
//
// CLIENT_URL is here because the Vite dev server is a genuinely different
// origin from this one. Deployed, it names this same host and adds nothing.
const EXTRA_ALLOWED_ORIGINS = allowedOriginsFromUrls([CLIENT_URL]);

function sameOriginOnly(req: Request, res: Response, next: NextFunction) {
  const ok = originAllowed({
    origin: req.headers.origin,
    secFetchSite: req.headers["sec-fetch-site"] as string | undefined,
    host: req.headers.host,
    // req.protocol honours X-Forwarded-Proto because `trust proxy` is on
    proto: req.protocol,
    extraAllowed: EXTRA_ALLOWED_ORIGINS,
  });
  if (ok) return next();
  console.warn(
    `[origin] refused ${req.method} ${req.path} from ${JSON.stringify(String(req.headers.origin))}`
  );
  res.status(403).json({ error: "Cross-site request refused." });
}

// ── startup credential check (warn, never crash) ─────────────

if (!spotify.credentialsConfigured()) {
  console.warn(
    "\n[config] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are missing or still " +
      "placeholders.\n[config] Copy server/.env.example to server/.env and fill in " +
      "your Spotify app credentials.\n[config] The server will run, but Spotify " +
      "login and search will fail until then.\n"
  );
}
if (!spotify.isLoggedIn("host") && spotify.isLoggedIn()) {
  console.warn(
    "[config] SPOTIFY_HOST_REFRESH_TOKEN is unset — mixtapes will be pressed " +
      "into the OWNER's Spotify account (public). Set up the Mixtape host " +
      "account before sharing widely; see README → Sharing."
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
// Locally the loopback bind is the protection; deployed, the daily caps are
// (caps.ts). APP_SECRET is optional on top: set, it turns on a cookie gate
// so only people who were given the shared key get in (invite-only mode).
// WHO they are is a separate question, answered by the session cookie below.
// The gate cookie carries a hash of the secret, never the secret itself.
const APP_SECRET = process.env.APP_SECRET || "";
const GATE_COOKIE = "mixtape_gate";
const GATE_TOKEN = APP_SECRET
  ? crypto.createHash("sha256").update(APP_SECRET).digest("hex")
  : null;

// Compare two secrets in constant time. The comparison runs over SHA-256
// digests rather than the raw strings because the raw version returned early
// on a length mismatch, and a guesser who can time that learns the exact byte
// length of APP_SECRET before guessing a single character. Digests are always
// 32 bytes, so every call does the same work. Behaviour is otherwise identical
// (the gate cookie is checked with this too).
function timingSafeMatch(a: unknown, b: unknown): boolean {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
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

function setGateCookie(req: Request, res: Response) {
  res.setHeader(
    "Set-Cookie",
    `${GATE_COOKIE}=${GATE_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` +
      (req.secure ? "; Secure" : "")
  );
}

// One shared secret, checked before anything else — including the daily caps,
// which only start counting once the gate has opened. So the gate is the one
// surface where guessing is free, and this makes it cost something: three free
// tries per IP, then a doubling wait. Both spellings of the gate go through it
// (the form POST and the `?key=` invite link), or the throttle is a sign on the
// front door of a house with two. The numbers and the reasoning: gateThrottle.ts.
const gateThrottle = makeGateThrottle({
  maxAttempts: 3,
  windowMs: 10 * 60 * 1000,
  baseDelayMs: 1_000,
});

function refuseThrottled(req: Request, res: Response, retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader("Retry-After", String(seconds));
  const line = `Too many attempts — wait ${seconds}s and try again.`;
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
    return res.status(429).json({ error: line });
  }
  res.status(429).type("text/plain").send(line);
}

if (APP_SECRET) {
  // urlencoded is mounted HERE and nowhere else. Globally, it turned every
  // other POST into something a cross-origin HTML form could reach with a
  // parsed body; this is the only route that has ever wanted a form.
  app.post("/gate", express.urlencoded({ extended: false }), (req, res) => {
    const ip = String(req.ip);
    const now = Date.now();
    const verdict = gateThrottle.check(ip, now);
    if (!verdict.allowed) return refuseThrottled(req, res, verdict.retryAfterMs);
    if (!timingSafeMatch(req.body?.secret || "", APP_SECRET)) {
      gateThrottle.fail(ip, now);
      return res.status(401).type("html").send(GATE_PAGE);
    }
    gateThrottle.succeed(ip, now);
    setGateCookie(req, res);
    res.redirect("/");
  });
  app.use((req, res, next) => {
    // /callback is exempt: Spotify lands there mid-OAuth, and the state
    // check (issued only to a gated /auth/login) already gates it.
    // /healthz is exempt in both spellings: a monitor configured with a
    // trailing slash is the same monitor, and an exact-match exemption would
    // hand it the password form and a green 401-free check forever.
    const healthPing = req.path === "/healthz" || req.path === "/healthz/";
    if (req.path === "/callback" || healthPing || hasGateCookie(req)) return next();
    // The invite link carries the key (`/?key=…`): one tap sets the cookie
    // and lands on the app, so a visitor never meets the password form.
    // Redirect to strip the key from the address bar and history.
    if (req.method === "GET" && typeof req.query.key === "string") {
      const ip = String(req.ip);
      const now = Date.now();
      const verdict = gateThrottle.check(ip, now);
      if (!verdict.allowed) return refuseThrottled(req, res, verdict.retryAfterMs);
      if (timingSafeMatch(req.query.key, APP_SECRET)) {
        gateThrottle.succeed(ip, now);
        setGateCookie(req, res);
        // Collapse the leading slashes first: `GET //evil.example/x` has
        // req.path === "//evil.example/x", and a Location of "//host/x" is a
        // protocol-relative URL — the browser leaves the site. Whoever has the
        // key can send that link to anyone, and the key is the thing we hand
        // out widely.
        return res.redirect(req.path.replace(/^\/+/, "/"));
      }
      gateThrottle.fail(ip, now);
    }
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
// SESSION_SECRET is the signing key, and it exists so this key is nobody
// else's key. The chain below it is a fallback for deployments that predate
// the variable, not a design: APP_SECRET is a shared door code, and in public
// mode (no APP_SECRET — how this is actually deployed) the chain reached
// SPOTIFY_CLIENT_SECRET, which collapsed two trust domains into one value.
// Rotating the Spotify credential then silently logged every user out, and a
// leak of either one forged identities signed by the other. Set SESSION_SECRET
// and that stops being true. Local dev with none of them set still falls
// through to a per-boot random key — which only means re-login after a
// restart, harmless on loopback.
const SESSION_KEY =
  process.env.SESSION_SECRET ||
  APP_SECRET ||
  process.env.SPOTIFY_CLIENT_SECRET ||
  crypto.randomBytes(32).toString("hex");

function callerUser(req: Request): string | null {
  return verifyUser(readCookie(req, SESSION_COOKIE), SESSION_KEY);
}

// Max-Age tracks the signed window rather than being picked separately: the
// cookie now carries an issued-at that the server stops honouring after
// SESSION_MAX_AGE_MS (session.ts), and a browser holding a cookie past that
// point reads to the user as a random logout. One number, one place.
function setSessionCookie(req: Request, res: Response, userId: string) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${signUser(userId, SESSION_KEY)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}` +
      (req.secure ? "; Secure" : "")
  );
}

// Who is asking — a connected Spotify account, or a guest. Guests get a
// signed anonymous id minted on first use (the cookie is set here, so call
// this BEFORE any streaming headers go out). A stale Spotify identity whose
// token is gone (redeploy wiped the store) is treated as a guest rather
// than bounced: the mixtape flow no longer needs their token.
function callerIdentity(req: Request, res: Response): string {
  const user = callerUser(req);
  if (user && (isAnon(user) || spotify.isLoggedIn(user))) return user;
  const anon = newAnonId();
  setSessionCookie(req, res, anon);
  return anon;
}

// The Spotify identity to read the caller's playlists with: their own
// token when they have one (private playlists work), else the host's.
function readerFor(user: string): string {
  return isAnon(user) ? spotify.hostUser() : user;
}

function whoLabel(user: string): string {
  return isAnon(user) ? `guest ${user.slice(5, 11)}` : spotify.getDisplayName(user) || user;
}

// The caller's Spotify user id, or null AFTER sending the 401 — so routes
// can bail with a plain `if (!user) return`.
function requireSpotifyUser(req: Request, res: Response): string | null {
  const user = callerUser(req);
  if (user && spotify.isLoggedIn(user)) return user;
  res.status(401).json({ error: "Not logged in to Spotify." });
  return null;
}

// ── page views ───────────────────────────────────────────────

// The client pings this once per load. Counting in the SPA catch-all
// instead would count crawlers, link-preview fetchers and prefetches as
// people; a beacon from a browser that actually ran the app is the honest
// number. No body and nothing per-person is recorded — just the tick, and
// whether this browser had been here before.
// The owner reloading their own page is not an audience. At the counts this
// app will see once a link goes out, a dozen self-reloads are the difference
// between "people came" and "I came" — so the one number that matters gets to
// stay honest. Resolving the owner is a cached /me after the first call, and
// any failure to resolve it counts the view: over-counting the owner is a
// rounding error, silently dropping real visitors is a broken funnel.
async function isOwnerVisit(user: string | null): Promise<boolean> {
  if (!user || isAnon(user)) return false;
  try {
    const ownerId = await spotify.getOwnerId();
    return ownerId !== null && user === ownerId;
  } catch {
    return false;
  }
}

app.post("/api/view", sameOriginOnly, async (req, res) => {
  const user = callerUser(req);
  const returning = user !== null;
  // Mint a guest cookie at first paint, but NEVER overwrite an identity that
  // is already signed. callerIdentity() would: it demotes a Spotify id whose
  // token is missing from the store to a fresh guest, and the store is on the
  // container disk, so every redeploy wipes it. Since this beacon fires on
  // every page load, using it here logged the owner out of their own logs and
  // funnel on the first load after any deploy — while requireOwner would have
  // accepted the stale cookie, because it checks the id against the
  // env-bootstrapped owner token, which does survive. Demotion still happens
  // where it was meant to: the paid routes, which need a real caps identity.
  if (!returning) setSessionCookie(req, res, newAnonId());
  if (!(await isOwnerVisit(user))) {
    metrics.count("views");
    if (!returning) metrics.count("newVisitors");
  }
  res.status(204).end();
});

// ── health ───────────────────────────────────────────────────

// For an external uptime monitor. Unauthenticated on purpose (a pinger has no
// cookie) and deliberately boring: booleans about the deployment's own
// configuration, never a prompt, an id or a name.
//
// 200/503 is the whole signal, so a free pinger's default "is it 200?" check
// is enough — no keyword rules to configure. What makes it 503 is only what a
// human has to fix: a missing credential or a missing owner token. Spotify's
// daily quota is NOT in here; it is a wait-until-tomorrow condition that
// clears itself, and paging someone at 3am for it would train them to ignore
// the page that matters. It shows up in the log panel instead.
// Which checks fail it and which are only reported lives in health.ts, with
// its test; this route is the four readings, the status code, and who is
// allowed to see the rest.
//
// The BODY, though, is owner-only. "Deliberately boring" was true of any one
// reading and false of the set: `checks` tells a stranger which of our
// credentials are configured, and `uptime` tells them when we last restarted —
// which is when the in-memory daily caps went back to zero. The monitor never
// read either; it reads the status code, and that is unchanged for everyone.
// Anonymous callers get `{ok}` (publicHealthBody, tested in health.ts).
// Owner-ness is asked WITHOUT requireOwner: that helper sends a 401 when it
// fails, and a monitor must get its 200/503 rather than an auth error.
app.get("/healthz", async (req, res) => {
  const body = healthBody(
    {
      spotifyCredentials: spotify.credentialsConfigured(),
      anthropicKey: curator.anthropicConfigured(),
      // The owner token powers catalog search AND the owner gate, so on a
      // deployed host its absence is an outage, not a local-dev convenience.
      ownerToken: !DEPLOYED || spotify.isLoggedIn(),
      // Ask about the HOST account itself, the way the startup warning does.
      // `hostUser()` falls back to the owner when the host token is unset, so
      // `isLoggedIn(hostUser())` would answer "yes" on exactly the deploy
      // this check exists to notice.
      hostAccount: spotify.isLoggedIn("host"),
    },
    process.uptime()
  );
  const full = await isOwner(req);
  res.status(body.ok ? 200 : 503).json(full ? body : publicHealthBody(body));
});

// ── owner-only routes ────────────────────────────────────────

// The gate lets every friend in; logs and usage must not — they show other
// people's prompts and activity. The owner is whoever's Spotify id matches
// the owner token's /me (resolved once, no config). A server with NO owner
// token configured (fresh local clone) has no users to leak, so it keeps
// the old gate-only behavior there.
//
// Two entry points, because /healthz needs the answer without a 401 being sent
// on its behalf: `isOwner` decides and writes nothing, `requireOwner` decides
// and sends the refusal.
async function isOwner(req: Request): Promise<boolean> {
  // A fresh local clone has no owner token and no users to leak, so the gate
  // stays open there — nothing is reachable from outside to protect it from.
  // Once anything says this process IS reachable (DEPLOYED, above — an
  // explicit flag, a non-loopback bind, an APP_SECRET, a remote CLIENT_URL;
  // not the bind address alone, which reads "local" for an app behind a
  // reverse proxy on a public box), the same condition must fail CLOSED: a
  // missing or empty SPOTIFY_REFRESH_TOKEN (a fresh instance, a rotated
  // secret, a typo'd env var) would otherwise silently publish everyone's
  // prompts to anyone with the URL. Locking the owner out of their own logs is
  // the safe half of that trade.
  if (!spotify.isLoggedIn()) return !DEPLOYED;
  try {
    const ownerId = await spotify.getOwnerId();
    return Boolean(ownerId) && callerUser(req) === ownerId;
  } catch {
    // Resolving /me needs the network. Failing it means we cannot prove anyone
    // is the owner, and "cannot prove" is a no here.
    return false;
  }
}

async function requireOwner(req: Request, res: Response): Promise<boolean> {
  if (await isOwner(req)) return true;
  res.status(401).json({ error: "Owner only." });
  return false;
}

// ── daily caps ───────────────────────────────────────────────

// The reasoning and the counting live in caps.ts (pure, tested); this is
// just the env wiring. Guests are cheap to mint, so the guest caps are what
// bound the bill; the account cap is per allowlisted friend.
// The all-guests default is sized to Spotify's daily SEARCH quota, not to the
// Anthropic bill: a run costs 8-30 searches against a few hundred a day, so a
// higher ceiling here doesn't serve more people, it just trips the breaker
// (spotify.ts) and takes the app down for everyone until it clears.
// That 8-30 is now a bound and not an estimate: one budget object per request
// is shared by the curator loop and track resolution (searchBudget.ts,
// REQUEST_SEARCH_BUDGET below), so the number these caps are sized against is
// the number actually enforced. It used to be an assumption the resolution
// half never read — worst case ~44.
const generationLimits = {
  perAccount: Number(process.env.DAILY_GENERATIONS_PER_USER) || 25,
  perGuest: Number(process.env.GUEST_DAILY_CAP) || 5,
  perIp: Number(process.env.GUEST_IP_DAILY_CAP) || 10,
  allGuests: Number(process.env.GUEST_TOTAL_DAILY_CAP) || 12,
};

const caps = makeCaps(generationLimits);

// Spotify searches one request may spend, across BOTH halves of it. 30 because
// the curator loop keeps its own internal cap of 20 and resolution draws from
// whatever is left, so a request that curates hard still has 10 to verify with,
// and one that curates cheaply can spend more on resolution. The old worst case
// was ~44 — 20 in the loop, then up to 3 query strategies × 8 tracks outside
// any budget at all. searchBudget.ts has the full argument.
const REQUEST_SEARCH_BUDGET = 30;

// Body-field caps, all with the same reasoning as the 32kb limit above: the
// curator's message array only grows, so anything long is paid for once per
// turn of the agent loop. These are the generous end of "what a person types".
// A mixtape prompt is a sentence; a card is 8 tracks by construction and the
// margin is only there so a future format change doesn't 400 on real cards.
const MAX_PROMPT_CHARS = 2000;
const MAX_ADJUSTMENT_CHARS = 2000;
const MAX_CARD_TRACKS = 50;
// Display text that rides into the prompt with the seed. Trimmed rather than
// refused: it is the playlist's own name, and a long one is not an attack, it
// is a person with a long playlist name.
const MAX_SEED_NAME_CHARS = 200;

// Pressing keeps a second, independent ledger derived from the same numbers.
// /api/playlist is reachable without ever calling the curator, so the caps
// above never see it; pressCaps.ts has the reasoning.
const pressCaps = makePressCaps(generationLimits);

function capExceeded(user: string, req: Request): string | null {
  return caps.refusal(user, String(req.ip), today());
}

function countGeneration(user: string, req: Request) {
  caps.count(user, String(req.ip), today());
}

function pressExceeded(user: string, req: Request): string | null {
  return pressCaps.refusal(user, String(req.ip), today());
}

function countPress(user: string, req: Request) {
  pressCaps.count(user, String(req.ip), today());
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
    // A misconfigured server, hit by a real person clicking Connect — the
    // funnel has to show that as breakage, not as nobody trying.
    metrics.count("errors");
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
    // replaces a guest identity, if the browser had one
    res.setHeader("Set-Cookie", [
      `${SESSION_COOKIE}=${signUser(userId, SESSION_KEY)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}` +
        (req.secure ? "; Secure" : ""),
      `${OAUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
    ]);
    console.log(`[auth] ${displayName || userId} connected their Spotify`);
    res.redirect(CLIENT_URL);
  } catch (err: any) {
    // The state checks above 400 on a forged or stale link; reaching here
    // means Spotify accepted the round trip and the exchange still failed —
    // ours, and the visitor is stuck on a plain-text page.
    metrics.count("errors");
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

// The funnel: views → prompts → cards → presses, by day. Aggregate, but
// owner-only anyway — it is nobody else's business how the app is doing.
app.get("/api/metrics", async (req, res) => {
  if (!(await requireOwner(req, res))) return;
  res.json(metrics.recent(30));
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
    // The 401/403 above are a token the caller can fix by logging in again;
    // this one is the app breaking on them, so it belongs in the funnel.
    metrics.count("errors");
    res
      .status(500)
      .json({ error: "Listing playlists failed — check the server logs." });
  }
});

// Streaming generate. Emits, in order:
//   [seeding → seeded (when a seed playlist is set)]
//   → curating → track (per track, as Claude streams it) → curated (count)
//   → resolving / resolved (per track) → done (full card) | error
app.post("/api/generate/stream", sameOriginOnly, async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  // seed: {id, name} — an existing playlist to build "in the spirit of".
  // The id comes from the picker, or is parsed out of a pasted link; the
  // name is client-provided display text and is looked up when missing.
  const seedRaw = String(req.body?.seed?.id || "").trim();
  const seedId = (seedRaw && spotify.parsePlaylistRef(seedRaw)) || "";
  let seedName = String(req.body?.seed?.name || "")
    .trim()
    .slice(0, MAX_SEED_NAME_CHARS);
  if (seedRaw && !seedId) {
    return res.status(400).json({
      error: "That doesn't look like a Spotify playlist link.",
    });
  }
  if (!prompt && !seedId) {
    return res.status(400).json({ error: "Missing prompt" });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({
      error: `That prompt is too long — keep it under ${MAX_PROMPT_CHARS} characters.`,
    });
  }
  if (!curator.anthropicConfigured()) {
    // Counted, unlike the 400s above: a missing or rotated key 500s on every
    // visitor, and an unconfigured server reading `0 errors` is the exact
    // blind spot the funnel exists to close. The 400s are the user's typo,
    // not the app's outage, so they stay uncounted.
    metrics.count("errors");
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }
  const user = callerIdentity(req, res);
  const refusal = capExceeded(user, req);
  if (refusal) {
    metrics.count("capped");
    return res.status(429).json({ error: refusal });
  }
  countGeneration(user, req);
  usage.record(user, isAnon(user) ? "guest" : spotify.getDisplayName(user), "generation");
  metrics.count("prompts");
  sseInit(res);
  // One allowance for the whole request: the curator loop spends from it while
  // it searches, resolution spends what is left. Per-request, so it cannot be a
  // module singleton.
  const budget = makeSearchBudget(REQUEST_SEARCH_BUDGET);
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
      const reader = readerFor(user);
      if (!seedName) {
        // pasted link: the client only knows the id
        seedName = (await spotify.getPlaylistMeta(seedId, reader)).name || "";
      }
      sseSend(res, "seeding", { name: seedName });
      const { tracks, total } = await spotify.getSeedTracks(seedId, reader);
      if (tracks.length === 0) {
        metrics.count("errors");
        sseSend(res, "error", {
          message: "Couldn't read that playlist — it may be empty.",
        });
        return res.end();
      }
      seed = { name: seedName || "this playlist", tracks, total };
      sseSend(res, "seeded", { count: tracks.length, total });
    }
    console.log(
      `[generate/stream] (${whoLabel(user)}) ` +
        `prompt=${JSON.stringify(prompt)}` +
        (seedId ? ` seed=${seedId}` : "")
    );
    sseSend(res, "curating", { prompt });
    const card = await curator.generateCard(prompt, {
      seed,
      signal: abort.signal,
      budget,
      onTrack: (index, t) =>
        sseSend(res, "track", { index, artist: t.artist, title: t.title }),
    });
    sseSend(res, "curated", { count: card.tracks.length, title: card.title });
    card.tracks = await spotify.resolveTracks(
      card.tracks,
      3,
      (event, payload) => sseSend(res, event, payload),
      abort.signal,
      budget
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
    metrics.count("generated");
    sseSend(res, "done", { card, verified });
  } catch (err: any) {
    if (abort.signal.aborted) {
      console.log("[generate/stream] client disconnected — stopped");
      return res.end();
    }
    metrics.count("errors");
    console.error("[generate/stream] failed:", err.message);
    // `detail` is the raw upstream message — things like
    // "Spotify API 502 on /v1/search: …". The OWNER still gets it on screen,
    // because the logbook it would otherwise send them to is one tap away in
    // the same page and paraphrasing it as "check the server logs" wastes the
    // trip. Everyone else gets the generic line: this app is deployed with no
    // APP_SECRET (public mode), so "the only client is the gated owner" — what
    // this comment used to claim — is false, and internals are not owed to a
    // stranger. The detail is in the log either way.
    sseSend(res, "error", {
      // Quota exhaustion is a wait-until-tomorrow condition, not a bug to retry
      // into — say so, or the obvious response is to hammer the button.
      message: err.quotaExceeded
        ? "Spotify's daily limit for this app is used up."
        : "Generation failed.",
      ...((await isOwner(req)) ? { detail: err.message } : {}),
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
app.post("/api/adjust/stream", sameOriginOnly, async (req, res) => {
  const card = req.body?.card;
  const adjustment = String(req.body?.adjustment || "").trim();
  if (!adjustment || !card || !Array.isArray(card.tracks) || card.tracks.length === 0) {
    return res.status(400).json({ error: "Missing card or adjustment" });
  }
  if (adjustment.length > MAX_ADJUSTMENT_CHARS) {
    return res.status(400).json({
      error: `That note is too long — keep it under ${MAX_ADJUSTMENT_CHARS} characters.`,
    });
  }
  // The card comes back from the client, so its size is theirs to choose, and
  // every track in it is re-sent to the model on every turn of the loop.
  if (card.tracks.length > MAX_CARD_TRACKS) {
    return res.status(400).json({ error: "That card has too many tracks." });
  }
  if (!curator.anthropicConfigured()) {
    metrics.count("errors"); // same reasoning as /api/generate/stream
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not configured on the server." });
  }
  const user = callerIdentity(req, res);
  const refusal = capExceeded(user, req);
  if (refusal) {
    metrics.count("capped");
    return res.status(429).json({ error: refusal });
  }
  countGeneration(user, req);
  usage.record(user, isAnon(user) ? "guest" : spotify.getDisplayName(user), "adjust");
  metrics.count("adjusts");
  sseInit(res);
  // Same one-allowance-per-request rule as /api/generate/stream.
  const budget = makeSearchBudget(REQUEST_SEARCH_BUDGET);
  // Same disconnect handling as /api/generate/stream.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  console.log(
    `[adjust/stream] (${whoLabel(user)}) ` +
      `adjustment=${JSON.stringify(adjustment)}`
  );
  sseSend(res, "adjusting", { adjustment });
  try {
    const diff = await curator.adjustCard(card, adjustment, {
      signal: abort.signal,
      budget,
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
      abort.signal,
      budget
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
    metrics.count("errors");
    console.error("[adjust/stream] failed:", err.message);
    // detail is owner-only, same reasoning as /api/generate/stream
    sseSend(res, "error", {
      message: err.quotaExceeded
        ? "Spotify's daily limit for this app is used up."
        : "Adjustment failed.",
      ...((await isOwner(req)) ? { detail: err.message } : {}),
    });
  }
  res.end();
});

// Press the card into a real playlist. Every mixtape is pressed into the
// HOST account, public, so it is shareable from birth and anyone can keep
// it with one tap (+) in Spotify — no login, no allowlist. A caller who IS
// connected also gets it followed into their own library right here (the
// 0-tap save). Body: { title, uris }. With Accept: text/event-stream the
// two real steps (creating → adding N) stream as SSE; else plain JSON.
app.post("/api/playlist", sameOriginOnly, async (req, res) => {
  const { title } = req.body || {};
  // `uris` was the asymmetry on this route: `title` goes through
  // sanitizePlaylistName before it lands on a public profile, while `uris` was
  // checked with Array.isArray and then handed straight to the write. It is
  // the more dangerous of the two — it decides what is IN the playlist.
  // trackUris.ts says what a real one looks like and why anything else is a
  // 400 rather than something to filter down.
  const uris = parseTrackUris(req.body?.uris);
  if (!title || !uris) {
    return res.status(400).json({ error: "Missing title or valid track uris" });
  }
  const user = callerIdentity(req, res);
  // Checked before anything is created. This route reads its title and uris
  // from the body, so it is the one paid path that never passed the curator —
  // uncapped it is an open write to the host's public profile.
  const refusal = pressExceeded(user, req);
  if (refusal) {
    metrics.count("capped");
    return res.status(429).json({ error: refusal });
  }
  countPress(user, req);
  const host = spotify.hostUser();
  const name = spotify.sanitizePlaylistName(title);
  const wantsStream = String(req.headers.accept || "").includes("text/event-stream");
  if (wantsStream) sseInit(res);
  try {
    const { id, url } = await spotify.createPlaylist(
      {
        name,
        // No prompt on the playlist: it sits on a public profile, and a
        // prompt can be more personal than the person meant to publish.
        description: "Made with Mixtape.",
        uris,
        isPublic: true,
      },
      wantsStream ? (event, data) => sseSend(res, event, data) : undefined,
      host
    );
    // Follow it into the caller's own library when they have a token — a
    // failure here must not fail the press: the playlist exists and the
    // one-tap path still works.
    let saved = false;
    if (!isAnon(user) && user !== host) {
      try {
        await spotify.followPlaylist(id, user);
        saved = true;
      } catch (err: any) {
        console.warn(`[playlist] follow into ${whoLabel(user)}'s library failed: ${err.message}`);
      }
    } else if (user === host) {
      saved = true; // it's their own library
    }
    usage.record(user, isAnon(user) ? "guest" : spotify.getDisplayName(user), "save");
    metrics.count("pressed");
    console.log(
      `[playlist] (${whoLabel(user)}) pressed ${JSON.stringify(name)} → ${id}` +
        (saved ? " (in their library)" : "")
    );
    if (wantsStream) {
      sseSend(res, "done", { playlistUrl: url, playlistId: id, saved });
      return res.end();
    }
    res.json({ playlistUrl: url, playlistId: id, saved });
  } catch (err: any) {
    metrics.count("errors");
    console.error("[playlist] failed:", err.message);
    // detail stays in the server log — clients get a generic line
    const message = err.quotaExceeded
      ? "Spotify's daily limit for this app is used up — try again tomorrow."
      : err.status === 401
        ? "The Mixtape account isn't connected on the server."
        : "Pressing the playlist failed — check the server logs.";
    if (wantsStream) {
      sseSend(res, "error", { message });
      return res.end();
    }
    res.status(500).json({ error: message });
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

if (DEPLOYED && !spotify.isLoggedIn()) {
  console.warn(
    "[config] SPOTIFY_REFRESH_TOKEN is unset on a deployed host — the " +
      "owner-only routes (/api/logs, /api/usage, /api/metrics) are closed to " +
      "EVERYONE, including you, until it is set. See README → Deploy."
  );
}

if (DEPLOYED && !APP_SECRET) {
  // Public mode. The door is open on purpose; what bounds the Anthropic
  // spend and the shared Spotify quota is the daily caps, not a key.
  console.log(
    "[config] APP_SECRET is unset — public mode. Spend is bounded by the " +
      "daily caps (GUEST_TOTAL_DAILY_CAP and friends); set APP_SECRET to go " +
      "back to invite-only."
  );
}

app.listen(PORT, HOST, () => {
  console.log(`Mixtape POC server listening on http://${HOST}:${PORT}`);
});
