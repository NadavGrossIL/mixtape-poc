// Learning step 5: ask a human first.
// An agent with one tool that "does something real", and a middleware that
// stops the run just before that tool and waits for a decision.
//
// The tool here is a PRACTICE tool: it prints, it writes nothing to Spotify.
// (In the live app the agent has no such tool at all — a person clicks "press"
// and /api/playlist writes the playlist. This file is for learning the pause.)
//
// Run from server/:  node lc/press-agent.ts
// Costs about a cent of Claude credit. No Spotify calls.

import "../env.ts";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import type { HITLRequest, HITLResponse } from "langchain";
import { Command, MemorySaver } from "@langchain/langgraph";
import * as z from "zod";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { MODEL } from "../curator.ts";

// 1. The tool the agent must not run on its own.
const createPlaylist = tool(
  async ({ title, tracks }) => {
    console.log(`   >>> TOOL RAN (practice): would write "${title}" with ${tracks.length} tracks`);
    return `Playlist "${title}" created.`;
  },
  {
    name: "create_playlist",
    description: "Write a playlist to Spotify. Call it once, with the title and the tracks.",
    schema: z.object({
      title: z.string(),
      tracks: z.array(z.string()).describe('Each track as "Artist — Title"'),
    }),
  }
);

// 2. The agent. Two parts make the pause work:
//    - the middleware says WHICH tool needs a human, and which answers exist
//    - the checkpointer holds the paused run until the answer comes
const agent = createAgent({
  model: `anthropic:${MODEL}`,
  tools: [createPlaylist],
  systemPrompt: "You press mixtapes. When asked, call create_playlist once, then say what happened in one line.",
  checkpointer: new MemorySaver(),
  middleware: [
    humanInTheLoopMiddleware({
      interruptOn: { create_playlist: { allowedDecisions: ["approve", "reject"] } },
    }),
  ],
});

const ask =
  'Press this mixtape: "Slow Pour Sunday" with José González — Heartbeats, ' +
  "Norah Jones — Sunrise, Nick Drake — Northern Sky.";

// 3. One run: start, see the pause, answer, see the end.
async function run(label: string, decision: HITLResponse["decisions"][number]) {
  console.log(`\n=== ${label} ===`);
  const config = { configurable: { thread_id: crypto.randomUUID() } };

  // First call: the run stops BEFORE the tool. Nothing has happened yet.
  const paused = await agent.invoke({ messages: [{ role: "user", content: ask }] }, config);
  const request = paused.__interrupt__?.[0]?.value as HITLRequest | undefined;
  if (!request) throw new Error("Expected the run to pause, but it finished.");
  const action = request.actionRequests[0];
  console.log(`1. Paused. The agent wants: ${action.name}(${JSON.stringify(action.args)})`);
  console.log(`   Allowed answers: ${request.reviewConfigs[0].allowedDecisions.join(", ")}`);

  // Second call: same thread, with the human's answer. The run continues
  // from the exact spot where it stopped.
  console.log(`2. Our answer: ${decision.type}`);
  const done = await agent.invoke(new Command({ resume: { decisions: [decision] } }), config);
  console.log(`3. Agent says: ${String(done.messages.at(-1)?.content).slice(0, 200)}`);
}

try {
  await run("Run 1: approve", { type: "approve" });
  await run("Run 2: reject", {
    type: "reject",
    message: "The listener changed their mind. Do not create the playlist.",
  });
} finally {
  await awaitAllCallbacks();
}
