// A pasted playlist link is read the way the picker always has (loosely);
// the picker lists the caller's own playlists first; a picked playlist
// outranks a pasted one.

import test from "node:test";
import assert from "node:assert";
import { parsePlaylistLink, seedPlaylistFor, visibleSeedPlaylists } from "../../client/src/seed.ts";
import type { Playlist } from "../../client/src/types.ts";

const ID = "37i9dQZF1DX0XUsuxWHRQd"; // 22 characters

// ── parsePlaylistLink ──

test("a share link with ?si= gives its playlist ID", () => {
  assert.strictEqual(parsePlaylistLink(`https://open.spotify.com/playlist/${ID}?si=abc123`), ID);
});

test("a spotify: URI gives its playlist ID", () => {
  assert.strictEqual(parsePlaylistLink(`spotify:playlist:${ID}`), ID);
});

test("a bare 22-character ID is accepted, spaces around it ignored", () => {
  assert.strictEqual(parsePlaylistLink(`  ${ID}\n`), ID);
});

test("a bare ID of 21 or 23 characters is not one", () => {
  assert.strictEqual(parsePlaylistLink(ID.slice(1)), null);
  assert.strictEqual(parsePlaylistLink(ID + "x"), null);
});

test("junk is not a playlist link", () => {
  assert.strictEqual(parsePlaylistLink("my favourite songs"), null);
  assert.strictEqual(parsePlaylistLink(""), null);
  assert.strictEqual(parsePlaylistLink(`https://open.spotify.com/album/${ID}`), null);
});

// pinned, not endorsed: today any host works, and a longer ID in a link is
// cut to its first 22 characters
test("the link match stays as loose as it is today", () => {
  assert.strictEqual(parsePlaylistLink(`https://example.com/playlist/${ID}`), ID);
  assert.strictEqual(parsePlaylistLink(`https://open.spotify.com/playlist/${ID}x`), ID);
});

// ── visibleSeedPlaylists ──

const p = (id: string, name: string, mine?: boolean): Playlist => ({ id, name, mine });

test("the filter is trimmed and case-insensitive", () => {
  const list = [p("1", "Late Night Drive"), p("2", "Sunday Dishes")];
  assert.deepStrictEqual(
    visibleSeedPlaylists(list, "  NIGHT ").map((x) => x.id),
    ["1"]
  );
});

test("the caller's own playlists come first; no flag counts as mine", () => {
  const list = [p("a", "followed", false), p("b", "unflagged"), p("c", "mine", true)];
  assert.deepStrictEqual(
    visibleSeedPlaylists(list, "").map((x) => x.id),
    ["b", "c", "a"]
  );
});

test("ties keep the server's order", () => {
  const list = [p("1", "x", false), p("2", "y", true), p("3", "z", false), p("4", "w", true)];
  assert.deepStrictEqual(
    visibleSeedPlaylists(list, "").map((x) => x.id),
    ["2", "4", "1", "3"]
  );
});

test("the server's list is not reordered in place", () => {
  const list = [p("a", "followed", false), p("b", "mine", true)];
  visibleSeedPlaylists(list, "");
  assert.deepStrictEqual(list.map((x) => x.id), ["a", "b"]);
});

test("no rows while the list is loading, refused or failed", () => {
  assert.deepStrictEqual(visibleSeedPlaylists(null, ""), []);
  assert.deepStrictEqual(visibleSeedPlaylists("unauthorized", ""), []);
  assert.deepStrictEqual(visibleSeedPlaylists("error", ""), []);
});

// ── seedPlaylistFor ──

const pasted = p(ID, "", false);

test("a picked playlist beats a pasted one", () => {
  const list = [p("1", "picked")];
  assert.strictEqual(seedPlaylistFor(list, "1", pasted)?.name, "picked");
});

test("an ID not on the list falls back to the pasted playlist", () => {
  assert.strictEqual(seedPlaylistFor([p("1", "picked")], "2", pasted), pasted);
  assert.strictEqual(seedPlaylistFor([p("1", "picked")], "", pasted), pasted);
});

test("without a readable list the pasted playlist is the seed", () => {
  assert.strictEqual(seedPlaylistFor("error", "1", pasted), pasted);
  assert.strictEqual(seedPlaylistFor(null, "1", null), null);
});
