// The LangChain curator: the same front door as the hand-written one in
// ../curator.ts — generateCard(prompt, opts) → MixtapeCard and
// adjustCard(card, adjustment, opts) → AdjustDiff — so index.ts (behind the
// CURATOR=lc switch, see ../curatorSwitch.ts) and the evals can call either
// without knowing which it is.
//
// What LangChain does here: the loop (model → tools → model …), the memory
// (a checkpointer and a thread id), the middleware hooks, the streaming.
// What stays ours, reused from ../curator.ts unchanged: the real SYSTEM
// prompt, the fences around untrusted text, the card check, the search rules.
//
// The small decisions live in pure files next to this one, each with a unit
// test in ../test/:
//   cardStream.ts  tracks one by one, read from the tool call as it is written
//   cardDiff.ts    adjust: old card vs new card → only the changed rows
//   searchStep.ts  one search: cache is free, two budgets, two at a time
//   modelCall.ts   the last round, marking Anthropic failures, a delivery
//                  mixed with searches, an answer in plain words
//   threads.ts     who owns which memory thread, and how many are kept
//
// Try it from server/:  node lc/curator-lc.ts

// Must come first: spotify.ts reads process.env when it is evaluated.
import "../env.ts";
import { AIMessage, HumanMessage, createAgent, createMiddleware, modelCallLimitMiddleware, tool } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import * as z from "zod";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { MemorySaver } from "@langchain/langgraph";
import { isSearchCached, recallByRef, searchCatalog } from "../spotify.ts";
import {
  MODEL,
  RUN_DEADLINE_MS,
  SEARCH_BUDGET,
  SEARCH_CONCURRENCY,
  SYSTEM,
  TRACK_COUNT,
  cardIncompleteReason,
  generateUserContent,
  makeGroundingGate,
  toTrackList,
} from "../curator.ts";
import type { AdjustDiff, MixtapeCard } from "../curator.ts";
import { makeSearchBudget } from "../searchBudget.ts";
import type { SearchBudget } from "../searchBudget.ts";
import { makeCardStream } from "./cardStream.ts";
import { adjustMessage, diffCards, isEmptyDiff, sameTrack } from "./cardDiff.ts";
import { makeSearchStep } from "./searchStep.ts";
import { deliverNudge, deliveryAlone, lastRoundRequest, modelFailure } from "./modelCall.ts";
import { makeThreadBook } from "./threads.ts";

const DELIVER = "create_mixtape";
const DELIVER_DESCRIPTION =
  "Deliver the finished mixtape card. Call this once, when all eight tracks are chosen from search results.";

// The practice knobs (LC_SEARCH_LIMIT, LC_ROUND_LIMIT, LC_TEST_BOUNCE) are
// read only when this file is run directly. Imported — by the server, by the
// evals — they do nothing: a stray variable on the host must not be able to
// shrink the limits or bounce every visitor's first card.
const LESSON: NodeJS.ProcessEnv = import.meta.main ? process.env : {};

// The limits, same numbers as curator.ts (SEARCH_BUDGET, MAX_TOOL_TURNS).
// LC_SEARCH_LIMIT=2 / LC_ROUND_LIMIT=2 node lc/curator-lc.ts show what
// hitting each wall looks like.
const SEARCH_LIMIT = Number(LESSON.LC_SEARCH_LIMIT) || SEARCH_BUDGET;
const ROUND_LIMIT = Number(LESSON.LC_ROUND_LIMIT) || 8;

// How many adjusts one thread is continued for. Each adjust replays the whole
// thread — every search result since the card was made — so the bill for an
// adjust grows with every one before it. After this many, the next adjust
// starts a fresh thread from the card alone (the same path a shared card or a
// restart takes) and the old thread is deleted.
const MAX_ADJUSTS_PER_THREAD = 5;

// Memory. The checkpointer is the notebook — after every step the whole
// conversation is saved in it, under a thread id. Run again with the same
// thread id and the agent continues that conversation. MemorySaver keeps it
// in this process only (gone on restart).
const memory = new MemorySaver();
// The guard on the notebook: only a card's own visitor continues its thread,
// only the newest 200 threads are kept, and a thread is continued for a
// limited number of adjusts (threads.ts).
const threads = makeThreadBook({
  max: 200,
  maxAdjusts: MAX_ADJUSTS_PER_THREAD,
  onEvict: (id) => void memory.deleteThread(id).catch(() => {}),
});

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
type CardInput = z.infer<typeof Card>;

// Why a delivered card cannot be accepted, or null when it can.
type Check = (card: Record<string, unknown>, ctx: { lastTurn: boolean }) => string | null;

// What one run shares between its parts.
type Run = {
  seams: Seams;
  check: Check;
  budget: SearchBudget; // the request-wide search allowance
  onCommit?: (attempt: number, gap: string | null) => void;
  rounds: number; // model calls so far in THIS run (the thread may hold older ones)
  card?: CardInput; // set only when the check accepted a card
  // A failure that must end the run. LangChain turns what a tool throws into
  // a message for the model, so "stop everything" is said two ways: remember
  // the error here, and pull the plug with `stop`.
  fatal?: unknown;
  stop: AbortController;
};

// Tool 1: the Spotify search. Results go back to the model fenced exactly as
// the hand-written loop fences them (catalog rows are untrusted). The rules —
// cache, budgets, two at a time, quota — are in searchStep.ts.
function searchTool(run: Run) {
  const step = makeSearchStep({
    // A test's stand-in search has no cache: every call counts.
    isCached: run.seams.search ? () => false : isSearchCached,
    search: run.seams.search ?? searchCatalog,
    loop: makeSearchBudget(SEARCH_LIMIT),
    request: run.budget,
    concurrency: SEARCH_CONCURRENCY,
    onFatal: (err) => {
      run.fatal = err;
      run.stop.abort();
    },
  });
  return tool(({ query }) => step(query), {
    name: "search_spotify",
    description:
      "Search Spotify's track catalog. Returns up to 10 real records, each with a ref.",
    schema: z.object({ query: z.string().describe("Free-text search") }),
  });
}

// Tool 2: delivering the card is a TOOL, as in curator.ts — not the model's
// final answer in a fixed shape (responseFormat: providerStrategy). That was
// tried first and measured: 3 of 6 eval runs, twice, spent all 8 rounds on
// searches like "placeholder" and never delivered (evals/runs 2026-11-20,
// 2026-11-21). Nothing is forced: tool choice stays "auto", so this also works
// on models that reject forcing.
//
// The check runs inside the tool:
//   - problem → the tool throws; LangChain hands the message back to the model
//     as a failed tool result, and the loop goes on
//   - no problem → returnDirect ends the run
function deliverTool(run: Run) {
  let attempt = 0;
  return tool(
    async (card) => {
      attempt++;
      // No round left to fix anything in: tell the check, so a soft problem
      // is accepted instead of bounced into the round limit.
      let problem = run.check(card, { lastTurn: run.rounds >= ROUND_LIMIT });
      // Test switch: reject the first card once, to watch a send-back.
      if (LESSON.LC_TEST_BOUNCE && attempt === 1 && !problem) {
        problem = "test: this is a practice rejection, the card is fine";
      }
      run.onCommit?.(attempt, problem);
      if (problem) {
        console.warn(`[curator-lc] ${DELIVER} sent back (${problem})`);
        throw new Error(
          `The card was not accepted: ${problem}. Fix it and call ${DELIVER} again with the full card.`
        );
      }
      run.card = card;
      return "Card accepted.";
    },
    {
      name: DELIVER,
      description: DELIVER_DESCRIPTION,
      schema: Card,
      returnDirect: true,
      // Tracks one by one needs one Anthropic setting LangChain has no option
      // for: eager_input_streaming. Without it Anthropic sends a tool call's
      // arguments one whole top-level value at a time — and "tracks" is one
      // value, so all eight arrive in the same instant (measured). curator.ts
      // sets the same flag. providerToolDefinition is LangChain's escape
      // hatch: "send the provider exactly this" — the same name, description
      // and schema LangChain would have built, plus the flag.
      extras: {
        providerToolDefinition: {
          name: DELIVER,
          description: DELIVER_DESCRIPTION,
          input_schema: toJsonSchema(Card),
          eager_input_streaming: true,
        },
      },
    }
  );
}

// One agent per run, because both tools hold per-run state.
const makeAgent = (run: Run) =>
  createAgent({
    // Same request settings as curator.ts: 4000 tokens of room, three retries.
    // LC_MODEL=claude-opus-5-5 node lc/curator-lc.ts tries another model.
    // (LC_MODEL is honoured everywhere, not only in practice runs: the evals
    // use it to measure another model.)
    model:
      run.seams.model ??
      new ChatAnthropic({
        model: process.env.LC_MODEL || MODEL,
        maxTokens: 4000,
        maxRetries: 3,
      }),
    tools: [searchTool(run), deliverTool(run)],
    systemPrompt: SYSTEM,
    checkpointer: memory,
    // Order matters. LangChain runs the after-model hooks last-to-first, and
    // only the FIRST middleware's hook may send the run back to the model
    // (jumpTo) without skipping the hooks before it. Ours is first so that
    // the nudge below still passes through the round counter.
    middleware: [
      // Our own part, around every model call.
      createMiddleware({
        name: "CuratorRounds",
        wrapModelCall: async (request, handler) => {
          // The call about to be made is round number run.rounds + 1.
          const last = run.rounds + 1 >= ROUND_LIMIT;
          let response;
          try {
            // Last round: only the delivery tool is left, and the model is
            // told so (modelCall.ts). Not forced.
            response = await handler(last ? lastRoundRequest(request, DELIVER) : request);
          } catch (err) {
            // An Anthropic failure (dead key, no credit, overloaded) is marked
            // here so index.ts can tell the visitor "our side, not yours".
            run.fatal ??= modelFailure(err) ?? undefined;
            throw err;
          }
          // A delivery written next to other tool calls is handled alone —
          // otherwise the run crashes (modelCall.ts, part 3).
          if (!AIMessage.isInstance(response)) return response;
          const alone = deliveryAlone(response, DELIVER);
          if (!alone) return response;
          console.warn(
            `[curator-lc] ${DELIVER} came with ${alone.dropped.join(",")} — handling the delivery alone`
          );
          return new AIMessage({
            id: response.id,
            name: response.name,
            content: alone.content as any,
            tool_calls: alone.tool_calls,
            additional_kwargs: response.additional_kwargs,
            response_metadata: response.response_metadata,
            usage_metadata: response.usage_metadata,
          });
        },
        afterModel: {
          canJumpTo: ["model"],
          hook: (state) => {
            run.rounds++;
            const calls = ((state.messages.at(-1) as any)?.tool_calls ?? []) as { name: string }[];
            console.log(
              `[curator-lc] round ${run.rounds}: ` +
                (calls.map((c) => `tool:${c.name}`).join(",") || "text only")
            );
            // Plain words instead of a tool call would end the run with no
            // card. As in curator.ts: say "deliver now" and go on. Not after
            // the last round — there is no round left to answer in, and the
            // run ends with its error.
            if (calls.length === 0 && run.rounds < ROUND_LIMIT) {
              return {
                messages: [new HumanMessage(deliverNudge(DELIVER))],
                jumpTo: "model" as const,
              };
            }
          },
        },
      }),
      // Rounds: the hard safety net. It ends the run without a card.
      modelCallLimitMiddleware({ runLimit: ROUND_LIMIT, exitBehavior: "end" }),
    ],
  });

// Stand-ins for the two outside services, for ../test/lcCurator.test.ts only.
// The server and the evals never pass them.
type Seams = {
  model?: BaseChatModel;
  search?: (query: string) => Promise<unknown>;
};

type RunOpts = {
  onCommit?: (attempt: number, gap: string | null) => void;
  signal?: AbortSignal;
  budget?: SearchBudget;
} & Seams;

// Throw away everything the notebook holds for a thread — the book's entry
// (if it has one) and the checkpoints. Used when a run fails: MemorySaver
// saves after every step, so a failed run has already written pages that
// nothing would ever continue or evict.
async function forget(threadId: string) {
  threads.drop(threadId);
  await memory.deleteThread(threadId).catch(() => {});
}

// One run on one thread: send a message, get back an accepted card.
// onItem(i, track) fires for each track as the model finishes writing it.
async function runOnThread(
  threadId: string,
  content: string,
  check: Check,
  onItem: ((index: number, track: any) => void) | undefined,
  { onCommit, signal, budget, model, search }: RunOpts
): Promise<MixtapeCard> {
  const run: Run = {
    seams: { model, search },
    check,
    // Called without a budget — evals, the demo below — the run makes a
    // private one of its own size and behaves as if it were alone.
    budget: budget ?? makeSearchBudget(SEARCH_LIMIT),
    onCommit,
    rounds: 0,
    stop: new AbortController(),
  };
  // Three ways a run is stopped: our deadline, the caller (the visitor left),
  // or a fatal failure inside a tool. Kept apart as facts — see the catch.
  const deadline = AbortSignal.timeout(RUN_DEADLINE_MS);
  const reader = makeCardStream(DELIVER, (i, t) => onItem?.(i, t));
  try {
    // stream, not invoke: with streamMode "messages" every small piece the
    // model writes arrives here as [piece, info]. The pieces of the delivery
    // tool's arguments are what makes tracks appear one by one (cardStream.ts).
    const stream = await makeAgent(run).stream(
      { messages: [{ role: "user", content }] },
      {
        streamMode: "messages",
        // Which page of the notebook this run reads and writes.
        configurable: { thread_id: threadId },
        // LangGraph's own step counter (default 25). Every node is a step —
        // the model, the tools, each middleware hook — about 5 per round here,
        // so the default would cut a run at round 5. ROUND_LIMIT is the real
        // limit; this only has to stay out of its way.
        recursionLimit: ROUND_LIMIT * 10,
        signal: AbortSignal.any([deadline, run.stop.signal, ...(signal ? [signal] : [])]),
      }
    );
    for await (const [piece] of stream) {
      reader.push((piece as any)?.tool_call_chunks);
    }
  } catch (err) {
    // The real reason first: Spotify's quota or an Anthropic failure, not the
    // abort or the wrapper it surfaced as.
    if (run.fatal) throw run.fatal;
    // A visitor who left wins over the deadline: index.ts recognises its own
    // signal and stops quietly. A deadline alone becomes a named error.
    if (deadline.aborted && !signal?.aborted) {
      throw new Error(`Curator run exceeded its ${RUN_DEADLINE_MS / 60000}-minute deadline`);
    }
    throw err;
  }
  // A fatal failure does not always surface as a throw: the abort can land
  // after the stream has already ended. The real reason still wins.
  if (run.fatal) throw run.fatal;

  // Only a card the check accepted counts.
  const card = run.card;
  if (!card) {
    throw new Error(
      run.rounds >= ROUND_LIMIT
        ? `The curator used all ${ROUND_LIMIT} rounds without finishing a card.`
        : "The curator stopped without delivering a card."
    );
  }
  const tracks = toTrackList(card.tracks);
  const withRef = tracks.filter((t) => t.ref && t.ref !== "none").length;
  console.log(`[curator-lc] ${withRef}/${tracks.length} tracks committed with a search ref`);
  return { ...card, tracks, threadId } as MixtapeCard;
}

// Same signature as generateCard in ../curator.ts, plus `owner`: the visitor
// this card's memory thread belongs to (index.ts passes the session identity).
// The returned card carries its `threadId`.
async function generateCard(
  prompt: string,
  {
    seed,
    onTrack,
    owner = "",
    ...opts
  }: RunOpts & {
    seed?: { name: string; tracks: { artist: string; title: string }[]; total: number } | null;
    onTrack?: (index: number, t: { artist: string; title: string }) => void;
    owner?: string;
  } = {}
): Promise<MixtapeCard> {
  const threadId = crypto.randomUUID();
  let card: MixtapeCard;
  try {
    card = await runOnThread(
      threadId,
      generateUserContent(prompt, seed),
      // The rules are curator.ts's, unchanged: 8 filled slots, nothing hollow,
      // note facts that match the search results, at most 2 send-backs.
      // Fresh per run: the gate counts its own send-backs.
      makeGroundingGate({ hard: cardIncompleteReason, lookup: recallByRef }),
      onTrack && ((i, t) => i < TRACK_COUNT && t?.artist && t?.title && onTrack(i, t)),
      opts
    );
  } catch (err) {
    // A failed run is never continued, so its pages are thrown away now.
    await forget(threadId);
    throw err;
  }
  // Recorded only now: a thread whose run failed is never continued.
  threads.add(threadId, owner);
  return card;
}

// Same signature and result as adjustCard in ../curator.ts — only the changed
// rows come back — but made differently: the model delivers the whole card
// again and cardDiff.ts compares. With memory when there is some: if the
// card's thread is known and belongs to this visitor, the run continues it
// (the model still has every search result); otherwise — an unknown id,
// someone else's thread, or a thread that has had its MAX_ADJUSTS_PER_THREAD —
// it starts a new thread from the card alone.
async function adjustCard(
  card: MixtapeCard,
  adjustment: string,
  {
    onChange,
    owner = "",
    ...opts
  }: RunOpts & {
    onChange?: (i: number, c: { index: number; track: { artist: string; title: string } }) => void;
    owner?: string;
  } = {}
): Promise<AdjustDiff> {
  const mine = threads.owns(card.threadId, owner) ? card.threadId : null;
  const remembered = mine !== null && !threads.spent(mine);
  // A spent thread is let go before the run: whatever happens next, nothing
  // will continue it.
  if (mine !== null && !remembered) await forget(mine);
  const threadId = remembered ? mine : crypto.randomUUID();
  let changeCount = 0;
  let next: MixtapeCard;
  try {
    next = await runOnThread(
      threadId,
      adjustMessage(card, adjustment),
      // As in curator.ts, an adjust gets the completeness check but not the
      // note-facts check — and a card that changes nothing is sent back.
      (input) =>
        cardIncompleteReason(input) ??
        (isEmptyDiff(diffCards(card, { ...(input as any), tracks: toTrackList(input.tracks) }))
          ? "it changed nothing — the card is the same as before"
          : null),
      onChange &&
        ((i, t) => {
          if (i === 0) changeCount = 0; // a card sent back is written again from the top
          if (i >= card.tracks.length || !t?.artist || !t?.title || sameTrack(card.tracks[i], t)) return;
          onChange(changeCount++, { index: i, track: t });
        }),
      opts
    );
  } catch (err) {
    // A run that died halfway can leave the thread unusable (a tool call with
    // no answer). Forget it — a remembered thread and a brand-new one alike;
    // the next adjust starts fresh from the card.
    await forget(threadId);
    throw err;
  }
  // A continued thread has one adjust more behind it; a new one starts at 0.
  if (remembered) threads.adjusted(threadId);
  else threads.add(threadId, owner);
  const diff = diffCards(card, next);
  if (threadId !== card.threadId) diff.threadId = threadId;
  return diff;
}

export { generateCard, adjustCard };
// For ../test/lcCurator.test.ts only: the notebook, to check what a run left
// in it, and the adjust limit.
export { memory as _memory, MAX_ADJUSTS_PER_THREAD };

// Run directly: make a card, then adjust it on the same thread.
if (import.meta.main) {
  const show = (label: string, card: MixtapeCard) => {
    console.log(`\n${label}: ${card.title} — ${card.vibe}  [${card.accent}]`);
    card.tracks.forEach((t, i) => console.log(`${i + 1}. ${t.artist} — ${t.title}\n   ${t.note}`));
  };
  const onCommit = (attempt: number, gap: string | null) =>
    console.log(`[check] attempt ${attempt}: ${gap ?? "accepted"}`);
  try {
    let started = Date.now();
    const stamp = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
    const card = await generateCard("rainy Sunday morning, slow coffee", {
      onCommit,
      onTrack: (i, t) => console.log(`  [${stamp()}] track ${i + 1}: ${t.artist} — ${t.title}`),
    });
    show("CARD", card);
    console.log(stamp());

    started = Date.now();
    const adjustment =
      process.env.LC_ADJUST || "swap the two slowest tracks for something warmer";
    const diff = await adjustCard(card, adjustment, {
      onCommit,
      onChange: (_, c) =>
        console.log(`  [${stamp()}] change at ${c.index + 1}: ${c.track.artist} — ${c.track.title}`),
    });
    console.log(`\nADJUSTED (“${adjustment}”): ${diff.changes.length} rows changed`);
    for (const c of diff.changes) {
      console.log(`${c.index + 1}. ${c.track.artist} — ${c.track.title}\n   ${c.track.note}`);
    }
    console.log(stamp());
  } finally {
    // Wait for the LangSmith trace to be sent before the script exits.
    await awaitAllCallbacks();
  }
}
