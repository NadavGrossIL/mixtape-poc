// The small decisions made around every model call of the LangChain curator.
// Pure, so they are tested without a model.

// ── 1. the last round ──────────────────────────────────────────
//
// The run has a round limit. The hand-written loop this replaced FORCED the delivery tool
// on its last round (tool_choice), so a run cannot end without a card. Newer
// Claude models reject forced tool choice, so here the last round does the
// next best thing: every other tool is taken away, and the model is told why.
// It can still answer in plain words — on the last round that ends the run
// with an error — but it can no longer spend its last round on one more search.

function lastRoundNote(toolName: string): string {
  return (
    `\n\nThis is the last round of this run. ${toolName} is the only tool left: ` +
    `call it now with the best full card you can build from the search results ` +
    `you already have. Do not answer in plain text.`
  );
}

// `request` is LangChain's ModelRequest; only the two fields used are typed.
function lastRoundRequest<T extends { tools: readonly any[]; systemMessage: any }>(
  request: T,
  toolName: string
): T {
  return {
    ...request,
    tools: request.tools.filter((t) => t?.name === toolName),
    systemMessage: request.systemMessage.concat(lastRoundNote(toolName)),
  };
}

// ── 2. "our side, not yours" ───────────────────────────────────
//
// outage.ts tells the visitor "our side" and turns /healthz red when the
// Anthropic key is dead or the credit is gone. It needs to be told the error
// came from Anthropic, and index.ts used to know by `instanceof APIError`.
// That check is always false here: @langchain/anthropic ships its own, newer
// copy of the Anthropic SDK, so its errors are a different class. LangChain
// also glues a "Troubleshooting URL" paragraph onto some messages.
//
// So the error is marked where it happens — inside the model call, the one
// place where a failure with an HTTP status can only be Anthropic's.
// Returns null for anything without a status (an abort, a dropped socket):
// those pass through untouched.
function modelFailure(err: unknown): (Error & { status: number; fromAnthropic: true }) | null {
  const status = (err as any)?.status;
  if (typeof status !== "number") return null;
  const message = String((err as any)?.message ?? "").split("\n\nTroubleshooting URL:")[0]!;
  return Object.assign(new Error(message, { cause: err }), {
    status,
    fromAnthropic: true as const,
  });
}

// ── 3. a delivery mixed with other tool calls ──────────────────
//
// The model sometimes writes create_mixtape AND a search in one message.
// LangChain runs each tool call as its own task and decides where to go next
// once PER TASK: the accepted delivery says "finish", the search says "back
// to the model". Both happen in the same step, both write the round counter,
// and the run dies with InvalidUpdateError — the thread unreadable after it.
// (Even without the crash, an accepted card followed by a search result
// would not end the run: only the LAST tool message is looked at.)
//
// So a delivery is always handled alone: the first delivery call is kept,
// every other call in that message is dropped before any tool runs. The hand-written loop
// does the same on an accepted card (it returns without running the
// searches). On a rejected card it differs a little: that loop still ran
// the searches, here the model has to ask for them again.
//
// Returns the trimmed `tool_calls` and `content` (Anthropic repeats each tool
// call as a block inside content, and a block without its call would be sent
// back to Anthropic on the next adjust), or null when there is nothing to trim.
type ToolCallLike = { name: string; id?: string };

function deliveryAlone<C extends ToolCallLike>(
  message: { tool_calls?: C[]; content: unknown },
  toolName: string
): { tool_calls: C[]; content: unknown; dropped: string[] } | null {
  const calls = message.tool_calls ?? [];
  const delivery = calls.find((c) => c.name === toolName);
  if (!delivery || calls.length === 1) return null;
  const isCallBlock = (b: any) =>
    b && typeof b === "object" && ["tool_use", "tool_call", "tool_call_chunk"].includes(b.type);
  return {
    tool_calls: [delivery],
    content: Array.isArray(message.content)
      ? message.content.filter((b) => !isCallBlock(b) || b.id === delivery.id)
      : message.content,
    dropped: calls.filter((c) => c !== delivery).map((c) => c.name),
  };
}

// ── 4. an answer in plain words ────────────────────────────────
//
// A turn with no tool call would end the run without a card. The hand-written loop
// answers it with one line and carries on; these are its words, plus the
// "by calling" a model that has just narrated instead of acting needs.
function deliverNudge(toolName: string): string {
  return `Record the final result now by calling ${toolName}.`;
}

export { deliverNudge, deliveryAlone, lastRoundNote, lastRoundRequest, modelFailure };
