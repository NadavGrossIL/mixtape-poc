// Tracks one by one on the LangChain curator: each track must be reported the
// moment its JSON closes, once, in order — whatever size the pieces arrive in
// and whatever other tool calls share the stream.

import test from "node:test";
import assert from "node:assert";
import { makeCardStream } from "../lc/cardStream.ts";

const track = (n: number) => ({ ref: `r${n}`, artist: `Artist ${n}`, title: `Title ${n}`, note: `note {${n}}` });
const cardJson = (count = 8) =>
  JSON.stringify({
    title: "T",
    vibe: "V",
    accent: "ember",
    tracks: Object.fromEntries(Array.from({ length: count }, (_, i) => [`track${i + 1}`, track(i + 1)])),
  });

// Cut text into pieces of `size` characters, as the model's stream would.
const pieces = (text: string, size: number, index: number) =>
  (text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []).map((args) => [{ index, args }]);

function collect() {
  const seen: [number, any][] = [];
  const stream = makeCardStream("create_mixtape", (i, t) => seen.push([i, t]));
  return { seen, stream };
}

test("reports all eight tracks, in order, for any piece size", () => {
  for (const size of [1, 3, 7, 50, 10_000]) {
    const { seen, stream } = collect();
    stream.push([{ name: "create_mixtape", index: 1, args: "" }]);
    for (const p of pieces(cardJson(), size, 1)) stream.push(p);
    assert.deepEqual(seen.map(([i]) => i), [0, 1, 2, 3, 4, 5, 6, 7], `size ${size}`);
    assert.deepEqual(seen[2]![1], track(3), `size ${size}`);
  }
});

test("a track is reported when it closes, not before and not at the end", () => {
  const { seen, stream } = collect();
  const json = cardJson();
  const cut = json.indexOf('"track2"'); // track1 is complete just before this
  stream.push([{ name: "create_mixtape", index: 0, args: "" }]);
  stream.push([{ index: 0, args: json.slice(0, cut - 5) }]);
  assert.equal(seen.length, 0, "track1 is not closed yet");
  stream.push([{ index: 0, args: json.slice(cut - 5, cut) }]);
  assert.equal(seen.length, 1, "track1 closed — reported at once");
  stream.push([{ index: 0, args: json.slice(cut) }]);
  assert.equal(seen.length, 8);
});

test("search calls in the same message are ignored", () => {
  const { seen, stream } = collect();
  stream.push([{ name: "search_spotify", index: 0, args: "" }]);
  stream.push([{ index: 0, args: '{"query":"tracks {track1} nick drake"}' }]);
  stream.push([{ name: "create_mixtape", index: 1, args: "" }]);
  // pieces of the two calls arrive interleaved
  stream.push([{ index: 0, args: '{"tracks":{"track1":{"artist":"x","title":"y"}}}' }]);
  for (const p of pieces(cardJson(), 40, 1)) stream.push(p);
  assert.equal(seen.length, 8);
  assert.equal(seen[0]![1].artist, "Artist 1");
});

test("a card sent back and written again starts from track 1 again", () => {
  const { seen, stream } = collect();
  stream.push([{ name: "create_mixtape", index: 1, args: "" }]);
  for (const p of pieces(cardJson(), 40, 1)) stream.push(p);
  // next model message: the same tool, a new call
  stream.push([{ name: "create_mixtape", index: 0, args: "" }]);
  for (const p of pieces(cardJson(), 40, 0)) stream.push(p);
  assert.deepEqual(seen.map(([i]) => i), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
});

test("a later message that reuses the index for another tool is not read as a card", () => {
  const { seen, stream } = collect();
  stream.push([{ name: "create_mixtape", index: 0, args: "" }]);
  stream.push([{ index: 0, args: cardJson().slice(0, 30) }]);
  stream.push([{ name: "search_spotify", index: 0, args: "" }]);
  stream.push([{ index: 0, args: cardJson() }]);
  assert.equal(seen.length, 0);
});

test("pieces with no tool call at all are harmless", () => {
  const { seen, stream } = collect();
  stream.push(undefined);
  stream.push(null);
  stream.push([]);
  stream.push([{ index: 0, args: cardJson() }]); // args before any name: not ours
  assert.equal(seen.length, 0);
});
