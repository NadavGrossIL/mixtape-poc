// The LangChain curator end to end, with a scripted model and a stand-in
// search — no Anthropic, no Spotify, no cost. What is pinned here are the
// things only a whole run shows: a delivery is handled once, a run that
// narrates is nudged, the round limit holds, a failed run leaves nothing in
// memory, and a thread is continued only by its owner and only so many times.

import test from "node:test";
import assert from "node:assert";
import { AIMessage, HumanMessage, fakeModel } from "langchain";

// Before the curator is imported. It loads server/.env, which never replaces
// a variable that is already set — so tracing is pinned off here (a test must
// not send anything to LangSmith), and the practice knobs are set ON to show
// that an imported curator ignores them.
for (const name of ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"]) {
  process.env[name] = "false";
}
process.env.LC_TEST_BOUNCE = "1";
process.env.LC_ROUND_LIMIT = "2";
process.env.LC_SEARCH_LIMIT = "1";

const { generateCard, adjustCard, _memory, MAX_ADJUSTS_PER_THREAD } = await import(
  "../lc/curator-lc.ts"
);

const DELIVER = "create_mixtape";
const SEARCH = "search_spotify";

// A card the check accepts. `note1` makes one card differ from another;
// "none" is the ref the grounding check skips.
const card = (note1 = "opens slow, brushed drums and a warm upright bass") => ({
  title: "Slow Coffee",
  vibe: "for a window with rain on it",
  accent: "ember",
  tracks: Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `track${i + 1}`,
      {
        ref: "none",
        artist: `Artist ${i + 1}`,
        title: `Song ${i + 1}`,
        note: i === 0 ? note1 : `a reason for song ${i + 1} to be here`,
      },
    ])
  ),
});
// The same card with a placeholder note: the completeness check sends it back.
const hollowCard = () => {
  const c = card() as any;
  c.tracks.track3.note = "TBD";
  return c;
};

let n = 0;
const call = (name: string, args: Record<string, any>) => ({ name, args, id: `call-${++n}`, type: "tool_call" as const });
const deliver = (c: Record<string, any> = card()) => call(DELIVER, c);
const search = (query = `query ${n}`) => call(SEARCH, { query });
const says = (...calls: ReturnType<typeof call>[]) =>
  new AIMessage({ id: `msg-${++n}`, content: "", tool_calls: calls });

// A scripted model that also remembers which tools each call was offered and
// with what options (the fake's own call log does not keep them).
function script(...turns: (AIMessage | Error)[]) {
  const model = fakeModel();
  for (const turn of turns) model.respond(turn);
  const offered: { names: string[]; options: any }[] = [];
  const bind = model.bindTools.bind(model);
  (model as any).bindTools = (tools: any[], options: any) => {
    offered.push({ names: tools.map((t) => t.name), options });
    return bind(tools);
  };
  return { model, offered };
}

// A stand-in for Spotify that counts what it was asked.
function catalog() {
  const queries: string[] = [];
  return {
    queries,
    search: async (query: string) => {
      queries.push(query);
      return { tracks: { items: [] } };
    },
  };
}

// The module's memory is shared by every test in this file, so each test
// uses its own owner and looks only at the threads it made.
let owners = 0;
const owner = () => `test:${++owners}`;
const threadsInMemory = () => new Set(Object.keys(_memory.storage));
const pagesFor = (threadId: string) =>
  (threadId in _memory.storage ? 1 : 0) +
  Object.keys(_memory.writes).filter((k) => k.includes(threadId)).length;
const commits = () => {
  const seen: [number, string | null][] = [];
  return { seen, onCommit: (attempt: number, gap: string | null) => void seen.push([attempt, gap]) };
};

test("a card accepted on the first delivery ends the run", async () => {
  const { model } = script(says(search("rainy sunday")), says(deliver()));
  const spotify = catalog();
  const { seen, onCommit } = commits();
  const made = await generateCard("rainy sunday", { model, search: spotify.search, owner: owner(), onCommit });
  assert.equal(made.title, "Slow Coffee");
  assert.equal(made.tracks.length, 8);
  assert.equal(made.tracks[0]!.artist, "Artist 1");
  assert.equal(typeof made.threadId, "string");
  assert.deepEqual(spotify.queries, ["rainy sunday"]);
  assert.equal(model.callCount, 2);
  // LC_TEST_BOUNCE is set in this process: a bounce would show as (1, "test: …").
  assert.deepEqual(seen, [[1, null]]);
});

test("a rejected card goes back to the model, and the next one is accepted", async () => {
  const { model } = script(says(deliver(hollowCard())), says(deliver()));
  const { seen, onCommit } = commits();
  const made = await generateCard("x", { model, search: catalog().search, owner: owner(), onCommit });
  assert.equal(made.tracks.length, 8);
  assert.equal(model.callCount, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]![0], 1);
  assert.match(seen[0]![1]!, /track 3 had a missing or placeholder/);
  assert.deepEqual(seen[1], [2, null]);
  // The model was told why, as a failed tool result.
  const sentBack = model.calls[1]!.messages.at(-1) as any;
  assert.match(String(sentBack.content), /The card was not accepted: track 3/);
});

test("a delivery and a search in one message: the card is accepted once, no extra round", async () => {
  for (const order of ["delivery first", "search first"]) {
    const calls = order === "delivery first" ? [deliver(), search()] : [search(), search(), deliver()];
    const { model } = script(says(...calls), says(deliver(card("never reached"))));
    const spotify = catalog();
    const { seen, onCommit } = commits();
    const before = threadsInMemory();
    const made = await generateCard("x", { model, search: spotify.search, owner: owner(), onCommit });
    assert.equal(made.title, "Slow Coffee", order);
    assert.equal(model.callCount, 1, `${order}: exactly one model call`);
    assert.deepEqual(seen, [[1, null]], order);
    assert.deepEqual(spotify.queries, [], `${order}: the searches next to an accepted card are not run`);
    // The thread is left readable: one clean page set, continued below.
    assert.equal(threadsInMemory().size, before.size + 1, order);
  }
});

test("a rejected delivery next to a search goes back to the model once", async () => {
  const { model } = script(says(search(), deliver(hollowCard())), says(deliver()));
  const { seen, onCommit } = commits();
  const made = await generateCard("x", { model, search: catalog().search, owner: owner(), onCommit });
  assert.equal(made.tracks.length, 8);
  assert.equal(model.callCount, 2);
  assert.deepEqual(seen.map(([attempt, gap]) => [attempt, gap === null]), [[1, false], [2, true]]);
});

test("a thread that held a mixed message can still be continued", async () => {
  const me = owner();
  const first = script(says(deliver(), search()));
  const made = await generateCard("x", { model: first.model, search: catalog().search, owner: me });
  const second = script(says(deliver(card("a warmer opener than before"))));
  const diff = await adjustCard(made, "warmer", { model: second.model, search: catalog().search, owner: me });
  assert.equal(diff.threadId, undefined, "same thread");
  assert.deepEqual(diff.changes.map((c) => c.index), [0]);
});

test("a turn in plain words is nudged, and the run then delivers", async () => {
  const { model } = script(
    says(search()),
    new AIMessage({ id: "words", content: "Here is your mixtape: eight songs for the rain." }),
    says(deliver())
  );
  const made = await generateCard("x", { model, search: catalog().search, owner: owner() });
  assert.equal(made.tracks.length, 8);
  assert.equal(model.callCount, 3);
  const nudge = model.calls[2]!.messages.at(-1)!;
  assert.ok(HumanMessage.isInstance(nudge));
  assert.match(nudge.text, /calling create_mixtape/);
});

test("a model that only ever talks stops at the round limit, not later", async () => {
  const words = Array.from({ length: 12 }, (_, i) => new AIMessage({ id: `talk-${i}`, content: "soon" }));
  const { model } = script(...words);
  await assert.rejects(
    generateCard("x", { model, search: catalog().search, owner: owner() }),
    /used all 8 rounds without finishing a card/
  );
  assert.equal(model.callCount, 8);
  // Seven nudges: none after the last round.
  const nudges = model.calls[7]!.messages.filter(
    (m) => HumanMessage.isInstance(m) && /calling create_mixtape/.test(m.text)
  );
  assert.equal(nudges.length, 7);
});

test("the last round offers only the delivery tool, and never forces it", async () => {
  const { model, offered } = script(...Array.from({ length: 7 }, () => says(search())), says(deliver()));
  const made = await generateCard("x", { model, search: catalog().search, owner: owner() });
  assert.equal(made.tracks.length, 8);
  assert.equal(offered.length, 8);
  // LC_ROUND_LIMIT=2 is set in this process: round 2 would be the last one.
  for (const round of offered.slice(0, 7)) assert.deepEqual(round.names.sort(), [DELIVER, SEARCH]);
  assert.deepEqual(offered[7]!.names, [DELIVER]);
  for (const round of offered) assert.equal(round.options?.tool_choice, undefined);
  assert.match(model.calls[7]!.messages[0]!.text, /This is the last round of this run/);
  assert.doesNotMatch(model.calls[6]!.messages[0]!.text, /last round/);
});

test("the model is sent exactly curator.ts's two tool definitions", async () => {
  // What the model reads about its tools is defined once, in curator.ts:
  // descriptions, the eight required track slots, `strict`, and
  // eager_input_streaming (without it all eight tracks arrive at once). This
  // pins that the LangChain tools pass those definitions through untouched —
  // formatStructuredToolToAnthropic is the very function ChatAnthropic uses
  // to build the request.
  const { SEARCH_TOOL, CURATOR_TOOL } = await import("../curator.ts");
  const { ChatAnthropic } = await import("@langchain/anthropic");
  const model = fakeModel();
  model.respond(says(deliver()));
  let bound: any[] = [];
  const bind = model.bindTools.bind(model);
  (model as any).bindTools = (tools: any[]) => ((bound = tools), bind(tools));
  await generateCard("x", { model, search: catalog().search, owner: owner() });
  const onTheWire = new ChatAnthropic({ apiKey: "test", model: "m" }).formatStructuredToolToAnthropic(bound);
  assert.deepEqual(onTheWire, [SEARCH_TOOL, CURATOR_TOOL]);
  assert.equal(CURATOR_TOOL.eager_input_streaming, true);
  assert.equal(CURATOR_TOOL.strict, true);
});

test("a run that never delivers fails with the round-limit error after 8 model calls", async () => {
  const { model } = script(...Array.from({ length: 12 }, () => says(search())));
  const spotify = catalog();
  await assert.rejects(
    generateCard("x", { model, search: spotify.search, owner: owner() }),
    /The curator used all 8 rounds without finishing a card\./
  );
  assert.equal(model.callCount, 8);
  // LC_SEARCH_LIMIT=1 is set in this process: it would have stopped these at 1.
  assert.equal(spotify.queries.length, 8);
});

test("a failed generate leaves no checkpoints behind", async () => {
  for (const turns of [
    Array.from({ length: 9 }, () => says(search())), // never delivers
    [says(search()), Object.assign(new Error("boom"), { status: 500 })], // dies mid-run
  ]) {
    const before = threadsInMemory();
    const writesBefore = Object.keys(_memory.writes).length;
    const { model } = script(...turns);
    await assert.rejects(generateCard("x", { model, search: catalog().search, owner: owner() }));
    assert.deepEqual(threadsInMemory(), before);
    assert.equal(Object.keys(_memory.writes).length, writesBefore);
  }
});

test("a visitor who leaves mid-search: the run stops and its thread is deleted", async () => {
  const before = threadsInMemory();
  const leaving = new AbortController();
  let release = () => {};
  const { model } = script(says(search()), says(deliver()));
  const run = generateCard("x", {
    model,
    owner: owner(),
    signal: leaving.signal,
    search: () =>
      new Promise((done) => {
        release = () => done({ tracks: { items: [] } });
        leaving.abort();
      }),
  });
  await assert.rejects(run);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(threadsInMemory(), before);
});

test("a failed adjust deletes the thread it ran on; the next adjust starts fresh", async () => {
  const me = owner();
  const made = await generateCard("x", { model: script(says(deliver())).model, search: catalog().search, owner: me });
  assert.ok(pagesFor(made.threadId!) > 0);

  const failing = script(Object.assign(new Error("boom"), { status: 500 }));
  await assert.rejects(adjustCard(made, "warmer", { model: failing.model, search: catalog().search, owner: me }));
  assert.equal(pagesFor(made.threadId!), 0);

  // And a failed adjust on a brand-new thread (the card's thread is gone now).
  const before = threadsInMemory();
  const again = script(Object.assign(new Error("boom"), { status: 500 }));
  await assert.rejects(adjustCard(made, "warmer", { model: again.model, search: catalog().search, owner: me }));
  assert.deepEqual(threadsInMemory(), before);

  const ok = script(says(deliver(card("a warmer opener than before"))));
  const diff = await adjustCard(made, "warmer", { model: ok.model, search: catalog().search, owner: me });
  assert.equal(typeof diff.threadId, "string");
  assert.notEqual(diff.threadId, made.threadId);
});

test("an adjust on its own thread continues it: the model sees the earlier conversation", async () => {
  const me = owner();
  const made = await generateCard("first prompt words", {
    model: script(says(search()), says(deliver())).model,
    search: catalog().search,
    owner: me,
  });
  const { model } = script(says(deliver(card("a warmer opener than before"))));
  const { seen, onCommit } = commits();
  const diff = await adjustCard(made, "warmer", { model, search: catalog().search, owner: me, onCommit });
  assert.equal(diff.threadId, undefined);
  assert.deepEqual(diff.changes.map((c) => c.index), [0]);
  assert.deepEqual(seen, [[1, null]]);
  assert.ok(model.calls[0]!.messages.some((m) => m.text.includes("first prompt words")));
});

test("an adjust that changes nothing is sent back", async () => {
  const me = owner();
  const made = await generateCard("x", { model: script(says(deliver())).model, search: catalog().search, owner: me });
  const { model } = script(says(deliver()), says(deliver(card("a warmer opener than before"))));
  const { seen, onCommit } = commits();
  const diff = await adjustCard(made, "warmer", { model, search: catalog().search, owner: me, onCommit });
  assert.match(seen[0]![1]!, /changed nothing/);
  assert.deepEqual(seen[1], [2, null]);
  assert.equal(diff.changes.length, 1);
});

test("an adjust on an unknown or someone else's thread starts a new one and says which", async () => {
  const alice = owner();
  const bob = owner();
  const made = await generateCard("alice's secret prompt", {
    model: script(says(deliver())).model,
    search: catalog().search,
    owner: alice,
  });

  for (const [who, sent] of [
    [bob, made], // knows the id, did not make the thread
    [alice, { ...made, threadId: crypto.randomUUID() }], // an id from before a restart
    [alice, { ...made, threadId: undefined }], // no id at all
  ] as const) {
    const { model } = script(says(deliver(card("a warmer opener than before"))));
    const diff = await adjustCard(sent, "warmer", { model, search: catalog().search, owner: who });
    assert.equal(typeof diff.threadId, "string");
    assert.notEqual(diff.threadId, sent.threadId);
    assert.ok(pagesFor(diff.threadId!) > 0, "the new thread is remembered");
    // Started from the card alone: nothing of the original conversation.
    assert.ok(!model.calls[0]!.messages.some((m) => m.text.includes("alice's secret prompt")));
  }
  assert.ok(pagesFor(made.threadId!) > 0, "alice's own thread is untouched");
});

test(`a thread is continued for ${MAX_ADJUSTS_PER_THREAD} adjusts, then replaced and deleted`, async () => {
  const me = owner();
  const made = await generateCard("x", { model: script(says(deliver())).model, search: catalog().search, owner: me });
  let current = made;
  for (let i = 1; i <= MAX_ADJUSTS_PER_THREAD; i++) {
    const next = card(`opener rewritten, take ${i}`);
    const diff = await adjustCard(current, "again", {
      model: script(says(deliver(next))).model,
      search: catalog().search,
      owner: me,
    });
    assert.equal(diff.threadId, undefined, `adjust ${i} stays on the thread`);
    current = { ...current, tracks: current.tracks.map((t, at) => (at === 0 ? { ...t, ...diff.changes[0]!.track } : t)) };
  }
  assert.ok(pagesFor(made.threadId!) > 0);

  const { model } = script(says(deliver(card("one adjust too many for the old thread"))));
  const diff = await adjustCard(current, "again", { model, search: catalog().search, owner: me });
  assert.equal(typeof diff.threadId, "string", "the next adjust moves to a new thread");
  assert.notEqual(diff.threadId, made.threadId);
  assert.equal(pagesFor(made.threadId!), 0, "the old thread's checkpoints are deleted");
  // Fresh from the card alone: system prompt and the one adjust message.
  assert.equal(model.calls[0]!.messages.length, 2);

  // The new thread starts its own count at zero.
  const after = await adjustCard({ ...current, threadId: diff.threadId }, "again", {
    model: script(says(deliver(card("and once more on the new thread")))).model,
    search: catalog().search,
    owner: me,
  });
  assert.equal(after.threadId, undefined);
});

test("a model failure reaches the caller marked as Anthropic's, with its status", async () => {
  const dead = Object.assign(
    new Error("401 invalid x-api-key\n\nTroubleshooting URL: https://docs.langchain.com/x\n"),
    { status: 401 }
  );
  const { model } = script(says(search()), dead);
  await assert.rejects(generateCard("x", { model, search: catalog().search, owner: owner() }), (err: any) => {
    assert.equal(err.fromAnthropic, true);
    assert.equal(err.status, 401);
    assert.equal(err.message, "401 invalid x-api-key");
    return true;
  });
});

test("Spotify's quota running out ends the run with that very error", async () => {
  const quota = Object.assign(new Error("Spotify quota exceeded"), { quotaExceeded: true });
  const { model } = script(says(search()), says(deliver()));
  const before = threadsInMemory();
  await assert.rejects(
    generateCard("x", { model, owner: owner(), search: async () => Promise.reject(quota) }),
    (err) => err === quota
  );
  assert.deepEqual(threadsInMemory(), before);
});
