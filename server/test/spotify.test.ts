// Pure matching internals of the resolver — the hallucination gate's scoring.

import test from "node:test";
import assert from "node:assert";
import {
  normalize,
  similarity,
  artistScore,
  buildQueries,
  ARTIST_FLOOR,
} from "../spotify.ts";

// ── normalize ────────────────────────────────────────────────

test("normalize strips diacritics, parentheticals, punctuation; & → and", () => {
  assert.strictEqual(normalize("Beyoncé"), "beyonce");
  assert.strictEqual(normalize("Time (Remastered 2011)"), "time");
  assert.strictEqual(normalize("Simon & Garfunkel"), "simon and garfunkel");
  assert.strictEqual(normalize("Don't Stop Me Now!"), "don t stop me now");
});

// ── similarity ───────────────────────────────────────────────

test("similarity: exact (post-normalize) is 1, containment is 0.85", () => {
  assert.strictEqual(similarity("Time", "Time (Remastered)"), 1);
  assert.strictEqual(similarity("Hotel California", "Hotel California - Live"), 0.85);
});

test("similarity: token overlap ratio for partial matches, 0 for empty", () => {
  // "night moves" vs "night drives" — 1 common token of 2 → 0.5
  assert.strictEqual(similarity("night moves", "night drives"), 0.5);
  assert.strictEqual(similarity("", "anything"), 0);
  assert.strictEqual(similarity("abc", "xyz"), 0);
});

// ── artistScore ──────────────────────────────────────────────

test("artistScore: wrong artist scores 0 even when the title would be perfect", () => {
  // ARTIST_FLOOR exists exactly for this: covers/karaoke/same-name songs must
  // never fake-resolve on title alone.
  const s = artistScore([{ name: "Karaoke All Stars" }], "Adele");
  assert.strictEqual(s, 0);
  assert.ok(s < ARTIST_FLOOR);
});

test("artistScore: exact artist scores 1", () => {
  assert.strictEqual(artistScore([{ name: "Adele" }], "Adele"), 1);
});

test("artistScore: curated primary artist matches any of the item's artists", () => {
  const itemArtists = [{ name: "Tech N9ne" }, { name: "Krizz Kaliko" }];
  assert.strictEqual(artistScore(itemArtists, "Krizz Kaliko"), 1);
});

test("artistScore: curated 'X ft. Y' matches on primary artist X alone", () => {
  assert.strictEqual(
    artistScore([{ name: "Krizz Kaliko" }], "Krizz Kaliko ft. Tech N9ne"),
    1
  );
});

test("artistScore: empty artist list scores 0", () => {
  assert.strictEqual(artistScore([], "Adele"), 0);
  assert.strictEqual(artistScore(undefined, "Adele"), 0);
});

// ── buildQueries ─────────────────────────────────────────────

test("buildQueries: three strategies in order, field-filtered first", () => {
  const qs = buildQueries({ artist: "Adele", title: "Hello" });
  assert.deepStrictEqual(
    qs.map((x) => x.strategy),
    ["field", "plain", "normalized"]
  );
  assert.strictEqual(qs[0]!.q, 'artist:"Adele" track:"Hello"');
});

test('buildQueries: strips " from values in the field filter', () => {
  const qs = buildQueries({ artist: 'The "Fake" Band', title: 'Say "Hi"' });
  const field = qs.find((x) => x.strategy === "field")!;
  // only the four delimiting quotes survive — none from the values
  assert.strictEqual(field.q, 'artist:"The Fake Band" track:"Say Hi"');
  assert.strictEqual((field.q.match(/"/g) || []).length, 4);
});

test("buildQueries: drops empty and duplicate queries", () => {
  // already-normalized input: plain and normalized collapse to one query
  const qs = buildQueries({ artist: "adele", title: "hello" });
  const plain = qs.filter((x) => x.q === "adele hello");
  assert.strictEqual(plain.length, 1);
});

// ── sampleTracks ─────────────────────────────────────────────

import { sampleTracks, SEED_TRACK_CAP } from "../spotify.ts";

test("sampleTracks: at or under the cap returns the input unchanged", () => {
  const tracks = [{ title: "a" }, { title: "b" }];
  assert.strictEqual(sampleTracks(tracks, 2), tracks);
  assert.strictEqual(sampleTracks([], 5).length, 0);
});

test("sampleTracks: over the cap samples evenly — ordered, no duplicates, ends covered", () => {
  const tracks = Array.from({ length: 200 }, (_, i) => ({ title: String(i) }));
  const out = sampleTracks(tracks, 80);
  assert.strictEqual(out.length, 80);
  // starts at the top; a top-only slice would end at 79, not deep in the tail
  assert.strictEqual(out[0]!.title, "0");
  assert.ok(Number(out[out.length - 1]!.title) >= 195);
  // strictly increasing source positions = order preserved and no duplicates
  const idx = out.map((t) => Number(t.title));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i]! > idx[i - 1]!);
});

test("sampleTracks: default cap is SEED_TRACK_CAP", () => {
  const tracks = Array.from({ length: SEED_TRACK_CAP + 40 }, (_, i) => ({
    title: String(i),
  }));
  assert.strictEqual(sampleTracks(tracks).length, SEED_TRACK_CAP);
});
