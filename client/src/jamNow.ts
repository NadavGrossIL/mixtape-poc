// A jam card's "now playing" mark: the song the circle is on. Opening any of
// a row's links marks that row, and the next row reads UP NEXT.
//
// Keyed by the track's id (card.ts trackId), never its position, so a drag,
// a swap or a refine can't slide the mark onto a different song; when the
// id is gone from the card, nothing is marked. Kept in sessionStorage so Back
// from Ultimate Guitar shows the same song marked, and tied to the card's
// title so another card in the same tab never inherits it. Pure, no DOM —
// unit-tested from server/test/jamNow.test.ts.

import { trackId } from "./card.ts";
import { cleanTitle } from "./jamLinks.ts";
import type { Track } from "./types.ts";

export const JAM_NOW_KEY = "mixtape.jam.now.v1";

export type JamNow = { title: string; trackId: string };

// A stored mark, if it is well formed and belongs to the card titled
// `cardTitle`. Storage is user-editable, so anything else is no mark.
export function parseJamNow(raw: string | null, cardTitle: string): JamNow | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { title, trackId: id } = v as Record<string, unknown>;
  if (typeof title !== "string" || typeof id !== "string" || !id) return null;
  return title === cardTitle ? { title, trackId: id } : null;
}

// The marked row's index, or -1. The first match only: trackId can collide
// on a repeated song, and one row is marked, never two.
export function nowIndex(tracks: Track[], now: JamNow | null): number {
  if (!now) return -1;
  return tracks.findIndex((t) => trackId(t) === now.trackId);
}

// The UP NEXT row, or -1 when nothing is marked or the mark is the last song.
export function nextIndex(now: number, length: number): number {
  return now >= 0 && now + 1 < length ? now + 1 : -1;
}

// the live region's line: "Now on song 4, Wagon Wheel"
export function nowLine(index: number, t: Track): string {
  return `Now on song ${index + 1}, ${cleanTitle(t.title)}`;
}
