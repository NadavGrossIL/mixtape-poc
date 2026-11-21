// The curator switch: only the exact value "lc" may move the live app off the
// hand-written agent, and an Anthropic failure must be recognised from either
// agent — or /healthz stays green through a dead key.

import test from "node:test";
import assert from "node:assert";
import Anthropic from "@anthropic-ai/sdk";
import { whichCurator, loadCurator, fromAnthropic } from "../curatorSwitch.ts";

test("off by default: unset, empty or a typo is the hand-written agent", () => {
  for (const CURATOR of [undefined, "", "langchain", "true", "1", "lcc", "hand-written"]) {
    assert.equal(whichCurator({ CURATOR }), "hand-written", `CURATOR=${CURATOR}`);
  }
});

test("CURATOR=lc turns the LangChain curator on, whatever the case or spacing", () => {
  for (const CURATOR of ["lc", "LC", " lc "]) {
    assert.equal(whichCurator({ CURATOR }), "langchain", `CURATOR=${JSON.stringify(CURATOR)}`);
  }
});

test("switch off loads the very module index.ts has always used", async () => {
  const picked = await loadCurator("hand-written");
  const direct = await import("../curator.ts");
  assert.equal(picked.generateCard, direct.generateCard);
  assert.equal(picked.adjustCard, direct.adjustCard);
});

test("switch on loads a curator with the same two calls", async () => {
  const picked = await loadCurator("langchain");
  assert.equal(typeof picked.generateCard, "function");
  assert.equal(typeof picked.adjustCard, "function");
});

test("fromAnthropic: the SDK's own error, or one the LangChain curator marked", () => {
  const sdkError = new Anthropic.APIError(401, undefined, "bad key", undefined as any);
  assert.equal(fromAnthropic(sdkError), true);
  assert.equal(fromAnthropic(Object.assign(new Error("x"), { status: 401, fromAnthropic: true })), true);
});

test("fromAnthropic: a status alone is not enough — Spotify errors carry one too", () => {
  assert.equal(fromAnthropic(Object.assign(new Error("Spotify API 502"), { status: 502 })), false);
  assert.equal(fromAnthropic(new Error("plain")), false);
  assert.equal(fromAnthropic(null), false);
  assert.equal(fromAnthropic("oops"), false);
});
