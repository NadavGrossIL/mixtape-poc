// The wire card (wire.ts) accepts every card this server sends and gives it
// back unchanged, key order included; refuses the malformed ones; drops the
// fields a caller adds; and stays identical to the client's own declarations,
// to what resolution adds and to the accents the model may pick.

import test from "node:test";
import assert from "node:assert";
import { ACCENTS, WireCardSchema, WireTrackSchema } from "../wire.ts";
import type { Accent, WireCard, WireTrack } from "../wire.ts";
import { CURATOR_TOOL } from "../curator.ts";
import type { Track as CuratorTrack } from "../curator.ts";
import { adjustMessage, diffCards } from "../lc/cardDiff.ts";
import type * as spotify from "../spotify.ts";
import type {
  Accent as ClientAccent,
  MixCard as ClientCard,
  Track as ClientTrack,
} from "../../client/src/types.ts";

// ── the types, checked by the gate's typecheck ──

// true only when A and B are the same type (not merely assignable).
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// The client declares the card itself (it cannot import zod at build time).
const clientTrackIsWire: Equals<ClientTrack, WireTrack> = true;
const clientCardIsWire: Equals<ClientCard, WireCard> = true;
const clientAccentIsWire: Equals<ClientAccent, Accent> = true;

// What resolution returns for a curated track is a wire track, and carries
// no field the schema would drop. ResolvedFields is private to spotify.ts, so
// it is read off resolveTracks' return type.
type Resolved = Awaited<
  ReturnType<typeof spotify.resolveTracks<{ ref?: string; artist: string; title: string; note: string }>>
>[number];
const resolvedIsWire: Resolved extends WireTrack ? true : false = true;
const resolvedAddsNothingUnknown: Equals<Exclude<keyof Resolved, keyof WireTrack>, never> = true;

// A wire track is a curator track (the curator's adjust takes the parsed card).
const wireIsCuratorTrack: WireTrack extends CuratorTrack ? true : false = true;

test("the client's card types, resolution's output and the curator's track agree with wire.ts", () => {
  assert.ok(clientTrackIsWire && clientCardIsWire && clientAccentIsWire);
  assert.ok(resolvedIsWire && resolvedAddsNothingUnknown && wireIsCuratorTrack);
});

test("the accents the model may pick are ACCENTS", () => {
  assert.deepStrictEqual(CURATOR_TOOL.input_schema.properties.accent.enum, [...ACCENTS]);
});

// ── fixtures ──

// From a live "done" event (two of its eight tracks), keys in the order the
// server wrote them.
const realCard = () => ({
  title: "Rainy Sunday Soul Pour",
  vibe: "For slow mornings, dripping windows, and a cup that never needs refilling.",
  accent: "rust",
  tracks: [
    {
      ref: "0bRXwKfigvpKZUurwqAlEh",
      artist: "Bill Withers",
      title: "Lovely Day",
      note: "Opens Menagerie with that sustained note that feels like sunlight through fog.",
      resolved: true,
      spotifyUrl: "https://open.spotify.com/track/0bRXwKfigvpKZUurwqAlEh",
      spotifyUri: "spotify:track:0bRXwKfigvpKZUurwqAlEh",
      albumArt: "https://i.scdn.co/image/ab67616d0000485167c1113f55ab816ef61d3993",
      matchedName: "Bill Withers — Lovely Day",
      durationMs: 257157,
      year: 1977,
    },
    {
      ref: "1qfDfZAvrkSAFrAR2FTQDv",
      artist: "Bill Withers",
      title: "Grandma's Hands",
      note: "A two-minute front-porch hum off Just As I Am to let the last cup go cold.",
      resolved: true,
      spotifyUrl: "https://open.spotify.com/track/1qfDfZAvrkSAFrAR2FTQDv",
      spotifyUri: "spotify:track:1qfDfZAvrkSAFrAR2FTQDv",
      albumArt: "https://i.scdn.co/image/ab67616d00004851f64b9ea8a8a409c6af86134f",
      matchedName: "Bill Withers — Grandma's Hands",
      durationMs: 122534,
      year: 1971,
    },
  ],
  threadId: "3c2e20d2-ff15-4d6e-a6dc-1fc42a90ce2a",
  prompt: "rainy sunday morning, slow coffee, warm 70s soul",
});

// resolveTrack's miss: the curated fields plus resolved:false, nothing else.
const unresolved = (n: number) => ({
  ref: `ref${n}`,
  artist: `Artist ${n}`,
  title: `Title ${n}`,
  note: `Note ${n}`,
  resolved: false,
});

// Parse, and require the result to be the same card, key order included.
function roundTrips(card: unknown) {
  const parsed = WireCardSchema.safeParse(card);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  assert.deepStrictEqual(parsed.data, card);
  assert.equal(JSON.stringify(parsed.data), JSON.stringify(card));
}

// ── cards the server produces parse unchanged ──

test("a real card round-trips unchanged", () => {
  roundTrips(realCard());
});

test("a card with unresolved tracks round-trips unchanged", () => {
  roundTrips({ ...realCard(), tracks: [unresolved(1), realCard().tracks[0], unresolved(3)] });
});

test("a resolved track with no art, link, runtime or year round-trips", () => {
  const t = { ...unresolved(1), resolved: true, spotifyUrl: null, spotifyUri: "spotify:track:x", albumArt: null, matchedName: "A — T", durationMs: null, year: null };
  roundTrips({ ...realCard(), tracks: [t] });
});

test("a seeded card round-trips unchanged (seed is written after prompt)", () => {
  roundTrips({ ...realCard(), seed: { id: "37i9dQZF1DXcBWIGoYBM5M", name: "Today's Top Hits" } });
});

test("a seed-only card (empty prompt) round-trips", () => {
  roundTrips({ ...realCard(), prompt: "", seed: { id: "abc", name: "this playlist" } });
});

test("a card after a refine round-trips: reordered, one row swapped, a new thread", () => {
  const before = realCard();
  const [a, b] = before.tracks;
  // the adjust route's `merged`: { ...card, tracks, title, vibe, accent, prompt, threadId }
  const merged = {
    ...before,
    tracks: [b, { ...unresolved(9) }, a],
    title: "New Title",
    vibe: before.vibe,
    accent: "plum",
    prompt: before.prompt,
    threadId: "b1d3c0de-0000-4000-8000-000000000000",
  };
  roundTrips(merged);
});

test("older cards parse: no ref, no threadId, no prompt, no runtime or year, a retired accent", () => {
  roundTrips({
    title: "Old",
    vibe: "from before",
    accent: "teal",
    tracks: [
      { artist: "A", title: "T", note: "n", resolved: true, spotifyUrl: "https://open.spotify.com/track/1", spotifyUri: "spotify:track:1", albumArt: null, matchedName: "A — T" },
      { artist: "B", title: "U", note: "n", resolved: false },
    ],
  });
});

test("a card with no tracks parses (the route refuses it with its own message)", () => {
  assert.ok(WireCardSchema.safeParse({ ...realCard(), tracks: [] }).success);
});

// ── malformed cards are refused ──

test("refuses cards that are not cards", () => {
  for (const bad of [null, undefined, "card", 42, [], {}]) {
    assert.equal(WireCardSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("refuses tracks that are not an array", () => {
  const keyed = { track1: realCard().tracks[0] }; // the model's tool shape, not the wire's
  for (const tracks of [undefined, null, "x", keyed]) {
    assert.equal(WireCardSchema.safeParse({ ...realCard(), tracks }).success, false, JSON.stringify(tracks));
  }
});

test("refuses a track missing its artist, title or note", () => {
  for (const key of ["artist", "title", "note", "resolved"] as const) {
    const t: Record<string, unknown> = { ...unresolved(1) };
    delete t[key];
    assert.equal(WireCardSchema.safeParse({ ...realCard(), tracks: [t] }).success, false, key);
  }
});

test("refuses wrong types", () => {
  const card = realCard();
  const track = card.tracks[0];
  const bad: unknown[] = [
    { ...card, title: 5 },
    { ...card, vibe: null },
    { ...card, accent: ["rust"] },
    { ...card, threadId: 7 },
    { ...card, prompt: { text: "x" } },
    { ...card, seed: { id: "x" } },
    { ...card, seed: "x" },
    { ...card, tracks: [null] },
    { ...card, tracks: ["Bill Withers — Lovely Day"] },
    { ...card, tracks: [{ ...track, artist: 1 }] },
    { ...card, tracks: [{ ...track, resolved: "true" }] },
    { ...card, tracks: [{ ...track, durationMs: "257157" }] },
    { ...card, tracks: [{ ...track, year: "1977" }] },
    { ...card, tracks: [{ ...track, spotifyUri: 1 }] },
    { ...card, tracks: [{ ...track, ref: null }] },
  ];
  for (const b of bad) assert.equal(WireCardSchema.safeParse(b).success, false, JSON.stringify(b).slice(0, 120));
});

// ── unknown fields are dropped, not echoed ──

test("drops fields the caller added, at every level", () => {
  const card = realCard();
  const dirty = {
    ...card,
    admin: true,
    __proto_like: { x: 1 },
    seed: { id: "abc", name: "n", owner: "someone" },
    tracks: card.tracks.map((t) => ({ ...t, injected: "<script>" })),
  };
  const parsed = WireCardSchema.parse(dirty);
  assert.deepStrictEqual(parsed, { ...card, seed: { id: "abc", name: "n" } });
  assert.equal("admin" in parsed, false);
  assert.equal(parsed.tracks.some((t) => "injected" in t), false);
});

// ── what the model is sent does not change ──

test("adjustMessage and diffCards see the same card parsed as raw", () => {
  const [first] = realCard().tracks;
  assert.ok(first);
  const raw = { ...realCard(), tracks: [first, unresolved(2)] };
  const parsed = WireCardSchema.parse(raw);
  assert.equal(adjustMessage(parsed, "less piano"), adjustMessage(raw, "less piano"));
  const after = { ...raw, tracks: [unresolved(5), unresolved(2)] };
  assert.deepStrictEqual(diffCards(parsed, after), diffCards(raw, after));
  // a refine relies on these two surviving the parse
  assert.equal(parsed.threadId, raw.threadId);
  assert.equal(parsed.tracks[0]?.ref, raw.tracks[0]?.ref);
});

test("refuses a track whose link or art is not Spotify's own (a javascript: link would reach an <a href>)", () => {
  const track = { artist: "a", title: "t", note: "n", resolved: true };
  for (const bad of [
    { spotifyUrl: "javascript:alert(1)" },
    { spotifyUrl: "https://evil.example/track/1" },
    { spotifyUrl: "https://open.spotify.com.evil.example/track/1" },
    { albumArt: "javascript:alert(1)" },
    { albumArt: "https://evil.example/a.jpg" },
  ]) {
    assert.equal(WireTrackSchema.safeParse({ ...track, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(
    WireTrackSchema.safeParse({
      ...track,
      spotifyUrl: "https://open.spotify.com/track/0bRXwKfigvpKZUurwqAlEh",
      albumArt: "https://i.scdn.co/image/ab67616d00004851f64b9ea8a",
    }).success,
    true,
  );
});

// ── jam mode (specs/0006): `mode` is the card's last key, and only a jam card has it ──

test("a jam card round-trips with mode last, after seed", () => {
  const jam = { ...realCard(), seed: { id: "abc", name: "this playlist" }, mode: "jam" };
  roundTrips(jam);
  assert.equal(Object.keys(WireCardSchema.parse(jam)).at(-1), "mode");
  roundTrips({ ...realCard(), mode: "jam" });
  roundTrips({ ...realCard(), mode: "mix" });
});

test("a mode that is not mix or jam is refused", () => {
  for (const mode of ["other", "", 1, null]) {
    assert.equal(WireCardSchema.safeParse({ ...realCard(), mode }).success, false, JSON.stringify(mode));
  }
});

test("a mix card carries no mode key", () => {
  const parsed = WireCardSchema.parse(realCard());
  assert.equal("mode" in parsed, false);
});
