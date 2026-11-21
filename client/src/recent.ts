// "Your mixtapes": the presses this browser made, remembered in localStorage.
//
// Every press is a public playlist on the host "Mixtape" account (ADR 0002),
// so a guest who didn't tap + in Spotify right away had no way back to it
// from here. This keeps { title, url, pressedAt } per press — browser-only on
// purpose: guest identity is an expiring cookie, the server disk is not a
// history store, and listing what we already hold costs zero Spotify calls.
// Per device+browser; private mode or cleared data loses it, and the Mixtape
// profile on Spotify stays the fallback for everything.
//
// Pure, no DOM globals: the root tsconfig has no DOM lib and
// server/test/recent.test.ts runs this under Node. Storage is passed in as a
// getter, because in some browsers merely reading `window.localStorage`
// throws — not just getItem/setItem.

export type RecentMixtape = { title: string; url: string; pressedAt: number };

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

// versioned, so a later shape change ignores old data instead of misreading it
export const RECENT_KEY = "mixtape.recent.v1";
export const RECENT_MAX = 10;

// Only Spotify's own https links survive a read: the entry becomes an href,
// and storage is user-editable, so a `javascript:` URL must never get through.
function isSpotifyUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "open.spotify.com";
  } catch {
    return false;
  }
}

function toEntry(value: unknown): RecentMixtape | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isSpotifyUrl(v.url)) return null;
  const title = typeof v.title === "string" ? v.title.trim().slice(0, 120) : "";
  const pressedAt = typeof v.pressedAt === "number" && Number.isFinite(v.pressedAt) ? v.pressedAt : 0;
  return { title: title || "untitled mixtape", url: v.url, pressedAt };
}

export function parseRecent(raw: string | null): RecentMixtape[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RecentMixtape[] = [];
  for (const item of parsed) {
    const e = toEntry(item);
    if (e) out.push(e);
  }
  return out;
}

// Newest first, one entry per URL (a re-press of the same playlist moves it
// to the top), capped.
export function addRecent(
  list: RecentMixtape[],
  entry: RecentMixtape,
  max: number = RECENT_MAX
): RecentMixtape[] {
  return [entry, ...list.filter((e) => e.url !== entry.url)].slice(0, max);
}

export function loadRecent(getStorage: () => StorageLike): RecentMixtape[] {
  try {
    return parseRecent(getStorage().getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

// Returns whether it stuck; callers keep the in-memory list either way, so the
// list still shows for the rest of the visit when storage refuses the write.
export function saveRecent(getStorage: () => StorageLike, list: RecentMixtape[]): boolean {
  try {
    getStorage().setItem(RECENT_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
