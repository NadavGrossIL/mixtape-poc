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
  ADJUST_TOOL,
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

test("adjust: replacements use the same track schema as create — ref included", () => {
  // ADJUST_SYSTEM tells the model to copy a ref into every replacement; a
  // schema without `ref` (additionalProperties:false) makes that impossible
  // and silently demotes replacements to fuzzy-search resolution.
  const trackSchema = (ADJUST_TOOL.input_schema.properties.changes.items as any)
    .properties.track;
  assert.strictEqual(trackSchema, TRACK_SCHEMA);
  assert.ok(TRACK_SCHEMA.required.includes("ref"));
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

// ── noteGroundingReason: the deterministic grounding gate ────
//
// Fixture values are lifted from the 2026-08-18 baseline corpus: the FLAG
// cases are that run's real invented duration/title-track notes, and the PASS
// cases are its real verified-TRUE notes that match the same regex patterns —
// the run's only true-note pattern match (Free Bird) must never regress into
// a bounce, or the gate kills exactly the notes the product wants.

import { noteGroundingReason, extractYears } from "../curator.ts";

const ROWS: Record<string, any> = {
  nantes: {
    name: "Nantes",
    uri: "spotify:track:nantes",
    artists: [{ name: "Beirut" }],
    duration_ms: 248000,
    album: { name: "The Flying Club Cup", release_date: "2007-10-09", album_type: "album" },
  },
  apunk: {
    name: "A-Punk",
    uri: "spotify:track:apunk",
    artists: [{ name: "Vampire Weekend" }],
    duration_ms: 137000,
    album: { name: "Vampire Weekend", release_date: "2008-01-29", album_type: "album" },
  },
  blueridge: {
    name: "Blue Ridge Mountains",
    uri: "spotify:track:blueridge",
    artists: [{ name: "Fleet Foxes" }],
    duration_ms: 265000,
    album: { name: "Fleet Foxes", release_date: "2008-06-03", album_type: "album" },
  },
  manchild: {
    name: "Manchild",
    uri: "spotify:track:manchild",
    artists: [{ name: "Sabrina Carpenter" }],
    duration_ms: 213000,
    album: { name: "Man's Best Friend", release_date: "2025-08-29", album_type: "album" },
  },
  freebird: {
    name: "Free Bird",
    uri: "spotify:track:freebird",
    artists: [{ name: "Lynyrd Skynyrd" }],
    duration_ms: 548000,
    album: { name: "(Pronounced 'Leh-'nerd 'Skin-'nerd)", release_date: "1973-08-13", album_type: "album" },
  },
  stairway: {
    name: "Stairway to Heaven",
    uri: "spotify:track:stairway",
    artists: [{ name: "Led Zeppelin" }],
    duration_ms: 482000,
    album: { name: "Led Zeppelin IV", release_date: "1971-11-08", album_type: "album" },
  },
  layla: {
    name: "Layla",
    uri: "spotify:track:layla",
    artists: [{ name: "Derek & The Dominos" }],
    duration_ms: 313000,
    album: { name: "The Very Best of Eric Clapton", release_date: "2001-01-01", album_type: "album" },
  },
  mykonos: {
    name: "Mykonos",
    uri: "spotify:track:mykonos",
    artists: [{ name: "Fleet Foxes" }],
    duration_ms: 271000,
    album: { name: "Sun Giant", release_date: "2008-04-08", album_type: "album" },
  },
  sp1979: {
    name: "1979",
    uri: "spotify:track:sp1979",
    artists: [{ name: "The Smashing Pumpkins" }],
    duration_ms: 265000,
    album: { name: "Mellon Collie and the Infinite Sadness", release_date: "1995-10-23", album_type: "album" },
  },
  montand: {
    name: "La bicyclette",
    uri: "spotify:track:montand",
    artists: [{ name: "Yves Montand" }],
    duration_ms: 152000,
    album: { name: "Les plus belles chansons", release_date: "1964-01-01", album_type: "album" },
  },
  hanoch: {
    name: "Lo Yode'a Eich Lomar Lach",
    uri: "spotify:track:hanoch",
    artists: [{ name: "Shalom Hanoch" }],
    duration_ms: 300000,
    album: { name: "Line HaLayla", release_date: "1992-05-01", album_type: "album" },
  },
  vu69: {
    name: "What Goes On",
    uri: "spotify:track:vu69",
    artists: [{ name: "The Velvet Underground" }],
    duration_ms: 520000,
    album: { name: "1969: The Velvet Underground Live", release_date: "1974-09-01", album_type: "album" },
  },
  // a cache row written before the field expansion: no duration_ms at all
  stale: {
    name: "Some Old Row",
    uri: "spotify:track:stale",
    artists: [{ name: "A" }],
    album: { name: "Old Album", release_date: "1999-01-01" },
  },
  // Spotify occasionally returns duration_ms 0 — must behave like missing
  zerodur: {
    name: "Zero Length",
    uri: "spotify:track:zerodur",
    artists: [{ name: "A" }],
    duration_ms: 0,
    album: { name: "Zeroes", release_date: "2010-01-01", album_type: "album" },
  },
  // 2026-08-23 validation-run corpus: the album-position invention class.
  // No duration_ms on purpose — these tests isolate the position rule.
  monochrome2: {
    name: "City Lights",
    uri: "spotify:track:monochrome2",
    artists: [{ name: "A" }],
    track_number: 2,
    album: { name: "MONOCHROME", release_date: "1980-01-01", album_type: "album", total_tracks: 8 },
  },
  monochrome1: {
    name: "City Lights",
    uri: "spotify:track:monochrome1",
    artists: [{ name: "A" }],
    track_number: 1,
    album: { name: "MONOCHROME", release_date: "1980-01-01", album_type: "album", total_tracks: 8 },
  },
  lightnup: {
    name: "Sunset Cruise",
    uri: "spotify:track:lightnup",
    artists: [{ name: "A" }],
    track_number: 4,
    album: { name: "LIGHT'N UP", release_date: "1982-01-01", album_type: "album", total_tracks: 8 },
  },
  ethnix: {
    name: "Track Three",
    uri: "spotify:track:ethnix",
    artists: [{ name: "Ethnix" }],
    track_number: 3,
    album: { name: "Ethnix", release_date: "1990-01-01", album_type: "album", total_tracks: 10 },
  },
  disquedor: {
    name: "Chanson Sept",
    uri: "spotify:track:disquedor",
    artists: [{ name: "A" }],
    track_number: 7,
    album: { name: "Disque d'or", release_date: "1992-01-01", album_type: "album", total_tracks: 14 },
  },
  pylon: {
    name: "Second Song",
    uri: "spotify:track:pylon",
    artists: [{ name: "A" }],
    track_number: 2,
    album: { name: "Pylon", release_date: "1980-01-01", album_type: "album", total_tracks: 12 },
  },
  arcrow: {
    name: "Funk Cut",
    uri: "spotify:track:arcrow",
    artists: [{ name: "A" }],
    track_number: 5,
    album: { name: "Whatever Works", release_date: "2001-01-01", album_type: "album", total_tracks: 10 },
  },
  // stale cache row: position halves missing entirely
  noposition: {
    name: "City Lights",
    uri: "spotify:track:noposition",
    artists: [{ name: "A" }],
    track_number: null,
    album: { name: "MONOCHROME", release_date: "1980-01-01", album_type: "album", total_tracks: null },
  },
  fillmore: {
    name: "Whipping Post",
    uri: "spotify:track:fillmore",
    artists: [{ name: "The Allman Brothers Band" }],
    track_number: 5,
    album: { name: "At Fillmore East (Deluxe Edition)", release_date: "1971-07-06", album_type: "album", total_tracks: 14 },
  },
};

const lookup = (ref: string) => ROWS[ref] ?? null;
const gTrack = (ref: string, note: string) => ({ ref, artist: "A", title: "T", note });
const gInput = (tracks: unknown[]) => ({ tracks: keyed(tracks) });

test("grounding FLAGS: 'six aching minutes' vs 4:08 (Nantes)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("nantes", "A father's deathbed telegram turned into six aching minutes of Beirut's saddest brass")]),
    lookup
  );
  assert.match(String(r), /track 1/);
  assert.match(String(r), /six aching minutes/);
  assert.match(String(r), /4:08/);
  assert.match(String(r), /only facts your search results showed/);
});

test("grounding FLAGS: 'under two minutes' vs 2:17 (A-Punk) — direction beats the ±30s tolerance", () => {
  const r = noteGroundingReason(
    gInput([gTrack("apunk", "Under two minutes of pure sprint-outside-without-a-coat energy")]),
    lookup
  );
  assert.match(String(r), /under two minutes/i);
  assert.match(String(r), /2:17/);
});

test("grounding FLAGS: 'six minutes' vs 4:25 (Blue Ridge Mountains)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("blueridge", "Six minutes of acoustic wind-down for the drive home")]),
    lookup
  );
  assert.match(String(r), /Six minutes/);
  assert.match(String(r), /4:25/);
});

test("grounding FLAGS: 'title track' when the album is not the title (Manchild)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("manchild", "The album's title track, all swagger and strut")]),
    lookup
  );
  assert.match(String(r), /title track/);
  assert.match(String(r), /Man's Best Friend/);
});

test("grounding PASSES the run's one true duration note: 'over nine minutes' (Free Bird)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("freebird", "Runs over nine minutes and earns every second of the climb")]),
    lookup
  );
  assert.strictEqual(r, null);
});

test("grounding PASSES a position claim inside the track (Stairway, 8:00 of 8:02)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("stairway", "Page waits eight minutes before he even plugs into the solo")]),
    lookup
  );
  assert.strictEqual(r, null);
});

test("grounding PASSES the 'for two full minutes before' position form (Layla)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("layla", "The slide answers Clapton for two full minutes before the piano coda")]),
    lookup
  );
  assert.strictEqual(r, null);
});

test("grounding PASSES a clock timestamp inside the track (Mykonos, 1:50 of 4:31)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("mykonos", "Those horns kick in around 1:50 and rearrange the whole song")]),
    lookup
  );
  assert.strictEqual(r, null);
});

test("grounding: year rules — equal, off-by-one, and named-in-title all pass", () => {
  // faithfully repeating the shown year (the judge-definition floor)
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("hanoch", "This 1992 late-night ballad closes the bar")]), lookup),
    null
  );
  // ±1 absorbs reissue-date jitter
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("nantes", "A 2008 brass anthem for leaving town")]), lookup),
    null
  );
  // the "1979"-by-Smashing-Pumpkins class: the year IS the track's name
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("sp1979", "1979 bottles teenage boredom into one synth loop")]), lookup),
    null
  );
  // ...and the year appearing in the ALBUM name is a name too
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("vu69", "Cut live in 1969, all nerve and drone")]), lookup),
    null
  );
});

test("grounding: no ref, unknown ref, and null fields are all no-ops", () => {
  // no ref / the NO_REF sentinel — nothing to join against
  assert.strictEqual(
    noteGroundingReason(gInput([{ artist: "A", title: "T", note: "a 1955 postcard" }]), lookup),
    null
  );
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack(NO_REF, "a 1955 postcard")]), lookup),
    null
  );
  // ref the lookup does not know
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("nosuchref", "a 1955 postcard")]), lookup),
    null
  );
  // stale cache row: duration_ms missing, so the duration rule must not fire
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("stale", "Six aching minutes of tape hiss")]), lookup),
    null
  );
});

test("grounding FLAGS a year the shown metadata refutes (1955 vs 1964)", () => {
  const r = noteGroundingReason(
    gInput([gTrack("montand", "A 1955 postcard from the Left Bank in waltz time")]),
    lookup
  );
  assert.match(String(r), /"1955"/);
  assert.match(String(r), /1964/);
  assert.match(String(r), /track 1/);
});

test("grounding names the FIRST violating note by its track number", () => {
  const r = noteGroundingReason(
    gInput([
      gTrack("freebird", "Runs over nine minutes and earns every second of the climb"),
      gTrack("apunk", "Under two minutes of pure sprint energy"),
    ]),
    lookup
  );
  assert.match(String(r), /track 2/);
});

test("grounding: time-of-day clocks, '-minutes in' positions and idioms are not length claims", () => {
  // "2:00 AM" is a time of day — as a length it would flag against 4:25
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("blueridge", "A 2:00 AM confession in falsetto")]), lookup),
    null
  );
  // trailing "in" marks a position — 2:00 into an 8:02 track is fine, though
  // the ±30s length check would have flagged it
  assert.strictEqual(
    noteGroundingReason(
      gInput([gTrack("stairway", "Two minutes in, the recorders give way to guitar")]),
      lookup
    ),
    null
  );
  // "one more minute" is about the listener, not the track (would flag vs 2:17)
  assert.strictEqual(
    noteGroundingReason(
      gInput([gTrack("apunk", "One more minute of this and the night resets")]),
      lookup
    ),
    null
  );
});

test("grounding: 'around' + worded minutes is a LENGTH claim, and 0ms rows are no-ops", () => {
  // "around six minutes" approximates a length — off by 95s is still off
  assert.match(
    String(noteGroundingReason(gInput([gTrack("blueridge", "Around six minutes of slow burn")]), lookup)),
    /4:25/
  );
  // ...while "around" next to a CLOCK stays positional (see the Mykonos pass)
  // and a 0-duration row refutes nothing — not even a position claim
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("zerodur", "Those horns kick in around 1:50")]), lookup),
    null
  );
});

test("grounding FLAGS album-position claims the shown position refutes", () => {
  // "Opens" + the album name in the note, shown track 2 of 8
  const r1 = noteGroundingReason(
    gInput([gTrack("monochrome2", "Opens MONOCHROME in 1980 and stretches to nearly eight minutes")]),
    lookup
  );
  assert.match(String(r1), /track 2 of 8/);
  assert.match(String(r1), /only facts your search results showed/);
  // "Closes" + the album name, shown track 4 of 8
  assert.match(
    String(noteGroundingReason(gInput([gTrack("lightnup", "Closes LIGHT'N UP, 1982, nearly seven minutes")]), lookup)),
    /track 4 of 8/
  );
  // "Opening cut" + the word "album"
  assert.match(
    String(noteGroundingReason(gInput([gTrack("ethnix", "Opening cut off Ethnix's 1990 debut album")]), lookup)),
    /track 3 of 10/
  );
  // bare "opener" + the album name
  assert.match(
    String(noteGroundingReason(gInput([gTrack("disquedor", "1992's Disque D'or opener")]), lookup)),
    /track 7 of 14/
  );
  // the wrong-album form: the note names an album the row does NOT show, so
  // context comes from the "cut off ..." link, and the position still refutes
  assert.match(
    String(noteGroundingReason(gInput([gTrack("pylon", "Closing cut off Memories — under two and a half minutes")]), lookup)),
    /track 2 of 12/
  );
});

test("grounding PASSES album-position claims that are true, arc-talk, or unverifiable", () => {
  // a TRUE opener — same claim, row shows track 1 of 8
  assert.strictEqual(
    noteGroundingReason(
      gInput([gTrack("monochrome1", "Opens MONOCHROME in 1980 and stretches to nearly eight minutes")]),
      lookup
    ),
    null
  );
  // mixtape-arc language is the arc the prompt itself asks for — no album context
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("arcrow", "all whip-crack funk guitar to kick the tape awake")]), lookup),
    null
  );
  assert.strictEqual(
    noteGroundingReason(gInput([gTrack("arcrow", "opens the tape hands-up")]), lookup),
    null
  );
  // stale cache row: no track_number/total_tracks to verify against
  assert.strictEqual(
    noteGroundingReason(
      gInput([gTrack("noposition", "Opens MONOCHROME in 1980 and stretches to nearly eight minutes")]),
      lookup
    ),
    null
  );
  // "closer" with no album context at all: album name absent from the note
  // and no off/from/on within 3 tokens after the keyword
  assert.strictEqual(
    noteGroundingReason(
      gInput([gTrack("fillmore", "The marathon closer: 23:09 of Duane Allman trading licks with Dickey Betts")]),
      lookup
    ),
    null
  );
});

test("grounding FLAGS an exact clock inside the old ±30s window (9:19 vs shown 9:08)", () => {
  // the model sees the row's length, so a clock claim must copy it: ±5s
  const r = noteGroundingReason(
    gInput([gTrack("freebird", "All 9:19 on the expanded Pronounced album, and it earns the fade")]),
    lookup
  );
  assert.match(String(r), /"9:19"/);
  assert.match(String(r), /9:08/);
});

// ── makeGroundingGate: the composed per-run gate generateCard wires in ──

import { makeGroundingGate, SYSTEM } from "../curator.ts";

// a complete, otherwise-clean card whose track 1 carries the note under test
const BAD_NOTE =
  "A father's deathbed telegram turned into six aching minutes of Beirut's saddest brass";
const gateCard = (note: string) => ({
  title: "t",
  vibe: "v",
  accent: "ember",
  tracks: keyed(
    Array.from({ length: TRACK_COUNT }, (_, i) =>
      i === 0
        ? { ref: "nantes", artist: "Beirut", title: "Nantes", note }
        : { ref: "none", artist: `Artist ${i}`, title: `Title ${i}`, note: `a fine pick ${i}` }
    )
  ),
});

function withWarnCapture<T>(fn: () => T): { result: T; warns: string[] } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (msg: unknown) => {
    warns.push(String(msg));
  };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

test("gate: a violation bounces with the load-bearing 'grounding: ' prefix", () => {
  const gate = makeGroundingGate({ hard: cardIncompleteReason, lookup });
  assert.match(String(gate(gateCard(BAD_NOTE), { lastTurn: false })), /^grounding: /);
  // and a clean card passes straight through
  assert.strictEqual(
    gate(gateCard("Brass that swells like a tide coming in"), { lastTurn: false }),
    null
  );
});

test("gate: third violation is accepted and warned — and a NEW gate starts fresh", () => {
  const gate = makeGroundingGate({ hard: cardIncompleteReason, lookup });
  assert.match(String(gate(gateCard(BAD_NOTE), { lastTurn: false })), /^grounding: /);
  assert.match(String(gate(gateCard(BAD_NOTE), { lastTurn: false })), /^grounding: /);
  const third = withWarnCapture(() => gate(gateCard(BAD_NOTE), { lastTurn: false }));
  assert.strictEqual(third.result, null);
  assert.strictEqual(third.warns.length, 1);
  assert.match(third.warns[0]!, /grounding gate exhausted/);
  // per-run state: an exhausted gate must not bleed into the next run
  const fresh = makeGroundingGate({ hard: cardIncompleteReason, lookup });
  assert.match(String(fresh(gateCard(BAD_NOTE), { lastTurn: false })), /^grounding: /);
});

test("gate: the forced last turn accepts a grounding-only gap instead of killing the run", () => {
  const gate = makeGroundingGate({ hard: cardIncompleteReason, lookup });
  const { result, warns } = withWarnCapture(() => gate(gateCard(BAD_NOTE), { lastTurn: true }));
  assert.strictEqual(result, null);
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0]!, /out of turns/);
  // the leniency did not burn a bounce — a later normal turn still corrects
  assert.match(String(gate(gateCard(BAD_NOTE), { lastTurn: false })), /^grounding: /);
});

test("gate: hard incompleteness always wins — no cap, no last-turn leniency", () => {
  const gate = makeGroundingGate({ hard: cardIncompleteReason, lookup });
  const hollow = { title: "t", vibe: "v", accent: "ember", tracks: {} };
  assert.match(String(gate(hollow, { lastTurn: true })), /no tracks/);
  // exhaust the grounding cap; hard gaps must still reject
  gate(gateCard(BAD_NOTE), { lastTurn: false });
  gate(gateCard(BAD_NOTE), { lastTurn: false });
  assert.match(String(gate(hollow, { lastTurn: false })), /no tracks/);
});

test("layer-1 wording is pinned against drive-by reverts", () => {
  // the grounding rules live in prose the schema can't carry — a silent
  // revert of either string reopens the 24% invented-note baseline
  assert.ok(SYSTEM.includes("stake the whole tape"));
  assert.ok(SYSTEM.includes("(artist, title, album, year, length, position)"));
  assert.ok(TRACK_SCHEMA.properties.note.description.includes("No unseen numbers"));
});

test("extractYears: canonical regex, bit-identical to the eval diagnostic's", () => {
  // evals/grounding.ts imports this exact function — selftest.ts asserts the
  // same boundaries there, so the two can only move together.
  assert.deepStrictEqual(extractYears("from 1971 to 2026, not 1799 or 20261"), ["1971", "2026"]);
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
