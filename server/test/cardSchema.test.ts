// The eight-track guarantee lives in the schema, not the prompt (ADR 0001).
// A strict tool schema ignores minItems, so with `tracks` as an array the
// model closed the card after one track 6 times in 10 live runs. As eight
// required object keys the grammar cannot close the call early.
//
// lcCurator.test.ts pins that LangChain sends CURATOR_TOOL to the model
// untouched; this pins CURATOR_TOOL itself, so turning `tracks` back into an
// array (or dropping `strict` or a required slot) fails CI instead of
// silently reopening the one-track card. The keys are spelled out on purpose:
// changing TRACK_COUNT should fail here too.

import test from "node:test";
import assert from "node:assert";
import { CURATOR_TOOL } from "../curator.ts";

const EIGHT = ["track1", "track2", "track3", "track4", "track5", "track6", "track7", "track8"];

test("create_mixtape is strict, so the grammar enforces its required keys", () => {
  assert.strictEqual(CURATOR_TOOL.strict, true);
  assert.ok(CURATOR_TOOL.input_schema.required.includes("tracks"));
});

test("tracks is an object with exactly track1…track8 required, not an array", () => {
  const tracks = CURATOR_TOOL.input_schema.properties.tracks;
  assert.strictEqual(tracks.type, "object");
  assert.strictEqual(tracks.additionalProperties, false);
  assert.deepStrictEqual([...tracks.required], EIGHT);
  assert.deepStrictEqual(Object.keys(tracks.properties), EIGHT);
});
