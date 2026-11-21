// Around each model call of the LangChain curator: the last round must leave
// only the delivery tool (and say so), and an Anthropic failure must come out
// in the shape outage.ts classifies — or a dead key reads as "try again".

import test from "node:test";
import assert from "node:assert";
import {
  deliverNudge,
  deliveryAlone,
  lastRoundNote,
  lastRoundRequest,
  modelFailure,
} from "../lc/modelCall.ts";
import { classifyUpstream } from "../outage.ts";
import { fromAnthropic } from "../curatorSwitch.ts";

const request = () => ({
  model: "m",
  messages: ["kept"],
  toolChoice: undefined,
  tools: [{ name: "search_spotify" }, { name: "create_mixtape" }],
  systemMessage: { text: "SYSTEM", concat(extra: string) { return { text: this.text + extra }; } },
});

test("last round: only the delivery tool is left", () => {
  const last = lastRoundRequest(request(), "create_mixtape");
  assert.deepEqual(last.tools, [{ name: "create_mixtape" }]);
});

test("last round: the model is told, after the unchanged system prompt", () => {
  const last = lastRoundRequest(request(), "create_mixtape") as any;
  assert.ok(last.systemMessage.text.startsWith("SYSTEM"));
  assert.ok(last.systemMessage.text.endsWith(lastRoundNote("create_mixtape")));
  assert.match(last.systemMessage.text, /last round/);
  assert.match(last.systemMessage.text, /create_mixtape is the only tool left/);
});

test("last round: nothing is forced and nothing else changes", () => {
  const before = request();
  const last = lastRoundRequest(before, "create_mixtape");
  assert.equal(last.toolChoice, undefined, "tool choice is never forced");
  assert.equal(last.messages, before.messages);
  assert.equal(before.tools.length, 2, "the original request is not edited");
});

// What @langchain/anthropic throws: its own SDK's error, with a status, and
// for some statuses a "Troubleshooting URL" paragraph glued to the message.
const wrapped = (status: number, message: string) =>
  Object.assign(new Error(message), { status, lc_error_code: "X" });

test("a dead key is marked, classified as our side, and the URL is cut off", () => {
  const err = modelFailure(
    wrapped(401, "401 invalid x-api-key\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/\n")
  )!;
  assert.equal(err.message, "401 invalid x-api-key");
  assert.equal(fromAnthropic(err), true);
  const verdict = classifyUpstream(err, fromAnthropic(err));
  assert.equal(verdict.kind, "anthropic-auth");
  assert.equal(verdict.persistent, true);
});

test("an empty credit balance is classified as billing", () => {
  const err = modelFailure(wrapped(400, "400 Your credit balance is too low to access the Anthropic API."))!;
  assert.equal(classifyUpstream(err, fromAnthropic(err)).kind, "anthropic-billing");
});

test("overloaded and rate-limited are classified as busy", () => {
  for (const status of [429, 500, 529]) {
    const err = modelFailure(wrapped(status, "busy"))!;
    assert.equal(classifyUpstream(err, fromAnthropic(err)).kind, "anthropic-busy", String(status));
  }
});

test("the original error is kept as the cause", () => {
  const original = wrapped(401, "bad key");
  assert.equal(modelFailure(original)!.cause, original);
});

test("a failure with no status — an abort, a dropped socket — is left alone", () => {
  assert.equal(modelFailure(new Error("terminated")), null);
  assert.equal(modelFailure(Object.assign(new Error("aborted"), { name: "AbortError" })), null);
  assert.equal(modelFailure(null), null);
  assert.equal(modelFailure("oops"), null);
});

const call = (name: string, id: string) => ({ name, id, args: {}, type: "tool_call" as const });

test("a delivery mixed with searches is kept alone, wherever it sits", () => {
  for (const calls of [
    [call("create_mixtape", "d"), call("search_spotify", "s")],
    [call("search_spotify", "s"), call("create_mixtape", "d"), call("search_spotify", "s2")],
  ]) {
    const alone = deliveryAlone({ tool_calls: calls, content: "" }, "create_mixtape")!;
    assert.deepEqual(alone.tool_calls.map((c) => c.id), ["d"]);
    assert.ok(alone.dropped.every((n) => n === "search_spotify"));
    assert.equal(alone.dropped.length, calls.length - 1);
  }
});

test("two deliveries in one message: only the first is kept", () => {
  const alone = deliveryAlone(
    { tool_calls: [call("create_mixtape", "d1"), call("create_mixtape", "d2")], content: "" },
    "create_mixtape"
  )!;
  assert.deepEqual(alone.tool_calls.map((c) => c.id), ["d1"]);
});

test("the dropped calls' blocks leave the content too; text stays", () => {
  const alone = deliveryAlone(
    {
      tool_calls: [call("search_spotify", "s"), call("create_mixtape", "d")],
      content: [
        { type: "text", text: "here it is" },
        { type: "tool_use", id: "s", name: "search_spotify", input: {} },
        { type: "tool_use", id: "d", name: "create_mixtape", input: {} },
      ],
    },
    "create_mixtape"
  )!;
  assert.deepEqual(
    (alone.content as any[]).map((b) => b.id ?? b.type),
    ["text", "d"]
  );
});

test("nothing to trim: a delivery on its own, searches only, or plain text", () => {
  assert.equal(deliveryAlone({ tool_calls: [call("create_mixtape", "d")], content: "" }, "create_mixtape"), null);
  assert.equal(
    deliveryAlone({ tool_calls: [call("search_spotify", "a"), call("search_spotify", "b")], content: "" }, "create_mixtape"),
    null
  );
  assert.equal(deliveryAlone({ content: "just words" }, "create_mixtape"), null);
});

test("the nudge names the delivery tool", () => {
  assert.match(deliverNudge("create_mixtape"), /calling create_mixtape/);
});
