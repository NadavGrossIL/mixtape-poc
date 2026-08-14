// Pure matching internals of the resolver — the hallucination gate's scoring.

const test = require("node:test");
const assert = require("node:assert");
const {
  normalize,
  similarity,
  artistScore,
  buildQueries,
  ARTIST_FLOOR,
} = require("../spotify.js");

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
  assert.strictEqual(qs[0].q, 'artist:"Adele" track:"Hello"');
});

test("buildQueries: strips \" from values in the field filter", () => {
  const qs = buildQueries({ artist: 'The "Fake" Band', title: 'Say "Hi"' });
  const field = qs.find((x) => x.strategy === "field");
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
