// Which curator answers /api/generate/stream and /api/adjust/stream.
//
// Two agents sit behind the same front door:
//   - "hand-written": server/curator.ts, the Anthropic SDK loop. The default.
//   - "langchain":    server/lc/curator-lc.ts, the LangChain/LangGraph rebuild.
// One setting picks: CURATOR=lc. Anything else — unset, empty, a typo — is the
// hand-written agent, so a bad value can never switch the live app by accident,
// and unsetting it is the whole rollback.
//
// Pure where it can be (ADR 0003): index.ts stays thin, this is what is tested.

import Anthropic from "@anthropic-ai/sdk";
import type { MixtapeCard, AdjustDiff } from "./curator.ts";
import type { SearchBudget } from "./searchBudget.ts";

type CuratorName = "hand-written" | "langchain";

// What index.ts needs from a curator — the two calls and nothing else.
// `owner` is the caller's identity: the LangChain curator keeps a memory
// thread per card and uses it to refuse a thread to anyone but the visitor
// who made the card. The hand-written agent has no memory and ignores it.
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

function whichCurator(env: Record<string, string | undefined>): CuratorName {
  return (env.CURATOR ?? "").trim().toLowerCase() === "lc" ? "langchain" : "hand-written";
}

// Imported on demand, so with the switch off the LangChain packages are never
// loaded and the server starts exactly as it did before the switch existed.
async function loadCurator(name: CuratorName): Promise<Curator> {
  return name === "langchain"
    ? await import("./lc/curator-lc.ts")
    : await import("./curator.ts");
}

// Did this failure come from the Anthropic API? outage.ts needs to be told
// (Spotify errors carry a `status` too). Two ways to know:
//   - the hand-written agent throws the SDK's own APIError;
//   - LangChain carries a SECOND copy of the SDK (a newer version, nested in
//     @langchain/anthropic), so `instanceof` against ours is always false for
//     its errors. curator-lc.ts marks them `fromAnthropic` where they happen.
function fromAnthropic(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError ||
    (typeof err === "object" && err !== null && (err as any).fromAnthropic === true)
  );
}

export type { Curator, CuratorName };
export { whichCurator, loadCurator, fromAnthropic };
