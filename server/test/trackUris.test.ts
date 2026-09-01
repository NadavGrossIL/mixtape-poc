// Nothing that is not a real Spotify track URI may reach the playlist write:
// the route forwards this array to the host account's library, so the parser
// has to reject the whole body rather than pass through whatever it recognises.

import test from "node:test";
import assert from "node:assert";
import { parseTrackUris, MAX_TRACK_URIS } from "../trackUris.ts";

const OK = "spotify:track:4cOdK2wGLETKBW3PvgPWqT";
const OK2 = "spotify:track:0eGsygTp906u18L0Oimnem";

test("a list of well-formed track URIs comes back unchanged", () => {
  assert.deepEqual(parseTrackUris([OK, OK2]), [OK, OK2]);
});

test("the 22-character id length is exact", () => {
  assert.equal(parseTrackUris(["spotify:track:" + "a".repeat(21)]), null, "too short");
  assert.equal(parseTrackUris(["spotify:track:" + "a".repeat(23)]), null, "too long");
  assert.deepEqual(parseTrackUris(["spotify:track:" + "a".repeat(22)]), [
    "spotify:track:" + "a".repeat(22),
  ]);
});

// Adversarial: the shapes a crafted body actually arrives in.
test("junk entries reject the whole array, they are not filtered out", () => {
  const junk: unknown[] = [
    "spotify:album:4cOdK2wGLETKBW3PvgPWqT", // right shape, wrong kind
    "spotify:playlist:4cOdK2wGLETKBW3PvgPWqT",
    "spotify:episode:4cOdK2wGLETKBW3PvgPWqT",
    "spotify:track:4cOdK2wGLETKBW3PvgPWq!", // id is base-62 only
    "spotify:track:4cOdK2wGLETKBW3PvgPWqT extra",
    " spotify:track:4cOdK2wGLETKBW3PvgPWqT", // no trimming on our behalf
    "spotify:track:4cOdK2wGLETKBW3PvgPWqT\nspotify:track:4cOdK2wGLETKBW3PvgPWqT",
    "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    "not-even-a-uri",
    "",
  ];
  for (const bad of junk) {
    assert.equal(parseTrackUris([bad]), null, `${JSON.stringify(bad)} must be refused`);
    assert.equal(
      parseTrackUris([OK, bad, OK2]),
      null,
      `${JSON.stringify(bad)} must poison the whole array, not be dropped`
    );
  }
});

test("non-string elements are refused, however URI-ish they look", () => {
  for (const bad of [
    null,
    undefined,
    42,
    true,
    {},
    [OK],
    { toString: () => OK },
    // a form-encoded body arrives as strings, but JSON can nest anything
    { uri: OK },
  ]) {
    assert.equal(parseTrackUris([bad]), null, `${String(bad)} must be refused`);
  }
});

test("a non-array is refused, including the array-like things a body can carry", () => {
  for (const bad of [undefined, null, "", OK, 8, {}, { length: 2, 0: OK, 1: OK2 }]) {
    assert.equal(parseTrackUris(bad), null);
  }
});

test("an empty array is refused — there is nothing to press", () => {
  assert.equal(parseTrackUris([]), null);
});

test("the array is capped at Spotify's own add-items maximum", () => {
  const at = Array.from({ length: MAX_TRACK_URIS }, () => OK);
  assert.equal(parseTrackUris(at)?.length, MAX_TRACK_URIS, "exactly the maximum is fine");
  assert.equal(parseTrackUris([...at, OK]), null, "one over is refused");
  assert.equal(parseTrackUris(Array.from({ length: 100_000 }, () => OK)), null);
});
