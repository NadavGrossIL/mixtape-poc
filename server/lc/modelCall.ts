// Two small decisions made around every model call of the LangChain curator.
// Pure, so they are tested without a model.

// ── 1. the last round ──────────────────────────────────────────
//
// The run has a round limit. The hand-written agent FORCES the delivery tool
// on its last round (tool_choice), so a run cannot end without a card. Newer
// Claude models reject forced tool choice, so here the last round does the
// next best thing: every other tool is taken away, and the model is told why.
// It can still answer in plain words — then the run ends with an error, as
// before — but it can no longer spend its last round on one more search.

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

export { lastRoundNote, lastRoundRequest, modelFailure };
