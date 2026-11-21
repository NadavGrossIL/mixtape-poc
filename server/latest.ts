// "Fresh off the press": the newest mixtapes anyone pressed, for a stranger
// to look at before they make one.
//
// Every press already lands as a PUBLIC playlist on the host account
// (ADR 0002), so this lists nothing that isn't public on Spotify already:
// the title (sanitizePlaylistName), the vibe line (the cleaned one the
// playlist description carries) and the open.spotify.com link. Never the
// prompt, never who pressed it — the same line playlistDescription.ts draws.
//
// Recorded at press time rather than read back from the host profile: the
// Spotify quota is a few hundred requests a day for the whole app
// (.claude/rules/spotify.md), and a front-page list read from it would spend
// that on page views. Listing what we wrote costs zero Spotify calls.
//
// Only cards this server's curator wrote get on the shelf. /api/playlist
// reads title and vibe from the request body (it is the one paid route that
// skips the curator — pressCaps.ts), so without this a hand-written curl
// could put any text on every visitor's home page. The press still happens;
// it just isn't advertised. See makeVouches below.
//
// The owner can hide an entry (an ugly Claude title) without touching the
// playlist itself — deleting or privatizing a pressed playlist revokes it
// from every library that saved it, so that is never the moderation tool.
//
// A factory like metrics.ts: dir and clock come in, so the test needs no
// server. Same persistence story — DATA_DIR on a volume survives redeploys,
// beside the code it resets with them.

import fs from "node:fs";
import path from "node:path";

export type LatestMixtape = {
  id: string; // Spotify playlist id — the key hide() takes
  title: string;
  vibe: string; // "" when the card had none
  url: string;
  pressedAt: number;
};

// Kept, and served. Twelve is a shelf, not an archive: enough that one
// hidden entry doesn't empty it, small enough to read in a glance.
export const LATEST_KEEP = 12;
const PLAYLIST_ID_RE = /^[A-Za-z0-9]{22}$/;

function toEntry(value: unknown): LatestMixtape | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !PLAYLIST_ID_RE.test(v.id)) return null;
  if (typeof v.title !== "string" || !v.title.trim()) return null;
  if (typeof v.pressedAt !== "number" || !Number.isFinite(v.pressedAt)) return null;
  return {
    id: v.id,
    title: v.title.slice(0, 100),
    vibe: typeof v.vibe === "string" ? v.vibe.slice(0, 200) : "",
    // rebuilt from the id, never read from the file: it becomes an href
    url: `https://open.spotify.com/playlist/${v.id}`,
    pressedAt: v.pressedAt,
  };
}

// Pure: a hand-edited or half-written file reads as an empty shelf, never
// as a bad href or a crash.
export function parseLatest(raw: unknown): LatestMixtape[] {
  if (!Array.isArray(raw)) return [];
  const out: LatestMixtape[] = [];
  for (const item of raw) {
    const e = toEntry(item);
    if (e && !out.some((o) => o.id === e.id)) out.push(e);
  }
  return out.sort((a, b) => b.pressedAt - a.pressedAt).slice(0, LATEST_KEEP);
}

export function makeLatest({ dir, now = Date.now }: { dir: string; now?: () => number }) {
  const file = path.join(dir, ".latest.json");
  let list: LatestMixtape[] | null = null;
  let warned = false;

  function load(): LatestMixtape[] {
    if (list) return list;
    try {
      list = parseLatest(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      list = [];
    }
    return list;
  }

  // Written on every change: presses are a handful a day, so there is no
  // burst to coalesce. temp-then-rename, like metrics.ts.
  function save(): void {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (err: any) {
      if (!warned) {
        warned = true;
        console.warn(`[latest] can't write ${file}: ${err.message} — keeping it in memory only`);
      }
    }
  }

  function record(entry: { id: string; title: string; vibe: string }): void {
    const e = toEntry({ ...entry, pressedAt: now() });
    if (!e) return;
    list = [e, ...load().filter((o) => o.id !== e.id)].slice(0, LATEST_KEEP);
    save();
  }

  // true when something was removed
  function hide(id: string): boolean {
    const before = load();
    const next = before.filter((o) => o.id !== id);
    if (next.length === before.length) return false;
    list = next;
    save();
    return true;
  }

  return { record, hide, list: (): LatestMixtape[] => [...load()] };
}

// The cards the curator actually produced, by a key the caller builds from
// the title and vibe exactly as they'd be pressed. In memory and bounded:
// a card made before a redeploy and pressed after it just skips the shelf,
// which costs nothing. 500 is days of traffic at the app's caps.
export const VOUCH_MAX = 500;

export function makeVouches(max: number = VOUCH_MAX) {
  const keys = new Set<string>();
  return {
    add(key: string): void {
      keys.delete(key); // re-adding moves it to the newest end
      keys.add(key);
      while (keys.size > max) keys.delete(keys.values().next().value as string);
    },
    has: (key: string): boolean => keys.has(key),
  };
}
