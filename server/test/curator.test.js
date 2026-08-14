// extractCompleteTracks: the streaming partial-JSON brace matcher. It sees
// arbitrary chunk boundaries — every test buffer below is a legal mid-stream
// state, not necessarily valid JSON.

const test = require("node:test");
const assert = require("node:assert");
const { extractCompleteTracks } = require("../curator.js");

const TRACK = (artist, title, note = "n") =>
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
