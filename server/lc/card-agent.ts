// Learning step 2, change 3: the agent must finish with a card of 8 tracks.
// New here: `responseFormat`. Still no limits, no check, and a short prompt.
// Run from server/:  node lc/card-agent.ts
// Costs a few cents of Claude credit and a few live Spotify searches.

// Must come first: spotify.ts reads process.env when it is evaluated.
import "../env.ts";
import { createAgent, tool, toolStrategy } from "langchain";
import * as z from "zod";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { searchCatalog } from "../spotify.ts";

// 1. The tool: the existing Spotify search, wrapped for LangChain.
const searchSpotify = tool(
  async ({ query }) => JSON.stringify(await searchCatalog(query)),
  {
    name: "search_spotify",
    description: "Search Spotify's track catalog. Returns up to 10 real records.",
    schema: z.object({ query: z.string().describe("Free-text search") }),
  }
);

// 2. The shape of the final answer.
const Track = z.object({
  ref: z.string().describe("The ref of a track from a search result"),
  artist: z.string(),
  title: z.string(),
  note: z.string().describe("One-line liner note"),
});

// Eight named slots, not a list — same reason as curator.ts (ADR 0001):
// a list can be closed after one track, eight required keys cannot.
const Card = z.object({
  title: z.string().describe("Short playlist title, max 5 words"),
  vibe: z.string().describe("One-line dedication, max 14 words"),
  tracks: z.object({
    track1: Track,
    track2: Track,
    track3: Track,
    track4: Track,
    track5: Track,
    track6: Track,
    track7: Track,
    track8: Track,
  }),
});

// 3. The agent. `responseFormat` is the new part: the run ends with a Card.
const agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [searchSpotify],
  systemPrompt:
    "You are a music curator. Search Spotify, then finish with a card of 8 real tracks. Use only tracks that came back from a search.",
  responseFormat: toolStrategy(Card),
});

// 4. Run it once. Print the loop in short, then the card.
try {
  const started = Date.now();
  const result = await agent.invoke({
    messages: [{ role: "user", content: "rainy Sunday morning, slow coffee" }],
  });

  for (const m of result.messages) {
    const calls = ((m as any).tool_calls ?? []).map((c: any) => c.name);
    console.log(`[${m.type}]`, calls.length ? `asks: ${calls.join(", ")}` : "");
  }

  const card = result.structuredResponse;
  console.log(`\n${card.title} — ${card.vibe}`);
  Object.values(card.tracks).forEach((t, i) =>
    console.log(`${i + 1}. ${t.artist} — ${t.title}  (${t.ref})`)
  );
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
} finally {
  // Wait for the LangSmith trace to be sent before the script exits.
  await awaitAllCallbacks();
}
