// The card on screen survives Back and a reload (client/src/currentCard.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_KEY,
  parseCurrentCard,
  loadCurrentCard,
  saveCurrentCard,
  type StorageLike,
} from "../../client/src/currentCard.ts";

const track = (i: number) => ({
  ref: `r${i}`,
  artist: `Artist ${i}`,
  title: `Song ${i}`,
  note: `note ${i}`,
  resolved: true,
  spotifyUrl: `https://open.spotify.com/track/abc${i}`,
  spotifyUri: `spotify:track:abc${i}`,
  albumArt: `https://i.scdn.co/image/x${i}`,
  matchedName: `Artist ${i} — Song ${i}`,
  durationMs: 180000,
  year: 1999,
});
const card = () => ({
  title: "Four Guitars, One Fire",
  vibe: "for the circle",
  accent: "ember",
  prompt: "campfire",
  tracks: [1, 2, 3].map(track),
  threadId: "t-1",
  mode: "jam" as const,
});

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test("a card saved for this tab comes back the same, mode and playlist included", () => {
  const s = memory();
  const current = { card: card(), playlistUrl: "https://open.spotify.com/playlist/p1", savedToLibrary: true };
  saveCurrentCard(() => s, current);
  assert.deepEqual(loadCurrentCard(() => s), current);
});

test("savedToLibrary without a pressed playlist is dropped", () => {
  const got = parseCurrentCard(JSON.stringify({ card: card(), playlistUrl: null, savedToLibrary: true }))!;
  assert.equal(got.savedToLibrary, false);
});

test("null clears it", () => {
  const s = memory();
  saveCurrentCard(() => s, { card: card(), playlistUrl: null });
  saveCurrentCard(() => s, null);
  assert.equal(s.data.has(CURRENT_KEY), false);
  assert.equal(loadCurrentCard(() => s), null);
});

test("nothing stored, junk or a wrong shape: no card", () => {
  for (const raw of [null, "", "{", "[]", "{}", JSON.stringify({ card: { title: "x" } })]) {
    assert.equal(parseCurrentCard(raw), null, String(raw));
  }
  assert.equal(parseCurrentCard(JSON.stringify({ card: { ...card(), tracks: [] } })), null);
  assert.equal(parseCurrentCard(JSON.stringify({ card: { ...card(), tracks: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(track) } })), null);
});

test("a link that isn't Spotify's own https is dropped, and its track no longer counts as resolved", () => {
  const bad = card();
  bad.tracks[0] = { ...bad.tracks[0]!, spotifyUrl: "javascript:alert(1)", albumArt: "https://evil.example/x.png" };
  const got = parseCurrentCard(JSON.stringify({ card: bad, playlistUrl: "http://open.spotify.com/p" }))!;
  assert.equal(got.card.tracks[0]!.spotifyUrl, null);
  assert.equal(got.card.tracks[0]!.albumArt, null);
  assert.equal(got.card.tracks[0]!.resolved, false);
  assert.equal(got.playlistUrl, null);
  assert.equal(got.card.tracks[1]!.resolved, true);
});

test("an unknown mode is dropped, so the card is a mixtape", () => {
  const got = parseCurrentCard(JSON.stringify({ card: { ...card(), mode: "rave" } }))!;
  assert.equal("mode" in got.card, false);
});

test("blocked storage reads as no card and a write doesn't throw", () => {
  const blocked = () => {
    throw new Error("SecurityError");
  };
  assert.equal(loadCurrentCard(blocked), null);
  assert.doesNotThrow(() => saveCurrentCard(blocked, { card: card(), playlistUrl: null }));
});
