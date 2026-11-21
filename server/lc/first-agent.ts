// Learning step 2, change 2: the smallest possible LangChain agent.
// One tool and LangChain's ready-made loop — no limits, no check, no card.
// Run from server/:  node lc/first-agent.ts
// Costs a few cents of Claude credit and a few live Spotify searches.

// Must come first: spotify.ts reads process.env when it is evaluated.
import "../env.ts";
import { createAgent, tool } from "langchain";
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

// 2. The agent: model + tools + instructions. The loop is inside.
const agent = createAgent({
  model: "anthropic:claude-sonnet-5",
  tools: [searchSpotify],
  systemPrompt:
    "You are a music curator. Search first, then name 3 real tracks that fit.",
});

// 3. Run it once and print every message, so we see the loop.
const result = await agent.invoke({
  messages: [{ role: "user", content: "rainy Sunday morning, slow coffee" }],
});

for (const m of result.messages) {
  const calls = ((m as any).tool_calls ?? []).map(
    (c: any) => `${c.name}(${JSON.stringify(c.args)})`
  );
  const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  console.log(`\n[${m.type}]`, calls.length ? `asks: ${calls.join(", ")}` : text.slice(0, 300));
}

// LangSmith tracing (on when LANGSMITH_TRACING=true in .env) sends the trace
// in the background. Wait for it, or this short script exits before it lands.
await awaitAllCallbacks();
