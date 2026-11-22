// A reorder moves exactly the dragged row and leaves the card it came from
// alone; the copied song list holds only verified songs; an unverified row's
// search link survives any title; unknown accents fall back to ember.

import test from "node:test";
import assert from "node:assert";
import {
  accentInkFor,
  reorderTracks,
  sortableId,
  spotifySearchUrl,
  trackListText,
  verifiedCount,
} from "../../client/src/card.ts";
import type { MixCard, Track } from "../../client/src/types.ts";

const t = (artist: string, title: string, resolved = true): Track => ({
  artist,
  title,
  note: "",
  resolved,
  spotifyUri: resolved ? `spotify:track:${artist}${title}` : null,
});

const A = t("a", "1");
const B = t("b", "2");
const C = t("c", "3");
const D = t("d", "4");

const card = (tracks: Track[]): MixCard => ({ title: "x", vibe: "y", accent: "rose", tracks });

const ids = (c: MixCard) => c.tracks.map((x) => x.title);
const idOf = (c: MixCard, i: number) => {
  const track = c.tracks[i];
  assert.ok(track);
  return sortableId(track, i);
};

// ── sortableId ──

test("sortableId tells apart the same track at two positions", () => {
  assert.notStrictEqual(sortableId(A, 0), sortableId(A, 1));
});

test("an unresolved track's id is built from artist and title", () => {
  assert.strictEqual(sortableId(t("x", "y", false), 2), "x—y#2");
});

// ── reorderTracks ──

test("a row dragged down lands at the drop row's index", () => {
  const c = card([A, B, C, D]);
  assert.deepStrictEqual(ids(reorderTracks(c, idOf(c, 0), idOf(c, 2))), ["2", "3", "1", "4"]);
});

test("a row dragged up lands at the drop row's index", () => {
  const c = card([A, B, C, D]);
  assert.deepStrictEqual(ids(reorderTracks(c, idOf(c, 3), idOf(c, 1))), ["1", "4", "2", "3"]);
});

test("a repeated track moves by its position, not its first copy", () => {
  const c = card([A, B, A, C]);
  const moved = reorderTracks(c, idOf(c, 2), idOf(c, 0));
  assert.deepStrictEqual(ids(moved), ["1", "1", "2", "3"]);
  // the first copy is the one that came from index 2
  assert.strictEqual(moved.tracks[0], c.tracks[2]);
  assert.strictEqual(moved.tracks[3], C);
});

test("the card it came from is left untouched, and a new tracks array comes back", () => {
  const c = card([A, B, C]);
  const moved = reorderTracks(c, idOf(c, 0), idOf(c, 1));
  assert.deepStrictEqual(ids(c), ["1", "2", "3"]);
  assert.notStrictEqual(moved, c);
  assert.notStrictEqual(moved.tracks, c.tracks);
  assert.strictEqual(moved.title, c.title);
  assert.strictEqual(moved.accent, c.accent);
});

// ── trackListText ──

test("the song list is artist — title lines of the verified songs only", () => {
  assert.strictEqual(
    trackListText([A, t("x", "gone", false), B]),
    "a — 1\nb — 2"
  );
  assert.strictEqual(trackListText([]), "");
});

// ── spotifySearchUrl ──

test("the search link encodes what would break a URL path", () => {
  assert.strictEqual(
    spotifySearchUrl(t("AC/DC", "Rock & Roll", false)),
    "https://open.spotify.com/search/AC%2FDC%20Rock%20%26%20Roll"
  );
});

test("the search link carries non-Latin text percent-encoded", () => {
  assert.strictEqual(
    spotifySearchUrl(t("אריק", "שיר", false)),
    `https://open.spotify.com/search/${encodeURIComponent("אריק שיר")}`
  );
});

// ── verifiedCount ──

test("verifiedCount counts the resolved tracks", () => {
  assert.strictEqual(verifiedCount([A, t("x", "y", false), B]), 2);
  assert.strictEqual(verifiedCount([]), 0);
});

// ── accentInkFor ──

test("a known accent gets its ink", () => {
  assert.strictEqual(accentInkFor(card([A])), "#a92e5c");
});

test("an unknown or legacy accent, or no card, falls back to ember", () => {
  const ember = accentInkFor(null);
  assert.strictEqual(ember, "#a83a0a");
  assert.strictEqual(accentInkFor({ ...card([A]), accent: "sunset" }), ember);
  assert.strictEqual(accentInkFor({ ...card([A]), accent: "" }), ember);
});
