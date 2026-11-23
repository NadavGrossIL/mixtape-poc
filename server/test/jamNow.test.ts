// jamNow: a jam card's now-playing mark is read back only when it is well
// formed and belongs to this card, found by the song's id (not its place),
// and the row after it is UP NEXT.

import test from "node:test";
import assert from "node:assert";
import { JAM_NOW_KEY, nextIndex, nowIndex, nowLine, parseJamNow } from "../../client/src/jamNow.ts";
import { trackId } from "../../client/src/card.ts";
import type { Track } from "../../client/src/types.ts";

const song = (artist: string, title: string, uri?: string): Track => ({
  artist,
  title,
  note: "",
  resolved: Boolean(uri),
  spotifyUri: uri ?? null,
});

const tracks = [
  song("Bob Marley & The Wailers", "Three Little Birds", "spotify:track:a"),
  song("Old Crow Medicine Show", "Wagon Wheel", "spotify:track:b"),
  song("John Denver", "Take Me Home, Country Roads - Original Version", "spotify:track:c"),
  song("Unknown", "Never Verified"),
];

test("the storage key is versioned", () => {
  assert.strictEqual(JAM_NOW_KEY, "mixtape.jam.now.v1");
});

test("a well-formed mark for this card is read back", () => {
  const raw = JSON.stringify({ title: "Campfire", trackId: "spotify:track:b" });
  assert.deepStrictEqual(parseJamNow(raw, "Campfire"), { title: "Campfire", trackId: "spotify:track:b" });
});

test("a mark from another card is ignored", () => {
  const raw = JSON.stringify({ title: "Another Night", trackId: "spotify:track:b" });
  assert.strictEqual(parseJamNow(raw, "Campfire"), null);
});

test("missing, malformed or mistyped storage is no mark", () => {
  for (const raw of [null, "", "{", "null", "42", '"x"', "[]", '{"title":"Campfire"}', '{"title":"Campfire","trackId":7}', '{"title":"Campfire","trackId":""}']) {
    assert.strictEqual(parseJamNow(raw, "Campfire"), null, String(raw));
  }
});

test("the mark follows the song, not the slot", () => {
  const now = { title: "Campfire", trackId: trackId(tracks[1]!) };
  assert.strictEqual(nowIndex(tracks, now), 1);
  // dragged to the top: still marked, at its new place
  const moved = [tracks[1]!, tracks[0]!, tracks[2]!, tracks[3]!];
  assert.strictEqual(nowIndex(moved, now), 0);
  // swapped out: nothing is marked, rather than whatever took its place
  const swapped = [tracks[0]!, song("Oasis", "Wonderwall", "spotify:track:z"), tracks[2]!];
  assert.strictEqual(nowIndex(swapped, now), -1);
  assert.strictEqual(nowIndex(tracks, null), -1);
});

test("an unverified song is found by artist and title", () => {
  assert.strictEqual(nowIndex(tracks, { title: "Campfire", trackId: trackId(tracks[3]!) }), 3);
});

test("a repeated song marks its first row only", () => {
  const twice = [tracks[0]!, tracks[1]!, tracks[1]!];
  assert.strictEqual(nowIndex(twice, { title: "Campfire", trackId: trackId(tracks[1]!) }), 1);
});

test("up next is the following row, and nothing after the last or with no mark", () => {
  assert.strictEqual(nextIndex(0, 8), 1);
  assert.strictEqual(nextIndex(6, 8), 7);
  assert.strictEqual(nextIndex(7, 8), -1);
  assert.strictEqual(nextIndex(-1, 8), -1);
});

test("the live-region line counts from one and prints the cleaned title", () => {
  assert.strictEqual(nowLine(3, tracks[1]!), "Now on song 4, Wagon Wheel");
  assert.strictEqual(nowLine(2, tracks[2]!), "Now on song 3, Take Me Home, Country Roads");
});
