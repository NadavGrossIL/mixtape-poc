import { test } from "node:test";
import assert from "node:assert";
import { playlistDescription, DESCRIPTION_PREFIX, VIBE_MAX } from "../playlistDescription.ts";

const vibeOf = (d: string) => d.slice(`${DESCRIPTION_PREFIX} — “`.length, -1);

test("playlistDescription carries the vibe line after the Mixtape prefix", () => {
  assert.strictEqual(
    playlistDescription("For the long drive home, windows down."),
    "Made with Mixtape — “For the long drive home, windows down.”"
  );
});

test("no vibe falls back to the old description", () => {
  for (const v of [undefined, null, "", "   ", "“”", 42, { x: 1 }]) {
    assert.strictEqual(playlistDescription(v), "Made with Mixtape.");
  }
});

test("every description starts with the prefix the playlist picker filters on", () => {
  for (const v of ["x", "", "a".repeat(1000)]) {
    assert.ok(playlistDescription(v).startsWith(DESCRIPTION_PREFIX));
  }
});

test("client-sent junk is tidied before it lands on a public profile", () => {
  assert.strictEqual(
    playlistDescription('  "late\n\tnight"  <b>neon</b> '),
    "Made with Mixtape — “late night b neon /b”"
  );
  // a right-to-left override and a zero-width space can't disguise the text
  assert.strictEqual(playlistDescription("ab‮cd​ef"), "Made with Mixtape — “ab cd ef”");
});

test("& and ' become characters Spotify's share previews don't double-escape", () => {
  assert.strictEqual(
    playlistDescription("Rock&roll for anyone who's ever sung along"),
    "Made with Mixtape — “Rock and roll for anyone who’s ever sung along”"
  );
});

test("a long vibe is capped in characters and keeps its closing quote", () => {
  const d = playlistDescription("a".repeat(1000));
  assert.strictEqual(vibeOf(d).length, VIBE_MAX);
  assert.ok(d.endsWith("”"));
  assert.ok(d.length <= 300, "inside Spotify's description limit");
});

test("the cap never cuts an emoji in half", () => {
  const d = playlistDescription("🎸".repeat(VIBE_MAX + 10));
  assert.strictEqual(Array.from(vibeOf(d)).length, VIBE_MAX);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(d));
});
