// One search on the LangChain curator must follow the app's quota rules: a
// cached search is free, a live one is charged to BOTH budgets or to neither,
// no more than N leave at once, and a spent daily quota stops the run.

import test from "node:test";
import assert from "node:assert";
import { makeLimiter, makeSearchStep } from "../lc/searchStep.ts";
import { makeSearchBudget } from "../searchBudget.ts";

function setup({ cached = [] as string[], loop = 20, request = 30, maxCached = undefined as number | undefined, search = async (q: string) => [{ ref: q }] } = {}) {
  const calls: string[] = [];
  const fatal: unknown[] = [];
  const budgets = { loop: makeSearchBudget(loop), request: makeSearchBudget(request) };
  const step = makeSearchStep({
    isCached: (q) => cached.includes(q),
    search: async (q) => {
      calls.push(q);
      return search(q);
    },
    ...budgets,
    concurrency: 2,
    onFatal: (err) => fatal.push(err),
    maxCached,
  });
  return { step, calls, fatal, ...budgets };
}

test("a live search is charged to both budgets and comes back fenced", async () => {
  const s = setup();
  const out = await s.step("nick drake");
  assert.match(out, /<catalog_results>/);
  assert.match(out, /nick drake/);
  assert.equal(s.loop.spent(), 1);
  assert.equal(s.request.spent(), 1);
});

test("a cached search is free — and still answered when both budgets are empty", async () => {
  const s = setup({ cached: ["seen before"], loop: 0, request: 0 });
  const out = await s.step("seen before");
  assert.match(out, /<catalog_results>/);
  assert.equal(s.loop.spent(), 0);
  assert.equal(s.request.spent(), 0);
});

test("the run's own cap refuses the next live search and charges nothing", async () => {
  const s = setup({ loop: 2 });
  await s.step("a");
  await s.step("b");
  const out = await s.step("c");
  assert.match(out, /Search budget for this mixtape is used up \(2 searches\)/);
  assert.doesNotMatch(out, /own knowledge/, "a refusal must never invite made-up tracks");
  assert.deepEqual(s.calls, ["a", "b"], "the refused search never reached Spotify");
  assert.equal(s.request.spent(), 2);
});

test("the request-wide allowance refuses too, without charging the run's cap", async () => {
  const s = setup({ request: 1 });
  await s.step("a");
  const out = await s.step("b");
  assert.match(out, /used up/);
  assert.equal(s.loop.spent(), 1, "a refused search must not leak the run's cap");
  assert.deepEqual(s.calls, ["a"]);
});

test("a passing Spotify failure is told to the model; the run goes on", async () => {
  const s = setup({
    search: async () => {
      throw new Error("Spotify API 502");
    },
  });
  const out = await s.step("a");
  assert.match(out, /unavailable right now/);
  assert.equal(s.fatal.length, 0);
});

test("a spent daily quota is fatal: reported and thrown", async () => {
  const quota = Object.assign(new Error("daily quota"), { quotaExceeded: true });
  const s = setup({
    search: async () => {
      throw quota;
    },
  });
  await assert.rejects(s.step("a"), /daily quota/);
  assert.deepEqual(s.fatal, [quota]);
});

test("no more than two searches are out at once, and all of them finish", async () => {
  let out = 0;
  let peak = 0;
  const s = setup({
    search: async (q) => {
      peak = Math.max(peak, ++out);
      await new Promise((r) => setTimeout(r, 5));
      out--;
      return [{ ref: q }];
    },
  });
  await Promise.all(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((q) => s.step(q)));
  assert.equal(peak, 2);
  assert.equal(s.calls.length, 9);
});

test("makeLimiter: a failed job frees its place", async () => {
  const limit = makeLimiter(1);
  await assert.rejects(limit(async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await limit(async () => "next"), "next");
});

test("cached searches are capped per run, so a prompt can't loop the model on free repeats", async () => {
  const s = setup({ cached: ["again"], maxCached: 3 });
  for (let i = 0; i < 3; i++) assert.match(await s.step("again"), /<catalog_results>/);
  const out = await s.step("again");
  assert.doesNotMatch(out, /<catalog_results>/, "the 4th repeat gets no results fed back");
  assert.match(out, /Commit now/);
  assert.doesNotMatch(out, /own knowledge/, "a refusal must never invite made-up tracks");
  assert.equal(s.loop.spent(), 0, "the cap on repeats never touches the Spotify budgets");
  // a live search still goes through
  assert.match(await s.step("fresh"), /<catalog_results>/);
});
