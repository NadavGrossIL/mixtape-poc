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

// create_mixtape streams tracks as an OBJECT (track1…track8) now, so the
// extractor has to open on `{` as readily as `[`. This is the live
// track-by-track reveal in the UI — if it regresses, the card fills in one
// jump at the end instead of a track at a time.

test("extracts tracks from the keyed object container, in wire order", () => {
  const buf = `{"title":"Mix","tracks":{"track1":${TRACK("A", "One")},"track2":${TRACK("B", "Two")},"track3":{"artist":"C","ti`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 2);
  assert.strictEqual(tracks[0].artist, "A");
  assert.strictEqual(tracks[1].artist, "B");
});

test("stops at the keyed container's close — later objects are not tracks", () => {
  const buf = `{"tracks":{"track1":${TRACK("A", "One")}},"extra":{"artist":"X","title":"Y","note":"n"}}`;
  const tracks = extractCompleteTracks(buf);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].artist, "A");
});

test("a brace inside the title before the container does not misplace the open", () => {
  // the scan opens on whichever of [ or { comes first AFTER the tracks key
  const buf = `{"title":"Mix {live}","tracks":{"track1":${TRACK("A", "One")}}`;
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
// Strict tool schemas validate types but can't express "exactly 8 items", so
// `"tracks": []` and a lone {"artist":"placeholder",...} row were both
// schema-valid — and measured over 10 live runs the model closed the array
// after one exemplar track 6 times. The card's tracks are now 8 required
// KEYS (track1…track8), which the grammar does enforce; this gate stays for
// substance, which no schema checks. Payloads below were observed on the wire.

import {
  cardIncompleteReason,
  diffIncompleteReason,
  toTrackList,
  TRACK_COUNT,
} from "../curator.ts";

// the wire shape: {track1: {...}, …}
const keyed = (tracks: unknown[]) =>
  Object.fromEntries(tracks.map((t, i) => [`track${i + 1}`, t]));

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
  assert.match(String(cardIncompleteReason(card({ tracks: [] }))), /no tracks/);
  assert.match(String(cardIncompleteReason(card({ tracks: {} }))), /no tracks/);
});

test("rejects the observed single-placeholder-row commit", () => {
  const stub = card({
    tracks: [{ artist: "placeholder", title: "placeholder", note: "placeholder" }],
  });
  // caught on count before it can be clamped into a 1-track mixtape
  assert.match(String(cardIncompleteReason(stub)), /only 1 of the 8/);
});

// --- the keyed wire shape the model actually sends now ---

test("a complete keyed card passes", () => {
  assert.strictEqual(cardIncompleteReason(card({ tracks: keyed(full()) })), null);
});

test("rejects the truncated commit in keyed form", () => {
  // the exact failure the schema change makes ungrammatical, kept as a net:
  // one filled slot, seven missing
  const stub = card({ tracks: keyed(full(1)) });
  assert.match(String(cardIncompleteReason(stub)), /only 1 of the 8/);
});

test("rejects a placeholder hiding in slot 5 of a keyed card", () => {
  const tracks = full();
  tracks[4] = { artist: "TBD", title: "Title 4", note: "Note 4" };
  assert.match(String(cardIncompleteReason(card({ tracks: keyed(tracks) }))), /track 5/);
});

test("toTrackList reads track1…track8 in card order, not object order", () => {
  const shuffled = {
    track3: { artist: "C" },
    track1: { artist: "A" },
    track2: { artist: "B" },
  };
  assert.deepStrictEqual(
    toTrackList(shuffled).map((t: any) => t.artist),
    ["A", "B", "C"]
  );
});

test("toTrackList still reads a plain array", () => {
  assert.deepStrictEqual(toTrackList(full(2)).length, 2);
  assert.deepStrictEqual(toTrackList(null), []);
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

// ── mapPool ──────────────────────────────────────────────────
//
// Searches used to fan out with an unbounded Promise.all — the model emits 9
// tool_use blocks in a turn and all 9 left at once, which is what tripped the
// rolling-window limit. The pool caps in-flight requests without giving up
// batching (all results still go back in one message).

import { mapPool, SEARCH_BUDGET, SEARCH_CONCURRENCY } from "../curator.ts";

test("mapPool: never exceeds the concurrency cap", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 9 }, (_, i) => i);
  await mapPool(items, 2, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i;
  });
  assert.strictEqual(peak, 2);
});

test("mapPool: preserves input order regardless of completion order", async () => {
  // later items finish first — output must still line up with tool_use blocks,
  // or results get attached to the wrong tool_use_id
  const out = await mapPool([30, 20, 10, 0], 4, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepStrictEqual(out, [0, 1, 2, 3]);
});

test("mapPool: runs every item even when there are fewer than the cap", async () => {
  const out = await mapPool([1, 2], 8, async (n) => n * 2);
  assert.deepStrictEqual(out, [2, 4]);
  assert.deepStrictEqual(await mapPool([], 4, async (n) => n), []);
});

test("mapPool: a throwing item rejects the pool (quota must not be swallowed)", async () => {
  await assert.rejects(
    () =>
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw Object.assign(new Error("quota"), { quotaExceeded: true });
        return n;
      }),
    /quota/
  );
});

test("search budget leaves headroom for replacements beyond the 8 tracks", () => {
  assert.ok(SEARCH_BUDGET > TRACK_COUNT, "must allow re-verifying rejected picks");
  assert.ok(SEARCH_CONCURRENCY >= 1 && SEARCH_CONCURRENCY < 8);
});

// ── ref field ────────────────────────────────────────────────
//
// `ref` is what lets resolution be a lookup instead of a second Spotify search.
// It has to be REQUIRED for the grammar to guarantee it is emitted at all — the
// same mechanism that fixed the 6/10 truncated-card bug — with an explicit
// sentinel for the degraded case rather than an omitted field.

import { TRACK_SCHEMA, NO_REF } from "../curator.ts";

test("TRACK_SCHEMA: ref is required, so the grammar cannot omit it", () => {
  assert.ok(TRACK_SCHEMA.required.includes("ref"));
  // still required alongside everything that was required before
  for (const field of ["artist", "title", "note"]) {
    assert.ok(TRACK_SCHEMA.required.includes(field), `${field} must stay required`);
  }
  assert.strictEqual(TRACK_SCHEMA.additionalProperties, false);
});

test("TRACK_SCHEMA: ref's description names the sentinel it documents", () => {
  // a required field with no escape hatch would make the model invent a ref
  // when Spotify search is degraded — the exact failure the field exists to stop
  assert.ok(TRACK_SCHEMA.properties.ref.description.includes(NO_REF));
  assert.strictEqual(TRACK_SCHEMA.properties.ref.type, "string");
});

test("NO_REF is not something isFilled would reject as a stub", () => {
  // cardIncompleteReason must accept a legitimately-unverified track rather
  // than looping the model forever when Spotify is down
  const card = {
    title: "t",
    vibe: "v",
    accent: "ember",
    tracks: Object.fromEntries(
      Array.from({ length: TRACK_COUNT }, (_, i) => [
        `track${i + 1}`,
        { ref: NO_REF, artist: "A", title: "B", note: "n" },
      ])
    ),
  };
  assert.strictEqual(cardIncompleteReason(card), null);
});
