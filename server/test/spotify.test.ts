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

// ── classify429 ──────────────────────────────────────────────
//
// The bug this guards: Spotify's 429 covers two different mechanisms, and
// treating the daily quota as a rate limit made the server sleep 30s and retry
// into a lockout that had 19 HOURS left on it.

import {
  classify429,
  MAX_RETRY_WAIT,
  DEFAULT_QUOTA_COOLDOWN,
  rank,
  better,
  trimItem,
  formatDuration,
  rememberItems,
  recallByTitle,
  MATCH_THRESHOLD,
} from "../spotify.ts";

const QUOTA_BODY =
  '{"error":{"status":429,"message":"Too many requests","reason":"QUOTA_EXCEEDED"}}';
const RATE_BODY = '{"error":{"status":429,"message":"Too many requests"}}';

test("classify429: the real observed lockout is quota, and never retried", () => {
  // verbatim from the live 429 that started this: 69,785s = 19.4h
  const v = classify429(QUOTA_BODY, "69785");
  assert.strictEqual(v.quota, true);
  assert.strictEqual(v.cooldown, 69785);
  assert.strictEqual(v.wait, 0); // the whole point — no sleep-and-retry
});

test("classify429: quota with no Retry-After falls back to a long cooldown", () => {
  // reported in the wild: quota 429s that omit the header entirely
  const v = classify429(QUOTA_BODY, null);
  assert.strictEqual(v.quota, true);
  assert.strictEqual(v.cooldown, DEFAULT_QUOTA_COOLDOWN);
  assert.ok(v.cooldown > MAX_RETRY_WAIT * 10, "must not be a seconds-scale wait");
});

test("classify429: a plain rate limit still retries, capped at MAX_RETRY_WAIT", () => {
  const v = classify429(RATE_BODY, "5");
  assert.strictEqual(v.quota, false);
  assert.strictEqual(v.wait, 5);
  assert.strictEqual(v.cooldown, 0);
  // missing header → a short default, not zero (zero would hot-loop)
  assert.strictEqual(classify429(RATE_BODY, null).wait, 1);
  assert.strictEqual(classify429(RATE_BODY, "0").wait, 1);
});

test("classify429: a long Retry-After is quota even without the marker", () => {
  // older responses predate the reason field; no rolling window asks for 10min
  const v = classify429(RATE_BODY, "600");
  assert.strictEqual(v.quota, true);
  assert.strictEqual(v.cooldown, 600);
  // and the boundary stays a retry
  assert.strictEqual(classify429(RATE_BODY, String(MAX_RETRY_WAIT)).quota, false);
  assert.strictEqual(classify429(RATE_BODY, String(MAX_RETRY_WAIT + 1)).quota, true);
});

test("formatDuration: hours read as hours, not 69785s", () => {
  assert.strictEqual(formatDuration(69785), "19.4h");
  assert.strictEqual(formatDuration(30), "30s");
  assert.strictEqual(formatDuration(600), "10m");
});

// ── rank / better ────────────────────────────────────────────

const ADELE_HELLO = {
  name: "Hello",
  uri: "spotify:track:adele",
  artists: [{ name: "Adele" }],
};
const KARAOKE_HELLO = {
  name: "Hello",
  uri: "spotify:track:karaoke",
  artists: [{ name: "Karaoke All Stars" }],
};

test("rank: the artist floor still gates, and bestAny records the near-miss", () => {
  const r = rank([KARAOKE_HELLO], { artist: "Adele", title: "Hello" }, "field");
  assert.strictEqual(r.best, null); // floor rejected it
  assert.ok(r.bestAny); // but it is remembered for honest logging
  assert.strictEqual(r.bestAny!.item.uri, "spotify:track:karaoke");
});

test("rank: picks the highest scorer that clears the floor", () => {
  const r = rank(
    [KARAOKE_HELLO, ADELE_HELLO],
    { artist: "Adele", title: "Hello" },
    "field"
  );
  assert.strictEqual(r.best!.item.uri, "spotify:track:adele");
  assert.strictEqual(r.best!.score, 1);
  assert.strictEqual(r.best!.strategy, "field");
});

test("better: keeps the higher score, tolerates nulls on either side", () => {
  const lo = { item: ADELE_HELLO, score: 0.4, strategy: "a" };
  const hi = { item: ADELE_HELLO, score: 0.9, strategy: "b" };
  assert.strictEqual(better(lo, hi), hi);
  assert.strictEqual(better(hi, lo), hi);
  assert.strictEqual(better(null, lo), lo);
  assert.strictEqual(better(lo, null), lo);
  assert.strictEqual(better(null, null), null);
});

// ── the memory path (what actually saves the quota) ──────────
//
// The curator agent searches every track to verify it, then resolution used to
// search THE SAME TRACK AGAIN under a different query shape — at least 8 wasted
// requests per run. Indexing the records themselves lets the second lookup be
// free. These use invented titles so a real .search-cache.json can't collide.

test("recallByTitle: a remembered record is found under a differently-spelled title", () => {
  const item = {
    name: "Zzyzx Roadtrip (Remastered 2011)",
    uri: "spotify:track:zzyzx1",
    artists: [{ name: "Testcase Quartet" }],
  };
  rememberItems([item]);
  // parenthetical dropped, case and punctuation normalized — still a hit
  const found = recallByTitle("zzyzx roadtrip");
  assert.ok(found.some((i: any) => i.uri === "spotify:track:zzyzx1"));
});

test("recall + rank clears the gate for the exact-spelling case the agent produces", () => {
  const item = {
    name: "Qwertyon Nightdrive",
    uri: "spotify:track:qwerty1",
    artists: [{ name: "Testcase Quartet" }],
  };
  rememberItems([item]);
  const r = rank(
    recallByTitle("Qwertyon Nightdrive"),
    { artist: "Testcase Quartet", title: "Qwertyon Nightdrive" },
    "memory"
  );
  assert.ok(r.best, "should resolve from memory with zero requests");
  assert.ok(r.best!.score >= MATCH_THRESHOLD);
});

test("memory does NOT weaken the hallucination gate: wrong artist still fails", () => {
  rememberItems([
    {
      name: "Vraxil Overture",
      uri: "spotify:track:vraxil1",
      artists: [{ name: "Some Other Band" }],
    },
  ]);
  const r = rank(
    recallByTitle("Vraxil Overture"),
    { artist: "Testcase Quartet", title: "Vraxil Overture" },
    "memory"
  );
  // perfect title, wrong artist — must not resolve, exactly as with a live search
  assert.strictEqual(r.best, null);
});

test("rememberItems: same track twice is stored once", () => {
  const item = {
    name: "Plimth Cascade",
    uri: "spotify:track:plimth1",
    artists: [{ name: "Testcase Quartet" }],
  };
  rememberItems([item]);
  rememberItems([{ ...item }]);
  const found = recallByTitle("Plimth Cascade").filter(
    (i: any) => i.uri === "spotify:track:plimth1"
  );
  assert.strictEqual(found.length, 1);
});

// ── trimItem ─────────────────────────────────────────────────

test("trimItem: keeps every field the resolver, card and grounding gate read, drops the rest", () => {
  const trimmed = trimItem({
    name: "Hello",
    uri: "spotify:track:adele",
    artists: [{ name: "Adele" }],
    external_urls: { spotify: "https://open.spotify.com/track/x" },
    duration_ms: 295502,
    track_number: 1,
    external_ids: { isrc: "GBBKS1500213" },
    album: {
      name: "25",
      release_date: "2015-11-20",
      album_type: "album",
      total_tracks: 11,
      images: [{ url: "big" }, { url: "mid" }, { url: "small" }],
    },
    // fields the cache has no reason to persist
    disc_number: 1,
    preview_url: null,
  });
  assert.strictEqual(trimmed.name, "Hello");
  assert.strictEqual(trimmed.uri, "spotify:track:adele");
  assert.deepStrictEqual(trimmed.artists, [{ name: "Adele" }]);
  assert.strictEqual(trimmed.external_urls.spotify, "https://open.spotify.com/track/x");
  assert.strictEqual(trimmed.duration_ms, 295502);
  assert.strictEqual(trimmed.isrc, "GBBKS1500213");
  assert.strictEqual(trimmed.track_number, 1);
  assert.strictEqual(trimmed.album.release_date, "2015-11-20");
  assert.strictEqual(trimmed.album.album_type, "album");
  assert.strictEqual(trimmed.album.total_tracks, 11);
  // only the smallest image survives — the one resolveTrack picks
  assert.deepStrictEqual(trimmed.album.images, [{ url: "small" }]);
  assert.ok(!("disc_number" in trimmed));
});

test("trimItem: survives the sparse objects Spotify actually returns", () => {
  const trimmed = trimItem({ name: "X", uri: "spotify:track:x" });
  assert.deepStrictEqual(trimmed.artists, []);
  assert.deepStrictEqual(trimmed.album.images, []);
  assert.strictEqual(trimmed.external_urls.spotify, null);
  // the expanded fields must be EXPLICIT nulls, matching what consumers see
  // on cache entries written before the expansion
  assert.strictEqual(trimmed.duration_ms, null);
  assert.strictEqual(trimmed.isrc, null);
  assert.strictEqual(trimmed.track_number, null);
  assert.strictEqual(trimmed.album.album_type, null);
  assert.strictEqual(trimmed.album.total_tracks, null);
});

// ── catalogRow / formatClock: what the model is shown per search row ─────

import { catalogRow, formatClock } from "../spotify.ts";

test("formatClock: M:SS with zero-padded seconds", () => {
  assert.strictEqual(formatClock(248000), "4:08");
  assert.strictEqual(formatClock(137000), "2:17");
  assert.strictEqual(formatClock(60000), "1:00");
  assert.strictEqual(formatClock(548000), "9:08");
});

test("catalogRow: shows length when duration_ms is present", () => {
  const row = catalogRow({
    name: "Nantes",
    uri: "spotify:track:nantes1",
    artists: [{ name: "Beirut" }],
    duration_ms: 248000,
    album: { name: "The Flying Club Cup", release_date: "2007-10-09" },
  });
  assert.strictEqual(row.ref, "nantes1");
  assert.strictEqual(row.artist, "Beirut");
  assert.strictEqual(row.album, "The Flying Club Cup");
  assert.strictEqual(row.year, "2007");
  assert.strictEqual(row.length, "4:08");
});

test("catalogRow: OMITS length on stale cache rows — never shows null", () => {
  // a literal "length": null is a value the model could parrot into a note
  const row = catalogRow({
    name: "Old Row",
    uri: "spotify:track:old1",
    artists: [{ name: "A" }],
    duration_ms: null,
    album: { name: "X", release_date: "1999-01-01" },
  });
  assert.ok(!("length" in row));
  assert.ok(!("length" in catalogRow({ name: "Y", uri: "spotify:track:y1" })));
});

// ── refs: resolution without a second search ─────────────────
//
// The model quotes back the `ref` of the search row it verified, so resolution
// is a lookup instead of a fuzzy re-search. This is a STRONGER gate than a
// score — an invented track cannot produce a ref the server fetched — but it
// introduces one new failure mode (quoting the wrong row), which is what most
// of these tests are about.

import {
  refOf,
  verifyRef,
  recallByRef,
  isFresh,
  NEGATIVE_TTL_MS,
  CACHE_TTL_MS,
  MEMORY_ACCEPT_THRESHOLD,
} from "../spotify.ts";

test("refOf: the id half of a track uri, empty for junk", () => {
  assert.strictEqual(refOf({ uri: "spotify:track:6rqhFgbbKwnb9MLmUQDhG6" }), "6rqhFgbbKwnb9MLmUQDhG6");
  assert.strictEqual(refOf({}), "");
  assert.strictEqual(refOf(null), "");
});

const REF_ITEM = {
  name: "Grulm Anthem",
  uri: "spotify:track:refTestGrulm001",
  artists: [{ name: "Testcase Quartet" }],
};

test("verifyRef: a quoted ref resolves the exact record, no search", () => {
  rememberItems([REF_ITEM]);
  assert.ok(recallByRef("refTestGrulm001"));
  const v = verifyRef("refTestGrulm001", {
    artist: "Testcase Quartet",
    title: "Grulm Anthem",
  });
  assert.ok(v);
  assert.strictEqual(v!.item.uri, "spotify:track:refTestGrulm001");
});

test("verifyRef: quoting the WRONG row is rejected, not trusted", () => {
  // the new failure mode: model verified one record but wrote down another.
  // Trusting the ref blindly here would resolve a track to a record that isn't
  // it — worse than the fuzzy search it replaces.
  rememberItems([REF_ITEM]);
  const v = verifyRef("refTestGrulm001", {
    artist: "Completely Different Band",
    title: "Some Other Song",
  });
  assert.strictEqual(v, null);
});

test("verifyRef: unknown, missing and sentinel refs fall through to search", () => {
  assert.strictEqual(verifyRef("nosuchref999", { artist: "A", title: "B" }), null);
  assert.strictEqual(verifyRef("none", { artist: "A", title: "B" }), null);
  assert.strictEqual(verifyRef(undefined, { artist: "A", title: "B" }), null);
  assert.strictEqual(verifyRef("", { artist: "A", title: "B" }), null);
});

test("verifyRef: an invented ref cannot resolve a hallucinated track", () => {
  // the property that matters: refs are only ever minted from records the
  // server itself fetched, so there is nothing to guess.
  const v = verifyRef("4cOdK2wGLETKBW3PvgPWqT", {
    artist: "Fake Band That Does Not Exist",
    title: "Song That Was Never Recorded",
  });
  assert.strictEqual(v, null);
});

test("memory accept bar is stricter than the live-search threshold", () => {
  // a grazing memory match must not permanently block a better live search
  assert.ok(MEMORY_ACCEPT_THRESHOLD > MATCH_THRESHOLD);
});

// ── negative-result TTL ──────────────────────────────────────

test("isFresh: empty results expire far sooner than real ones", () => {
  const now = Date.now();
  const twoHours = now - 2 * 60 * 60 * 1000;
  // a real result two hours old is still good
  assert.strictEqual(isFresh({ items: [REF_ITEM], at: twoHours }), true);
  // an empty one is not — a malformed response must not poison a whole week
  assert.strictEqual(isFresh({ items: [], at: twoHours }), false);
  // but an empty one from a minute ago still saves the repeat request
  assert.strictEqual(isFresh({ items: [], at: now - 60_000 }), true);
  assert.ok(NEGATIVE_TTL_MS < CACHE_TTL_MS);
});

test("isFresh: missing and expired entries are not fresh", () => {
  assert.strictEqual(isFresh(undefined), false);
  assert.strictEqual(isFresh({ items: [REF_ITEM], at: Date.now() - CACHE_TTL_MS - 1 }), false);
});
