// The share page, /m/<playlist id>: the pressed card on Mixtape's own domain,
// so a link sent to a friend shows the title, the vibe, the eight tracks and
// their liner notes, with OPEN IN SPOTIFY and "make your own" — and its own
// link preview — instead of a bare Spotify URL.
//
// The one rule: every word on that page is a word this server's curator
// wrote. /api/playlist reads title, vibe and uris from the request body, and
// /api/adjust/stream takes the whole card from the browser, so a card a
// client sends is the sender's word. Hosting it at mixtape's own URL, with a
// preview card in WhatsApp, would be a free defacement/phishing page. So:
//
//   - the generate route records the card it just curated (makeTrustedCards),
//   - the adjust route records the result built from the TRUSTED parent's
//     tracks plus the ones the curator rewrote this turn — never from the
//     tracks the browser sent back,
//   - the press looks the card up by title+vibe (the shelf's key) and keeps
//     it only when its verified tracks are exactly the uris being pressed
//     (cardForPress), so the page lists what is actually in the playlist.
//
// Anything that misses — a card made before a redeploy (the trusted map is
// in memory), a hand-written press — just gets no page of its own; the shelf
// entry (title + vibe + Spotify link) is the fallback, and past that a 404.
//
// Never the prompt, the seed playlist, the thread id or who pressed it: the
// same line latest.ts and playlistDescription.ts draw. Only fields the public
// playlist or the card itself shows.
//
// Stored one file per playlist under <dir>/shares/, so a press writes one
// small file and a page view reads one; the id is checked against Spotify's
// 22-char shape before it is ever a path. Same DATA_DIR story as metrics.ts.

import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "./errors.ts";

export type ShareTrack = {
  artist: string;
  title: string;
  note: string;
  resolved: boolean;
  spotifyUri: string | null;
  spotifyUrl: string | null;
  albumArt: string | null;
  durationMs: number | null;
  year: number | null;
};

export type ShareCard = {
  title: string;
  vibe: string;
  accent: string;
  tracks: ShareTrack[];
};

export const PLAYLIST_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_URL_RE = /^https:\/\/open\.spotify\.com\//;
const ART_RE = /^https:\/\/[a-z0-9-]+\.scdn\.co\//;
const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const ACCENT_RE = /^[a-z]{1,20}$/;
const MAX_TRACKS = 20;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function match(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}

function toTrack(value: unknown): ShareTrack | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  const artist = str(t.artist, 200);
  const title = str(t.title, 200);
  if (!artist.trim() || !title.trim()) return null;
  return {
    artist,
    title,
    note: str(t.note, 600),
    resolved: t.resolved === true,
    spotifyUri: match(t.spotifyUri, TRACK_URI_RE),
    // these two land in an <a href> and an <img src>
    spotifyUrl: match(t.spotifyUrl, SPOTIFY_URL_RE),
    albumArt: match(t.albumArt, ART_RE),
    durationMs: num(t.durationMs),
    year: num(t.year),
  };
}

// Pure: the card stripped to what the page shows. null when it is not a card
// (a hand-edited file, a half-written one) — never a bad href or a crash.
export function toShareCard(value: unknown): ShareCard | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  const title = str(c.title, 100);
  if (!title.trim() || !Array.isArray(c.tracks)) return null;
  const tracks: ShareTrack[] = [];
  for (const t of c.tracks.slice(0, MAX_TRACKS)) {
    const s = toTrack(t);
    if (!s) return null; // a track we can't read is a card we can't vouch for
    tracks.push(s);
  }
  if (!tracks.length) return null;
  return {
    title,
    vibe: str(c.vibe, 200),
    accent: match(c.accent, ACCENT_RE) ?? "ember",
    tracks,
  };
}

// A refine's result, built from the trusted parent: the tracks the curator
// replaced this turn (`changed`, by card position) come from `merged`,
// every other one from `parent` — never from the card the browser sent.
// null when there is no trusted parent or the shapes don't line up.
export function adjustedShareCard(
  parent: ShareCard | undefined,
  merged: unknown,
  changed: ReadonlySet<number>,
): ShareCard | null {
  if (!parent) return null;
  const next = toShareCard(merged);
  if (!next || next.tracks.length !== parent.tracks.length) return null;
  return {
    ...next,
    tracks: next.tracks.map((t, i) => (changed.has(i) ? t : parent.tracks[i]!)),
  };
}

// The page lists what is actually in the playlist: the card's verified
// tracks, in order, must be exactly the uris pressed. Anything else (a
// different track list under the same title+vibe) gets no page.
export function cardForPress(card: ShareCard | undefined, uris: readonly string[]): ShareCard | null {
  if (!card) return null;
  const verified = card.tracks.filter((t) => t.resolved && t.spotifyUri);
  if (verified.length !== uris.length) return null;
  if (verified.some((t, i) => t.spotifyUri !== uris[i])) return null;
  return { ...card, tracks: verified };
}

// The curator's cards by the shelf key (title + vibe as pressed), in memory
// and bounded like makeVouches in latest.ts: 500 cards of a few KB each.
export const TRUSTED_MAX = 500;

export function makeTrustedCards(max: number = TRUSTED_MAX) {
  const cards = new Map<string, ShareCard>();
  return {
    add(key: string, card: ShareCard | null): void {
      if (!card) return;
      cards.delete(key); // re-adding moves it to the newest end
      cards.set(key, card);
      while (cards.size > max) cards.delete(cards.keys().next().value as string);
    },
    get: (key: string): ShareCard | undefined => cards.get(key),
  };
}

export function makeShares({ dir }: { dir: string }) {
  const folder = path.join(dir, "shares");
  let warned = false;
  const fileFor = (id: string) => path.join(folder, `${id}.json`);

  function record(id: string, card: ShareCard): void {
    if (!PLAYLIST_ID_RE.test(id)) return;
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = fileFor(id);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(card), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn(`[shares] can't write ${folder}: ${errorMessage(err)} — share pages won't persist`);
      }
    }
  }

  function get(id: string): ShareCard | null {
    if (!PLAYLIST_ID_RE.test(id)) return null;
    try {
      return toShareCard(JSON.parse(fs.readFileSync(fileFor(id), "utf8")));
    } catch {
      return null;
    }
  }

  function remove(id: string): void {
    if (!PLAYLIST_ID_RE.test(id)) return;
    fs.rmSync(fileFor(id), { force: true });
  }

  return { record, get, remove };
}

// ── the link preview ─────────────────────────────────────────

// Crawlers (WhatsApp, LinkedIn, Slack, X) don't run JS, so /m/<id> is served
// index.html with its title and preview tags rewritten for this mixtape. The
// image stays the site's og.png: a per-mixtape image is a renderer we don't
// have.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function shareMeta(m: { title: string; vibe: string; tracks?: { artist: string }[] }): {
  title: string;
  description: string;
} {
  const artists = [...new Set((m.tracks ?? []).map((t) => t.artist))].slice(0, 3);
  const lead = m.vibe ? `“${m.vibe}”` : "A mixtape";
  const withArtists = artists.length ? ` — ${artists.join(", ")} and more.` : ".";
  return {
    title: `${m.title} — a Mixtape`,
    description: `${lead}${withArtists} Listen on Spotify, or make your own.`,
  };
}

// Swaps the content of the tags index.html already has. A tag that isn't
// there is left alone rather than added: index.html is the one list of them.
export function withShareMeta(
  html: string,
  meta: { title: string; description: string },
  url: string,
): string {
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const u = escapeHtml(url);
  const set = (h: string, re: RegExp, value: string) => h.replace(re, (_m, pre, post) => `${pre}${value}${post}`);
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  out = set(out, /(<meta name="description" content=")[^"]*(")/, d);
  out = set(out, /(<meta property="og:title" content=")[^"]*(")/, t);
  out = set(out, /(<meta property="og:description" content=")[^"]*(")/, d);
  out = set(out, /(<meta property="og:url" content=")[^"]*(")/, u);
  out = set(out, /(<meta name="twitter:title" content=")[^"]*(")/, t);
  out = set(out, /(<meta name="twitter:description" content=")[^"]*(")/, d);
  return out;
}
