// What the card screen computes from a card, kept out of the components so it
// is unit-tested under Node (server/test/card.test.ts): track identity, the
// drag-to-reorder move, the copyable song list, the search fallback link,
// the verified count and the accent ink.

import type { MixCard, Track } from "./types.ts";

// Identity for a track. Not guaranteed unique: a repeated curated track, or
// two entries resolving to the same URI, would collide.
export const trackId = (t: Track) => t.spotifyUri || `${t.artist}—${t.title}`;

// Sortable/key id, made unique by position. Computed from the card's current
// order at render time — dnd-kit snapshots items at drag start, so ids stay
// stable for the duration of a drag, and the positional suffix makes the
// drag-end indexOf lookup exact even with duplicate tracks.
export const sortableId = (t: Track, i: number) => `${trackId(t)}#${i}`;

// The card with the dragged row (activeId) moved to where it was dropped
// (overId), both sortableIds. A copy of dnd-kit's arrayMove, so this file
// stays free of it: a new card and a new tracks array every time, which the
// row-refocus effect relies on to run after a reorder.
export function reorderTracks(card: MixCard, activeId: string, overId: string): MixCard {
  const ids = card.tracks.map(sortableId);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  const tracks = card.tracks.slice();
  // arrayMove reads the length before it removes the row
  const at = to < 0 ? tracks.length + to : to;
  const moved = tracks.splice(from, 1)[0];
  if (moved !== undefined) tracks.splice(at, 0, moved);
  return { ...card, tracks };
}

// The card's tracks as plain lines — for anyone who wants to own a copy
// (paste into a new playlist, or search them on another service).
export function trackListText(tracks: Track[]): string {
  return tracks
    .filter((t) => t.resolved)
    .map((t) => `${t.artist} — ${t.title}`)
    .join("\n");
}

// where an unverified track's row points: a Spotify search for it
export const spotifySearchUrl = (t: Track) =>
  `https://open.spotify.com/search/${encodeURIComponent(t.artist + " " + t.title)}`;

// how many of the tracks Spotify confirmed
export const verifiedCount = (tracks: Track[]) => tracks.filter((t) => t.resolved).length;

// Color tokens live in styles/tokens.css. This map is the per-mixtape accent,
// darkened per hue to hold ≥4.5:1 contrast as ink on the cream card.
// Record<string, string>: the accent name arrives from the server, and the
// lookup below already falls back to ember for anything unknown — including
// cards curated before the Clay Wall palette, whose accent names no longer exist.
// Keep these names in sync with the `accent` enums in server/curator.ts.
const ACCENT_INK: Record<string, string> & { ember: string } = {
  ember: "#a83a0a",
  rose: "#a92e5c",
  plum: "#6a3a86",
  cobalt: "#2f5aa8",
  forest: "#237a4a",
  rust: "#7a5518",
};

export function accentInkFor(card: MixCard | null): string {
  return card
    ? ACCENT_INK[card.accent] || ACCENT_INK.ember
    : ACCENT_INK.ember;
}
