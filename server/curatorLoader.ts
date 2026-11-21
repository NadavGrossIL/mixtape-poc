// Loading the curator — the LangChain agent in lc/curator-lc.ts — safely.
//
// index.ts does not import the agent directly, for one reason: LangChain
// starts sending traces to a third party from environment variables alone, so
// those variables are checked BEFORE any LangChain module is loaded (the
// tracing guard below). This file is that one doorway, plus the answer to "did
// this failure come from Anthropic?".
//
// (Until 2026-11-21 this was curatorSwitch.ts: CURATOR=lc chose between this
// agent and a hand-written one. The hand-written one is gone; so is the switch.)
//
// Pure where it can be (ADR 0003): index.ts stays thin, this is what is tested.

import type { MixtapeCard, AdjustDiff } from "./curator.ts";
import type { SearchBudget } from "./searchBudget.ts";

// What index.ts needs from a curator — the two calls and nothing else.
// `owner` is the caller's identity: the curator keeps a memory thread per card
// and uses it to refuse a thread to anyone but the visitor who made the card.
interface Curator {
  generateCard(
    prompt: string,
    opts?: {
      seed?: { name: string; tracks: { artist: string; title: string }[]; total: number } | null;
      onTrack?: (index: number, t: { artist: string; title: string }) => void;
      signal?: AbortSignal;
      budget?: SearchBudget;
      owner?: string;
    }
  ): Promise<MixtapeCard>;
  adjustCard(
    card: MixtapeCard,
    adjustment: string,
    opts?: {
      onChange?: (i: number, c: { index: number; track: { artist: string; title: string } }) => void;
      signal?: AbortSignal;
      budget?: SearchBudget;
      owner?: string;
    }
  ): Promise<AdjustDiff>;
}

// ── LangSmith tracing: never on for visitors by accident ─────
//
// @langchain/core starts sending traces to LangSmith — a third party — from
// environment variables alone; no line of our code has to ask for it. A trace
// is the whole run: the visitor's prompt, their adjustment, the card. That is
// fine on a laptop, where the only prompts are the developer's own. On the
// public app it would ship every stranger's words off the host because of one
// variable copied over from a local .env.
//
// So on a deployed host tracing is off unless someone says, in so many words,
// that visitors may be traced: LANGSMITH_TRACE_VISITORS=1. Locally nothing is
// touched. The app tells visitors their prompts are logged (the notice line
// under the composer, client/src/App.tsx) — keep that line if this is on.
//
// The list is what @langchain/core reads (utils/callbacks.js, plus
// callbacks/manager.js for the last one), checked 2026-11-21. Re-check it when
// the package is upgraded: a fifth name would walk straight past this.
const TRACING_VARS = [
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING_V2",
  "LANGSMITH_TRACING",
  "LANGCHAIN_TRACING",
] as const;
const TRACE_OPT_IN = "LANGSMITH_TRACE_VISITORS";

type TracingDecision = {
  // "nothing"   — no tracing variable is set; nothing to decide
  // "untouched" — set, but this is not a deployed host: the developer's call
  // "opted-in"  — set on a deployed host, and the opt-in is there too
  // "forced-off"— set on a deployed host with no opt-in: remove them
  action: "nothing" | "untouched" | "opted-in" | "forced-off";
  // the tracing variables that were set, by name (never their values)
  set: string[];
  // names to remove from the environment before LangChain loads
  unset: string[];
  // the one [config] line to print, or null when there is nothing to say
  log: string | null;
};

// Pure: reads `env`, changes nothing. `deployed` is index.ts's own DEPLOYED
// fact, handed in — one rule for "is this host reachable", not two.
//
// "Set" means any non-empty value, not just "true". The library's checks are
// not uniform (three names need exactly "true", LANGCHAIN_TRACING counts any
// text at all, "false" included), and guessing which spellings are harmless
// is how a guard goes stale. Forced off means every set name is REMOVED, for
// the same reason: writing "false" would turn LANGCHAIN_TRACING on.
function tracingDecision(
  env: Record<string, string | undefined>,
  deployed: boolean
): TracingDecision {
  const set = TRACING_VARS.filter((name) => (env[name] ?? "").trim() !== "");
  if (!set.length) return { action: "nothing", set, unset: [], log: null };
  if (!deployed) return { action: "untouched", set, unset: [], log: null };
  // Exactly "1", like DEPLOYED=1: a typo must not be read as consent.
  if ((env[TRACE_OPT_IN] ?? "").trim() === "1") {
    return {
      action: "opted-in",
      set,
      unset: [],
      log:
        `[config] LangSmith tracing is ON for visitors (${set.join(", ")} with ` +
        `${TRACE_OPT_IN}=1) — every prompt, adjustment and card is sent to LangSmith.`,
    };
  }
  return {
    action: "forced-off",
    set,
    unset: set,
    log:
      `[config] LangSmith tracing forced OFF: ${set.join(", ")} set on a deployed ` +
      `host, which would send every visitor's prompt and card to LangSmith. ` +
      `Set ${TRACE_OPT_IN}=1 to allow it on purpose.`,
  };
}

// Where the curator runs: is the host reachable by strangers, and the
// environment to guard. `env`, `log` and `load` exist so the tests never read
// or change the real environment and never import the real curator (which
// loads server/.env on the way in).
type Host = {
  deployed: boolean;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  load?: () => Promise<Curator>;
};

const importCurator = async (): Promise<Curator> => await import("./lc/curator-lc.ts");

// Imported on demand, never statically: the tracing guard has to run BEFORE
// the import, so no LangChain module ever sees the variables it removes. It
// works on the environment as it is at this moment — index.ts imports env.ts
// first, so server/.env is already in.
//
// `host` is required, not optional: a caller that could leave it out would
// load LangChain unguarded.
async function loadCurator(host: Host): Promise<Curator> {
  const env = host.env ?? process.env;
  const decision = tracingDecision(env, host.deployed);
  for (const key of decision.unset) delete env[key];
  if (decision.log) (host.log ?? console.warn)(decision.log);
  return (host.load ?? importCurator)();
}

// Did this failure come from the Anthropic API? outage.ts needs to be told
// (Spotify errors carry a `status` too). `instanceof` cannot answer it:
// @langchain/anthropic carries its own copy of the Anthropic SDK, so its
// errors are not our SDK's class. curator-lc.ts marks them `fromAnthropic`
// inside the model call, the one place a failure with a status can only be
// Anthropic's (lc/modelCall.ts).
function fromAnthropic(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as any).fromAnthropic === true;
}

export type { Curator, Host, TracingDecision };
export { loadCurator, fromAnthropic, tracingDecision, TRACING_VARS, TRACE_OPT_IN };
