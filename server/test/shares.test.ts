// Guards the share page's one rule — it shows only words this server's
// curator wrote, and only the tracks actually pressed — plus the link-preview
// rewrite (escaped, every tag) and the share-link helper the client uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  toShareCard,
  adjustedShareCard,
  cardForPress,
  makeTrustedCards,
  makeShares,
  withShareMeta,
  shareMeta,
} from "../shares.ts";
import { shareUrlFor, sharedIdFrom } from "../../client/src/share.ts";

const uri = (n: number) => `spotify:track:${String(n).padStart(22, "a")}`;
const track = (n: number, extra: Record<string, unknown> = {}) => ({
  artist: `Artist ${n}`,
  title: `Song ${n}`,
  note: `note ${n}`,
  resolved: true,
  spotifyUri: uri(n),
  spotifyUrl: `https://open.spotify.com/track/${n}`,
  albumArt: `https://i.scdn.co/image/${n}`,
  ...extra,
});
const card = (tracks = [track(1), track(2), track(3)]) => ({
  title: "Rain Tape",
  vibe: "wet streets",
  accent: "cobalt",
  prompt: "my secret prompt",
  threadId: "t-1",
  seed: { id: "s", name: "Private Seed" },
  tracks,
});

test("toShareCard keeps what the page shows and drops the prompt, seed and thread", () => {
  const s = toShareCard(card())!;
  assert.equal(s.title, "Rain Tape");
  assert.equal(s.tracks.length, 3);
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes("secret") && !raw.includes("Private Seed") && !raw.includes("t-1"));
});

test("toShareCard refuses links that aren't Spotify's", () => {
  const s = toShareCard(
    card([track(1, { spotifyUrl: "javascript:alert(1)", albumArt: "https://evil.example/x.png" })]),
  )!;
  assert.equal(s.tracks[0]!.spotifyUrl, null);
  assert.equal(s.tracks[0]!.albumArt, null);
  assert.equal(toShareCard({ title: "x", tracks: [] }), null);
  assert.equal(toShareCard("nope"), null);
});

test("a refine's copy takes unchanged tracks from the trusted parent, not the browser", () => {
  const parent = toShareCard(card())!;
  const sentBack = card([
    track(1, { note: "ATTACKER TEXT" }), // unchanged position, forged note
    track(9), // the curator's replacement
    track(3),
  ]);
  const next = adjustedShareCard(parent, sentBack, new Set([1]))!;
  assert.equal(next.tracks[0]!.note, "note 1");
  assert.equal(next.tracks[1]!.title, "Song 9");
  assert.equal(adjustedShareCard(undefined, sentBack, new Set([1])), null);
  assert.equal(adjustedShareCard(parent, card([track(1)]), new Set()), null);
});

test("cardForPress needs the verified tracks to be exactly the pressed uris", () => {
  const s = toShareCard(card([track(1), track(2, { resolved: false, spotifyUri: null }), track(3)]))!;
  const pressed = cardForPress(s, [uri(1), uri(3)])!;
  assert.deepEqual(pressed.tracks.map((t) => t.title), ["Song 1", "Song 3"]);
  assert.equal(cardForPress(s, [uri(3), uri(1)]), null);
  assert.equal(cardForPress(s, [uri(1)]), null);
  assert.equal(cardForPress(undefined, [uri(1)]), null);
});

test("trusted cards are bounded, newest kept", () => {
  const t = makeTrustedCards(2);
  const s = toShareCard(card())!;
  t.add("a", s);
  t.add("b", s);
  t.add("a", s); // refreshed
  t.add("c", s);
  t.add("d", null); // ignored
  assert.ok(t.get("a") && t.get("c") && !t.get("b") && !t.get("d"));
});

test("shares persist per playlist and refuse ids that aren't Spotify's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixtape-shares-"));
  try {
    const shares = makeShares({ dir });
    const id = "A".repeat(22);
    shares.record(id, toShareCard(card())!);
    assert.equal(makeShares({ dir }).get(id)!.title, "Rain Tape");
    shares.record("../../etc/passwd", toShareCard(card())!);
    assert.equal(shares.get("../../etc/passwd"), null);
    assert.deepEqual(fs.readdirSync(path.join(dir, "shares")), [`${id}.json`]);
    fs.writeFileSync(path.join(dir, "shares", `${id}.json`), "{broken");
    assert.equal(shares.get(id), null);
    shares.remove(id);
    assert.equal(shares.get(id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the preview rewrite escapes and hits every tag", () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "../../client/index.html"), "utf8");
  const meta = shareMeta({ title: `Tape "<b>"`, vibe: "a & b", tracks: [track(1), track(1), track(2)] });
  const out = withShareMeta(html, meta, "https://x.test/m/abc");
  assert.ok(!out.includes("<b>"));
  assert.ok(out.includes("<title>Tape &quot;&lt;b&gt;&quot; — a Mixtape</title>"));
  assert.equal(out.match(/Tape &quot;&lt;b&gt;&quot; — a Mixtape/g)!.length, 3); // title, og, twitter
  assert.equal(out.match(/a &amp; b/g)!.length, 3); // description, og, twitter
  assert.ok(out.includes('content="https://x.test/m/abc"'));
  assert.ok(meta.description.includes("Artist 1, Artist 2 and more"));
});

test("the share link is /m/<id> on this site, from a Spotify playlist url", () => {
  const id = "B".repeat(22);
  assert.equal(shareUrlFor(`https://open.spotify.com/playlist/${id}?si=x`, "https://mix.test"), `https://mix.test/m/${id}`);
  // anything else falls back to the link it was given
  assert.equal(shareUrlFor("https://open.spotify.com/album/x", "https://mix.test"), "https://open.spotify.com/album/x");
  assert.equal(sharedIdFrom(`/m/${id}`), id);
  assert.equal(sharedIdFrom(`/m/${id}/`), id);
  assert.equal(sharedIdFrom("/m/short"), null);
  assert.equal(sharedIdFrom("/"), null);
});
