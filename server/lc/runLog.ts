// One line in the server log per curator run.
//
// On a deployed host LangSmith tracing is off unless someone opts in
// (curatorLoader.ts), so this line is the only record of what a run cost:
// rounds, live searches, tokens and time. Tokens are the money. An adjust on
// a remembered thread re-sends the whole conversation, so its "in" number is
// the one to watch.
//
// Numbers only — never the prompt, the adjustment or the card.

type RunFacts = {
  kind: "generate" | "adjust";
  // "card": a card was accepted. "no card": the run ended without one.
  // "stopped": the visitor left or the run was cut off.
  outcome: "card" | "no card" | "stopped";
  rounds: number;
  liveSearches: number; // searches that cost Spotify quota (cache hits do not)
  tokensIn: number;
  tokensOut: number;
  ms: number;
  // adjust only: did the run continue the card's remembered thread?
  remembered?: boolean;
};

// The token counts of one model answer, as LangChain reports them
// (`usage_metadata`). Missing or odd values count as zero: a log line must
// never be the reason a run fails.
function tokensOf(message: unknown): { in: number; out: number } {
  const u = (message as { usage_metadata?: { input_tokens?: unknown; output_tokens?: unknown } } | null)
    ?.usage_metadata;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { in: n(u?.input_tokens), out: n(u?.output_tokens) };
}

function runSummary(f: RunFacts): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    `[curator-lc] run ${f.kind}` +
    (f.kind === "adjust" ? (f.remembered ? " (remembered thread)" : " (fresh thread)") : "") +
    `: ${f.outcome} | ${plural(f.rounds, "round")} | ` +
    `${plural(f.liveSearches, "live search").replace("searchs", "searches")} | ` +
    `tokens ${f.tokensIn} in, ${f.tokensOut} out | ${(f.ms / 1000).toFixed(1)} s`
  );
}

export type { RunFacts };
export { runSummary, tokensOf };
