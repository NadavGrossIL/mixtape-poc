// extractCompleteTracks: the streaming partial-JSON brace matcher. It sees
// arbitrary chunk boundaries — every test buffer below is a legal mid-stream
// state, not necessarily valid JSON.

import test from "node:test";
import assert from "node:assert";
import { extractCompleteTracks } from "../curator.ts";

const TRACK = (artist: string, title: string, note = "n") =>
  `{"artist":${JSON.stringify(artist)},"title":${JSON.stringify(title)},"note":${JSON.stringify(note)}}`;

test("returns [] before the tracks array appears", () => {
  assert.deepStrictEqual(extractCompleteTracks(""), []);
  assert.deepStrictEqual(extractCompleteTracks('{"title":"Mix"'), []);
  assert.deepStrictEqual(extractCompleteTracks('{"title":"Mix","tracks":'), []);
});

test("extracts each complete object, ignoring the partial tail", () => {
  const buf = `{"title":"Mix","tracks":[${TRACK("A", "One")},${TRACK("B", "Two")},{"artist":"C","ti`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 2);
  assert.deepStrictEqual(tracks[0], { artist: "A", title: "One", note: "n" });
  assert.deepStrictEqual(tracks[1], { artist: "B", title: "Two", note: "n" });
});

test("braces inside string values do not open or close objects", () => {
  const buf = `{"tracks":[${TRACK("A", "Song {with} braces", "note } stray")}]`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].title, "Song {with} braces");
});

test("escaped quotes inside strings do not end the string", () => {
  const buf = `{"tracks":[{"artist":"A","title":"Say \\"Hi\\" {now}","note":"n"}]`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].title, 'Say "Hi" {now}');
});

test("escaped backslash before a closing quote ends the string correctly", () => {
  // title is `back\` — the \\ is one literal backslash, the quote after it is real
  const buf = `{"tracks":[{"artist":"A","title":"back\\\\","note":"n"}]`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].title, "back\\");
});

test("stops at the array close — objects after ] are not tracks", () => {
  const buf = `{"tracks":[${TRACK("A", "One")}],"extra":{"artist":"X","title":"Y","note":"n"}}`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].artist, "A");
});

test("reads the named array key (changes, for adjust_mixtape)", () => {
  const buf = `{"changes":[{"index":3,"track":${TRACK("A", "One")}},{"index":5,"tr`;
  const changes = extractCompleteTracks(buf, "changes");
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].index, 3);
  assert.strictEqual(changes[0].track.title, "One");
});

test("nested objects count as one entry (change objects wrap a track)", () => {
  const buf = `{"changes":[{"index":0,"track":{"artist":"A","title":"T","note":"n"}}]`;
  const changes = extractCompleteTracks(buf, "changes");
  assert.strictEqual(changes.length, 1);
});

// ── seedContext: the "in the spirit of" prompt block ─────────

import { seedContext } from "../curator.ts";

test("seedContext: names the playlist, lists every track, states the dedup rule", () => {
  const ctx = seedContext({
    name: "Late Night Drives",
    total: 2,
    tracks: [
      { artist: "The War on Drugs", title: "Red Eyes" },
      { artist: "M83", title: "Midnight City" },
    ],
  });
  assert.ok(ctx.includes('"Late Night Drives"'));
  assert.ok(ctx.includes("all 2 tracks"));
  assert.ok(ctx.includes("The War on Drugs — Red Eyes"));
  assert.ok(ctx.includes("M83 — Midnight City"));
  // the load-bearing rule: without it the model can echo the playlist back
  assert.ok(/do not include any track from the list above/i.test(ctx));
});

test("seedContext: says when the list is a sample, not the whole playlist", () => {
  const ctx = seedContext({
    name: "Big One",
    total: 500,
    tracks: [{ artist: "A", title: "T" }],
  });
  assert.ok(ctx.includes("1 of its 500 tracks, sampled in playlist order"));
});

// ── the completeness gate ────────────────────────────────────────
// Strict tool schemas validate types but can't express "exactly 8 items",
// so `"tracks": []` and a lone {"artist":"placeholder",...} row are both
// schema-valid. Roughly one live run in five ended that way. These are the
// exact payloads observed on the wire.

import { cardIncompleteReason, diffIncompleteReason, TRACK_COUNT } from "../curator.ts";

const full = (n = TRACK_COUNT) =>
  Array.from({ length: n }, (_, i) => ({
    artist: `Artist ${i}`,
    title: `Title ${i}`,
    note: `Note ${i}`,
  }));

const card = (over: Record<string, unknown> = {}) => ({
  title: "Rainy Sunday, No Plans",
  vibe: "For the ones who let the kettle go cold",
  accent: "plum",
  tracks: full(),
  ...over,
});

test("a complete card passes", () => {
  assert.strictEqual(cardIncompleteReason(card()), null);
});

test("rejects the empty-input wire flake", () => {
  assert.match(String(cardIncompleteReason({})), /empty/);
});

test("rejects the observed empty-tracks commit", () => {
  // verbatim from a failing run: title/vibe/accent filled, tracks dropped
  assert.match(String(cardIncompleteReason(card({ tracks: [] }))), /empty/);
});

test("rejects the observed single-placeholder-row commit", () => {
  const stub = card({
    tracks: [{ artist: "placeholder", title: "placeholder", note: "placeholder" }],
  });
  // caught on count before it can be clamped into a 1-track mixtape
  assert.match(String(cardIncompleteReason(stub)), /1 entries/);
});

test("rejects a placeholder row hiding in a full-length list", () => {
  const tracks = full();
  tracks[4] = { artist: "TBD", title: "Title 4", note: "Note 4" };
  assert.match(String(cardIncompleteReason(card({ tracks }))), /track 5/);
});

test("rejects blank strings, which the schema happily allows", () => {
  const tracks = full();
  tracks[0] = { artist: "  ", title: "Title 0", note: "Note 0" };
  assert.match(String(cardIncompleteReason(card({ tracks }))), /track 1/);
});

test("over-count still passes the gate — generateCard clamps it", () => {
  assert.strictEqual(cardIncompleteReason(card({ tracks: full(10) })), null);
});

test("adjust: an empty diff is fine when the identity changed", () => {
  assert.strictEqual(
    diffIncompleteReason({ changes: [], title: "New Title" }),
    null
  );
});

test("adjust: an empty diff that changes nothing is rejected", () => {
  assert.match(String(diffIncompleteReason({ changes: [] })), /changed nothing/);
});

test("adjust: a placeholder replacement is rejected", () => {
  const diff = {
    changes: [{ index: 2, track: { artist: "placeholder", title: "x", note: "y" } }],
  };
  assert.match(String(diffIncompleteReason(diff)), /change 1/);
});

test("adjust: a real replacement passes", () => {
  const diff = {
    changes: [
      { index: 2, track: { artist: "Nick Drake", title: "Pink Moon", note: "quiet" } },
    ],
  };
  assert.strictEqual(diffIncompleteReason(diff), null);
});
