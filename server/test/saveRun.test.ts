// A save's state moves the way App's setters used to move it: a start clears
// the last error and stage, a success records the playlist, every failure
// (the no-verified-songs refusal too) bumps the tick so the alert scrolls
// again, the save's end clears the stage, and a reset forgets the playlist
// and the error but never the tick.

import test from "node:test";
import assert from "node:assert";
import { saveIdle, saveRun, type SaveState } from "../../client/src/saveRun.ts";

const saving = (over: Partial<SaveState> = {}): SaveState => ({ ...saveIdle, saving: true, ...over });

test("started clears the error and the stage", () => {
  const before: SaveState = {
    ...saveIdle,
    stage: "ADDING 8 SONGS…",
    error: { message: "Couldn't save it to Spotify. Try again.", booked: false },
    errorTick: 2,
  };
  assert.deepStrictEqual(saveRun(before, { type: "started" }), {
    ...saveIdle,
    saving: true,
    errorTick: 2,
  });
});

test("stage sets the label, and the same label twice is the same state", () => {
  const s = saveRun(saving(), { type: "stage", stage: "CREATING PLAYLIST…" });
  assert.strictEqual(s.stage, "CREATING PLAYLIST…");
  assert.strictEqual(saveRun(s, { type: "stage", stage: "CREATING PLAYLIST…" }), s);
});

test("succeeded sets the url and whether it is in the library", () => {
  const s = saveRun(saving(), { type: "succeeded", playlistUrl: "https://open.spotify.com/playlist/x", savedToLibrary: true });
  assert.strictEqual(s.playlistUrl, "https://open.spotify.com/playlist/x");
  assert.strictEqual(s.savedToLibrary, true);
  assert.strictEqual(s.saving, true); // until `finished`
});

test("failed sets the error and bumps the tick, even for the same line twice", () => {
  const error = { message: "No verified songs to save.", booked: false };
  const once = saveRun(saveIdle, { type: "failed", error });
  const twice = saveRun(once, { type: "failed", error });
  assert.deepStrictEqual(once.error, error);
  assert.strictEqual(once.errorTick, 1);
  assert.strictEqual(twice.errorTick, 2);
  assert.strictEqual(once.saving, false); // the refusal before any request
});

test("a cap refusal fails booked; a fault does not", () => {
  const cap = saveRun(saving(), {
    type: "failed",
    error: { message: "no more playlists can be saved today — come back tomorrow.", booked: true },
  });
  const fault = saveRun(saving(), {
    type: "failed",
    error: { message: "Couldn't save it to Spotify. Try again.", booked: false },
  });
  assert.strictEqual(cap.error?.booked, true);
  assert.strictEqual(fault.error?.booked, false);
});

test("finished clears saving and the stage but keeps the error and the playlist", () => {
  const error = { message: "x", booked: true };
  const before = saving({ stage: "ADDING 8 SONGS…", error, errorTick: 1, playlistUrl: "u", savedToLibrary: true });
  assert.deepStrictEqual(saveRun(before, { type: "finished" }), {
    saving: false,
    stage: null,
    playlistUrl: "u",
    savedToLibrary: true,
    error,
    errorTick: 1,
  });
});

test("reset forgets the playlist and the error, and keeps the tick", () => {
  const before: SaveState = {
    ...saveIdle,
    playlistUrl: "u",
    savedToLibrary: true,
    error: { message: "x", booked: true },
    errorTick: 3,
  };
  assert.deepStrictEqual(saveRun(before, { type: "reset" }), { ...saveIdle, errorTick: 3 });
});
