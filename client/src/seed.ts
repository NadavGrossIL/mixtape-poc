// The seed picker's three decisions, kept out of the component so they are
// unit-tested under Node (server/test/seed.test.ts): reading a pasted
// playlist link, which rows the picker lists, and which playlist is armed.

import type { Playlist } from "./types.ts";

// the picker's playlist list: null while loading, "unauthorized" when the
// stored token predates the playlist-read scopes, "error" for anything else
export type SeedPlaylists = Playlist[] | "unauthorized" | "error" | null;

// A pasted playlist link's ID, or null when it isn't one: anything with
// `playlist/` or `playlist:` before 22 ID characters (a share link, with or
// without `?si=`, or a spotify: URI), or a bare 22-character ID.
export function parsePlaylistLink(text: string): string | null {
  const m = /playlist[/:]([A-Za-z0-9]{22})/.exec(text) ||
    /^\s*([A-Za-z0-9]{22})\s*$/.exec(text);
  return m?.[1] ?? null;
}

// the picker's rows: filtered by the search box, the caller's own playlists
// first (followed ones can be unreadable for dev-mode apps — see server).
// `mine ?? true`: rows from a server without the flag stay unlabeled.
export function visibleSeedPlaylists(playlists: SeedPlaylists, filter: string): Playlist[] {
  return Array.isArray(playlists)
    ? playlists
        .filter((p) =>
          p.name.toLowerCase().includes(filter.trim().toLowerCase())
        )
        .sort((a, b) => Number(b.mine ?? true) - Number(a.mine ?? true))
    : [];
}

// The armed seed: a playlist picked from the list, else a pasted one.
export function seedPlaylistFor(
  playlists: SeedPlaylists,
  seedId: string,
  pastedSeed: Playlist | null
): Playlist | null {
  return (
    (Array.isArray(playlists) ? playlists.find((p) => p.id === seedId) || null : null) ??
    pastedSeed
  );
}
