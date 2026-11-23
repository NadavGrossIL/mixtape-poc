// The card on screen, kept for this tab in sessionStorage, so leaving the
// page and coming back doesn't lose it. Pure, no DOM — server/test runs it.
//
// Why: the card lived only in React state. A jam card's links (and a phone's
// in-app browser) can open in the same tab, and Back then reloaded an empty
// page: useUnsavedCardGuard's beforeunload listener keeps Chrome from
// putting the page in its back/forward cache, so nothing came back with it
// (2026-11-23). A reload lost the card the same way (2026-11-22, see
// useUnsavedCardGuard). sessionStorage is per tab and goes when the tab
// closes: Back and reload restore the card, a new tab starts clean.
//
// The playlist pressed from the card rides along (and whether it landed in
// the visitor's library), so a restored card that was already saved doesn't
// offer to save it again and says the same thing it said before.
//
// Storage is user-editable and every URL here becomes an href or an img src,
// so a read keeps only Spotify's own https links (as recent.ts does); the
// server re-checks the card on any refine (server/wire.ts).

import type { MixCard, Track } from "./types.ts";
import type { StorageLike as ReadWrite } from "./recent.ts";

export type StorageLike = ReadWrite & { removeItem(key: string): void };

export const CURRENT_KEY = "mixtape.current.v1";

export type CurrentCard = { card: MixCard; playlistUrl: string | null; savedToLibrary?: boolean };

function httpsOn(value: unknown, host: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === host ? value : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toTrack(value: unknown): Track | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (!str(t.artist) || !str(t.title) || !str(t.note)) return null;
  const spotifyUrl = httpsOn(t.spotifyUrl, "open.spotify.com");
  const spotifyUri = str(t.spotifyUri) && /^spotify:track:[A-Za-z0-9]+$/.test(t.spotifyUri) ? t.spotifyUri : null;
  const track: Track = {
    artist: t.artist,
    title: t.title,
    note: t.note,
    // a track only counts as resolved with a real Spotify link to press
    resolved: t.resolved === true && Boolean(spotifyUrl && spotifyUri),
    spotifyUrl,
    spotifyUri,
    albumArt: httpsOn(t.albumArt, "i.scdn.co"),
    durationMs: num(t.durationMs),
    year: num(t.year),
  };
  if (str(t.ref)) track.ref = t.ref;
  if (str(t.matchedName)) track.matchedName = t.matchedName;
  return track;
}

export function parseCurrentCard(raw: string | null): CurrentCard | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { card: c, playlistUrl, savedToLibrary } = parsed as {
    card?: Record<string, unknown>;
    playlistUrl?: unknown;
    savedToLibrary?: unknown;
  };
  if (!c || typeof c !== "object") return null;
  if (!str(c.title) || !str(c.vibe) || !str(c.accent) || !Array.isArray(c.tracks)) return null;
  const tracks = c.tracks.map(toTrack);
  if (!tracks.length || tracks.length > 8 || tracks.some((t) => !t)) return null;
  const card: MixCard = { title: c.title, vibe: c.vibe, accent: c.accent, tracks: tracks as Track[] };
  if (str(c.prompt)) card.prompt = c.prompt;
  if (c.seed && typeof c.seed === "object" && str((c.seed as { name?: unknown }).name)) {
    const s = c.seed as { id?: unknown; name: string };
    card.seed = str(s.id) ? { id: s.id, name: s.name } : { name: s.name };
  }
  if (str(c.threadId)) card.threadId = c.threadId;
  if (c.mode === "jam" || c.mode === "mix") card.mode = c.mode;
  const pressed = httpsOn(playlistUrl, "open.spotify.com");
  return { card, playlistUrl: pressed, savedToLibrary: Boolean(pressed) && savedToLibrary === true };
}

export function loadCurrentCard(getStorage: () => StorageLike): CurrentCard | null {
  try {
    return parseCurrentCard(getStorage().getItem(CURRENT_KEY));
  } catch {
    return null; // blocked storage: start clean, as before
  }
}

// null clears it ("make another one", a new run starting).
export function saveCurrentCard(getStorage: () => StorageLike, current: CurrentCard | null): void {
  try {
    const storage = getStorage();
    if (current) storage.setItem(CURRENT_KEY, JSON.stringify(current));
    else storage.removeItem(CURRENT_KEY);
  } catch {
    // full or blocked storage: the card just won't survive a reload
  }
}
