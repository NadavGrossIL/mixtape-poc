// The card/track shapes the server streams back. Unresolved tracks keep only
// the curator's fields; the Spotify fields land on successful resolution.
// The server's definition is server/wire.ts (zod). It cannot be imported
// here, not even as types: the production build type-checks the client before
// server/node_modules exists. server/test/wire.test.ts fails the gate when
// these stop being identical to it.

// The accent names the curator picks from (ACCENTS in server/wire.ts).
export type Accent = "ember" | "rose" | "plum" | "cobalt" | "forest" | "rust";

export interface Track {
  // the curator's handle on the search result it picked this track from.
  // Never read here; a refine sends it back with the card, so the server
  // can look the record up directly (server/lc/cardDiff.ts)
  ref?: string;
  artist: string;
  title: string;
  note: string;
  resolved: boolean;
  spotifyUri?: string | null;
  spotifyUrl?: string | null;
  albumArt?: string | null;
  // the catalog row resolution matched, as "artist — title". Never read here
  matchedName?: string;
  // from the catalog row that verified the track (spotify.ts resolveTrack)
  durationMs?: number | null;
  year?: number | null;
}

// The sleeve's stamp line. Runtime and era come from the resolved Spotify
// rows — the same records that verified the tracks — never from the model.
// Unverified tracks carry neither and won't be pressed, so the runtime is the
// runtime of what actually lands in the playlist. A segment is dropped when
// no track can supply it, so the line never says "0 MIN".
export function cardFacts(tracks: Track[]): string[] {
  const ms = tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  const years = tracks
    .map((t) => t.year)
    .filter((y): y is number => typeof y === "number");
  const facts: string[] = [];
  if (ms > 0) facts.push(`${Math.max(1, Math.round(ms / 60000))} MIN`);
  if (years.length) {
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    facts.push(lo === hi ? String(lo) : `${lo}–${hi}`);
  }
  return facts;
}

export interface MixCard {
  title: string;
  vibe: string;
  accent: string;
  prompt?: string;
  seed?: { id?: string; name: string };
  tracks: Track[];
  // the curator's memory thread for this card's conversation
  // (server/lc/curator-lc.ts). Never read here, but a refine must send it
  // back with the card, so a refine can continue that conversation.
  threadId?: string;
  // "jam": a jam set — the rows show the play-this-song links (jamLinks.ts).
  // Set by the server on a jam run only; a refine sends it back untouched,
  // and the server picks the curator's rules from it.
  mode?: "mix" | "jam";
}

export interface Playlist {
  id: string;
  name: string;
  total?: number | null;
  owner?: string | null;
  // false = followed, not made by the caller — dev-mode apps may not be able
  // to read its tracks (Spotify-made ones never work), so the picker sorts
  // and labels by this
  mine?: boolean;
}

// Progress-log line for the generate stream — written sparsely by index, so
// the array can have holes until every "track" event has landed.
export interface LogTrack {
  artist: string;
  title: string;
  resolved?: boolean;
}

// Progress-log line for the refine stream.
export interface AdjustLogLine {
  index: number;
  artist: string;
  title: string;
  resolved?: boolean;
}

// SSE payloads, per stream, as [event, data] tuples — a discriminated tuple
// union, so narrowing on the event name types the data in the callback.
// Events the client ignores ("seeded", "resolving") are listed for honesty.
export type GenerateStreamEvent =
  | ["seeding", { name?: string } | null]
  | ["seeded", { count: number; total: number } | null]
  | ["curating", { prompt?: string } | null]
  | ["track", { index: number; artist: string; title: string }]
  | ["curated", { count: number; title: string } | null]
  | ["resolving", { index: number; artist: string; title: string } | null]
  | ["resolved", { index: number; resolved: boolean }]
  | ["done", { card?: MixCard; verified?: number } | null]
  | ["error", { message?: string; detail?: string; quota?: boolean; outage?: boolean } | null];

export type AdjustStreamEvent =
  | ["adjusting", { adjustment?: string } | null]
  | ["change", { index: number; artist: string; title: string }]
  | ["adjusted", { count: number } | null]
  | ["resolving", { index: number; artist: string; title: string } | null]
  | ["resolved", { index: number; resolved: boolean }]
  | ["done", { card?: MixCard } | null]
  | ["error", { message?: string; detail?: string; quota?: boolean; outage?: boolean } | null];

export type SaveStreamEvent =
  | ["creating", { name?: string } | null]
  | ["adding", { count?: number } | null]
  // saved: the server followed the playlist straight into the caller's own
  // library (connected accounts only); everyone else keeps it with one tap
  | ["done", { playlistUrl?: string; playlistId?: string; saved?: boolean } | null]
  | ["error", { message?: string; detail?: string } | null];
