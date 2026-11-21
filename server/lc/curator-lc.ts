// Learning step 2, change 4: the LangChain agent behind the same front door
// as the hand-written one — generateCard(prompt, opts) → MixtapeCard — so the
// evals (and later the server) can call either without knowing which it is.
//
// Reused from ../curator.ts, unchanged: the real SYSTEM prompt, the two
// functions that fence untrusted text, and toTrackList.
//
// Not here yet, on purpose (learning steps still to come):
//   - live per-track streaming: onTrack fires for all 8 once the card lands
//   - `budget`, the request-wide search allowance (the per-run limits are in)
//
// Try it from server/:  node lc/curator-lc.ts

// Must come first: spotify.ts reads process.env when it is evaluated.
import "../env.ts";
import {
  createAgent,
  createMiddleware,
  modelCallLimitMiddleware,
  tool,
  toolCallLimitMiddleware,
} from "langchain";
import * as z from "zod";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { MemorySaver } from "@langchain/langgraph";
import { recallByRef, searchCatalog } from "../spotify.ts";
import {
  MODEL,
  RUN_DEADLINE_MS,
  SYSTEM,
  cardIncompleteReason,
  generateUserContent,
  makeGroundingGate,
  catalogResultContent,
  fence,
  toTrackList,
} from "../curator.ts";
import type { MixtapeCard } from "../curator.ts";
import type { SearchBudget } from "../searchBudget.ts";

// The tool: the existing Spotify search. Results go back to the model fenced
// exactly as the hand-written loop fences them (catalog rows are untrusted).
const searchSpotify = tool(
  async ({ query }) => catalogResultContent(await searchCatalog(query)),
  {
    name: "search_spotify",
    description:
      "Search Spotify's track catalog. Returns up to 10 real records, each with a ref.",
    schema: z.object({ query: z.string().describe("Free-text search") }),
  }
);

// The card. Field descriptions follow TRACK_SCHEMA / CURATOR_TOOL in curator.ts.
const Track = z.object({
  ref: z
    .string()
    .describe(
      'The "ref" value, copied character for character, from the search result you verified this track against. Use "none" only if you genuinely did not verify this track with search_spotify.'
    ),
  artist: z.string().describe("The artist's name, exactly as the search result shows it."),
  title: z.string().describe("The track title, exactly as the search result shows it."),
  note: z
    .string()
    .describe(
      "One concrete reason this track earns its place. No unseen numbers, remembered lyrics, or guessed credits. Max 18 words. Never generic."
    ),
});

// Eight named slots, not a list (ADR 0001): a list can close after one track.
const Card = z.object({
  title: z.string().describe("Short evocative playlist title, max 5 words."),
  vibe: z.string().describe("One-line dedication, like a record sleeve note. Max 14 words."),
  accent: z
    .enum(["ember", "rose", "plum", "cobalt", "forest", "rust"])
    .describe("Accent color matching the mood."),
  tracks: z
    .object({
      track1: Track,
      track2: Track,
      track3: Track,
      track4: Track,
      track5: Track,
      track6: Track,
      track7: Track,
      track8: Track,
    })
    .describe("All 8 tracks, ordered like a DJ set with an arc."),
});

// The limits, same numbers as curator.ts (SEARCH_BUDGET, MAX_TOOL_TURNS).
// LC_SEARCH_LIMIT=2 node lc/curator-lc.ts shows what hitting the wall looks like.
const SEARCH_LIMIT = Number(process.env.LC_SEARCH_LIMIT) || 20;
const ROUND_LIMIT = 8;

// Learning step 4: memory. The checkpointer is the notebook — after every
// round the whole conversation is saved in it, under a thread id. Invoke again
// with the same thread id and the agent continues that conversation.
// MemorySaver keeps it in this process only (gone on restart); a database
// checkpointer would be a one-line swap.
const memory = new MemorySaver();

// What one run shares between its parts.
type Run = {
  onCommit?: (attempt: number, gap: string | null) => void;
  rounds: number; // model calls so far in THIS run (the thread may hold older ones)
  card?: z.infer<typeof Card>; // set only when the check accepted a card
};

// Delivering the card is a TOOL, as in curator.ts — not the model's final
// answer in a fixed shape (responseFormat: providerStrategy). That was tried
// first and measured: 3 of 6 eval runs, twice, spent all 8 rounds on searches
// like "placeholder" and never delivered (evals/runs 2026-11-20, 2026-11-21).
// With a fixed-shape answer the model can write nothing but the finished card,
// and SYSTEM tells it to commit "in that single tool call". Nothing is forced:
// tool choice stays "auto", so this also works on models that reject forcing.
//
// The check runs inside the tool. The rules are curator.ts's, unchanged:
// makeGroundingGate(cardIncompleteReason) — 8 filled slots, nothing hollow,
// note facts that match the search results, at most 2 send-backs.
//   - problem → the tool throws; LangChain hands the message back to the model
//     as a failed tool result, and the loop goes on (curator.ts:1234 does the same)
//   - no problem → returnDirect ends the run
function deliverTool(run: Run) {
  // Fresh per run: the gate counts its own send-backs.
  const check = makeGroundingGate({ hard: cardIncompleteReason, lookup: recallByRef });
  let attempt = 0;

  return tool(
    async (card) => {
      attempt++;
      // No round left to fix anything in: tell the gate, so a soft problem
      // is accepted instead of bounced into the round limit.
      let problem = check(card, { lastTurn: run.rounds >= ROUND_LIMIT });
      // Test switch: reject the first card once, to watch a send-back.
      if (process.env.LC_TEST_BOUNCE && attempt === 1 && !problem) {
        problem = "test: this is a practice rejection, the card is fine";
      }
      run.onCommit?.(attempt, problem);
      if (problem) {
        throw new Error(
          `The card was not accepted: ${problem}. Fix it and call create_mixtape again with the full card.`
        );
      }
      run.card = card;
      return "Card accepted.";
    },
    {
      name: "create_mixtape",
      description:
        "Deliver the finished mixtape card. Call this once, when all eight tracks are chosen from search results.",
      schema: Card,
      returnDirect: true,
    }
  );
}

// One agent per run, because the delivery tool holds per-run state.
const makeAgent = (run: Run) =>
  createAgent({
    // LC_MODEL=claude-opus-5-5 node lc/curator-lc.ts tries another model.
    model: `anthropic:${process.env.LC_MODEL || MODEL}`,
    tools: [searchSpotify, deliverTool(run)],
    systemPrompt: SYSTEM,
    checkpointer: memory,
    middleware: [
      // Searches: past the limit the search is not run; the model is told
      // "limit reached" and carries on, so it finishes the card with what it has.
      // Unlike curator.ts this counts cache hits too — every call is one.
      toolCallLimitMiddleware({
        toolName: "search_spotify",
        runLimit: SEARCH_LIMIT,
        exitBehavior: "continue",
      }),
      // Rounds: the hard safety net. It stops the run WITHOUT a card (curator.ts
      // forces one on its last round), so runOnThread turns that into an error.
      modelCallLimitMiddleware({ runLimit: ROUND_LIMIT, exitBehavior: "end" }),
      // Our own small part: count this run's rounds for the delivery tool.
      createMiddleware({
        name: "RoundCounter",
        afterModel: () => {
          run.rounds++;
        },
      }),
    ],
  });

type RunOpts = {
  onTrack?: (index: number, t: { artist: string; title: string }) => void;
  onCommit?: (attempt: number, gap: string | null) => void;
  signal?: AbortSignal;
};

// One run on one thread: send a message, get back an accepted card.
async function runOnThread(
  threadId: string,
  content: string,
  { onTrack, onCommit, signal }: RunOpts
): Promise<MixtapeCard> {
  const run: Run = { onCommit, rounds: 0 };
  await makeAgent(run).invoke(
    { messages: [{ role: "user", content }] },
    {
      // Which page of the notebook this run reads and writes.
      configurable: { thread_id: threadId },
      // LangGraph's own step counter (default 25). Every node is a step — the
      // model, the tools, each middleware hook — about 5 per round here, so
      // the default would cut a run at round 5. ROUND_LIMIT is the real limit;
      // this only has to stay out of its way.
      recursionLimit: ROUND_LIMIT * 10,
      // The clock: the caller's cancel, or the deadline, whichever comes first.
      signal: AbortSignal.any([
        AbortSignal.timeout(RUN_DEADLINE_MS),
        ...(signal ? [signal] : []),
      ]),
    }
  );

  // Only a card the check accepted counts. A run that ran out of rounds, or
  // ended in plain text, has none.
  const card = run.card;
  if (!card) {
    throw new Error(`The curator used all ${ROUND_LIMIT} rounds without finishing a card.`);
  }
  const tracks = toTrackList(card.tracks);
  tracks.forEach((t, i) => onTrack?.(i, t));
  return { ...card, tracks } as MixtapeCard;
}

// Same signature as generateCard in ../curator.ts, plus `threadId`: pass one
// to be able to adjust this card later.
async function generateCard(
  prompt: string,
  {
    seed,
    threadId = crypto.randomUUID(),
    ...opts
  }: RunOpts & {
    seed?: { name: string; tracks: { artist: string; title: string }[]; total: number } | null;
    threadId?: string;
    budget?: SearchBudget; // accepted, not spent — the request-wide allowance is still to do
  } = {}
): Promise<MixtapeCard> {
  return runOnThread(threadId, generateUserContent(prompt, seed), opts);
}

// Adjust, with memory: one new message on the card's own thread. The model
// already has the prompt, every search result and the card it delivered.
// Unlike adjustCard in ../curator.ts (stateless, returns only the changed
// tracks) this returns the whole new card.
async function adjustCard(
  threadId: string,
  adjustment: string,
  opts: RunOpts = {}
): Promise<MixtapeCard> {
  return runOnThread(
    threadId,
    `Adjust the mixtape you delivered:\n${fence("listener_adjustment", adjustment)}\n\n` +
      "Keep every track the adjustment does not touch. Call create_mixtape again with the full card.",
    opts
  );
}

export { generateCard, adjustCard };

// Run directly: make a card, then adjust it on the same thread.
if (import.meta.main) {
  const show = (label: string, card: MixtapeCard, started: number) => {
    console.log(`\n${label}: ${card.title} — ${card.vibe}  [${card.accent}]`);
    card.tracks.forEach((t, i) => console.log(`${i + 1}. ${t.artist} — ${t.title}\n   ${t.note}`));
    console.log(`${((Date.now() - started) / 1000).toFixed(1)} s`);
  };
  const onCommit = (attempt: number, gap: string | null) =>
    console.log(`[check] attempt ${attempt}: ${gap ?? "accepted"}`);
  try {
    const threadId = crypto.randomUUID();
    let started = Date.now();
    show("CARD", await generateCard("rainy Sunday morning, slow coffee", { threadId, onCommit }), started);

    started = Date.now();
    const adjustment =
      process.env.LC_ADJUST || "swap the two slowest tracks for something warmer";
    show(`ADJUSTED (“${adjustment}”)`, await adjustCard(threadId, adjustment, { onCommit }), started);

    const saved = await memory.getTuple({ configurable: { thread_id: threadId } });
    const msgs = (saved?.checkpoint.channel_values.messages ?? []) as any[];
    console.log(`\nThread ${threadId}: ${msgs.length} messages saved`);
  } finally {
    // Wait for the LangSmith trace to be sent before the script exits.
    await awaitAllCallbacks();
  }
}
