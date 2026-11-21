// The curator switch: only the exact value "lc" may move the live app off the
// hand-written agent, and an Anthropic failure must be recognised from either
// agent — or /healthz stays green through a dead key. And on a deployed host
// LangSmith tracing must not start from a stray variable: it would send every
// visitor's prompt and card to a third party.

import test from "node:test";
import assert from "node:assert";
import Anthropic from "@anthropic-ai/sdk";
import {
  whichCurator,
  loadCurator,
  fromAnthropic,
  tracingDecision,
  TRACING_VARS,
  TRACE_OPT_IN,
} from "../curatorSwitch.ts";
import type { Curator } from "../curatorSwitch.ts";

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

// The real loader is exercised only for the hand-written agent, which reads
// no .env on import. The LangChain curator imports env.ts (server/.env into
// process.env) and the LangChain packages, so every "langchain" test below
// hands in its own `env` and `load` — nothing here reads or changes the
// developer's real environment.
test("switch off loads the very module index.ts has always used", async () => {
  const env = { LANGSMITH_TRACING: "true" };
  const picked = await loadCurator("hand-written", { deployed: true, env, log: () => assert.fail("no log") });
  const direct = await import("../curator.ts");
  assert.equal(picked.generateCard, direct.generateCard);
  assert.equal(picked.adjustCard, direct.adjustCard);
  // nothing in the hand-written agent reads tracing variables: left alone
  assert.deepEqual(env, { LANGSMITH_TRACING: "true" });
});

const fakeCurator: Curator = {
  generateCard: async () => ({ title: "", vibe: "", accent: "", tracks: [] }),
  adjustCard: async () => ({ changes: [] }),
};

test("switch on asks for the LangChain curator and hands back its two calls", async () => {
  const asked: string[] = [];
  const picked = await loadCurator("langchain", {
    deployed: false,
    env: {},
    load: async (name) => (asked.push(name), fakeCurator),
  });
  assert.deepEqual(asked, ["langchain"]);
  assert.equal(picked.generateCard, fakeCurator.generateCard);
  assert.equal(picked.adjustCard, fakeCurator.adjustCard);
});

// ── the LangSmith tracing guard ──────────────────────────────

test("tracing: never set means nothing to do, deployed or not", () => {
  for (const deployed of [true, false]) {
    for (const env of [{}, { LANGSMITH_TRACING: "" }, { LANGSMITH_TRACE_VISITORS: "1" }]) {
      const d = tracingDecision(env, deployed);
      assert.equal(d.action, "nothing");
      assert.deepEqual(d.unset, []);
      assert.equal(d.log, null);
    }
  }
});

test("tracing: local is the developer's call — untouched and silent", () => {
  const d = tracingDecision({ LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true" }, false);
  assert.equal(d.action, "untouched");
  assert.deepEqual(d.unset, []);
  assert.equal(d.log, null);
});

test("tracing: deployed with no opt-in is forced off, each variable on its own", () => {
  for (const name of TRACING_VARS) {
    const d = tracingDecision({ [name]: "true" }, true);
    assert.equal(d.action, "forced-off", name);
    assert.deepEqual(d.unset, [name]);
    assert.match(d.log!, /^\[config\] LangSmith tracing forced OFF/);
    assert.ok(d.log!.includes(name) && d.log!.includes(TRACE_OPT_IN));
  }
});

test('tracing: any value counts as set — LangChain reads LANGCHAIN_TRACING="false" as on', () => {
  const d = tracingDecision({ LANGCHAIN_TRACING: "false", LANGSMITH_TRACING: "TRUE" }, true);
  assert.equal(d.action, "forced-off");
  assert.deepEqual(d.unset.sort(), ["LANGCHAIN_TRACING", "LANGSMITH_TRACING"]);
});

test("tracing: deployed with the explicit opt-in stays on, and says so", () => {
  const d = tracingDecision({ LANGSMITH_TRACING: "true", LANGSMITH_TRACE_VISITORS: "1" }, true);
  assert.equal(d.action, "opted-in");
  assert.deepEqual(d.unset, []);
  assert.match(d.log!, /^\[config\] LangSmith tracing is ON for visitors/);
});

test("tracing: only exactly 1 is consent", () => {
  for (const v of ["", "0", "true", "yes", "11"]) {
    const d = tracingDecision({ LANGSMITH_TRACING: "true", LANGSMITH_TRACE_VISITORS: v }, true);
    assert.equal(d.action, "forced-off", `LANGSMITH_TRACE_VISITORS=${JSON.stringify(v)}`);
  }
});

test("tracing: the list is the four names @langchain/core reads", async () => {
  // Read the installed package, so an upgrade that adds a name fails here
  // instead of quietly walking past the guard.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const core = path.join(import.meta.dirname, "..", "node_modules", "@langchain", "core", "dist");
  const src =
    fs.readFileSync(path.join(core, "utils", "callbacks.js"), "utf8") +
    fs.readFileSync(path.join(core, "callbacks", "manager.js"), "utf8");
  const found = new Set(src.match(/"LANG(?:SMITH|CHAIN)_TRACING[A-Z0-9_]*"/g)!.map((m) => m.slice(1, -1)));
  assert.deepEqual([...found].sort(), [...TRACING_VARS].sort());
});

test("loadCurator: on a deployed host the variables are gone BEFORE LangChain is imported", async () => {
  const env: Record<string, string | undefined> = {
    LANGSMITH_TRACING: "true",
    LANGCHAIN_TRACING_V2: "true",
    LANGSMITH_API_KEY: "k",
  };
  const logs: string[] = [];
  let seenAtImport: object | null = null;
  await loadCurator("langchain", {
    deployed: true,
    env,
    log: (l) => logs.push(l),
    load: async () => ((seenAtImport = { ...env }), fakeCurator),
  });
  assert.deepEqual(seenAtImport, { LANGSMITH_API_KEY: "k" });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /forced OFF/);
});

test("loadCurator: opt-in or local leaves the environment exactly as it was", async () => {
  for (const [deployed, extra, lines] of [
    [true, { LANGSMITH_TRACE_VISITORS: "1" }, 1],
    [false, {}, 0],
  ] as const) {
    const env = { LANGSMITH_TRACING: "true", ...extra };
    const before = { ...env };
    const logs: string[] = [];
    await loadCurator("langchain", { deployed, env, log: (l) => logs.push(l), load: async () => fakeCurator });
    assert.deepEqual(env, before);
    assert.equal(logs.length, lines);
  }
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
