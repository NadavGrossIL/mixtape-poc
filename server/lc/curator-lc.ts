// Learning step 2, change 4: the LangChain agent behind the same front door
// as the hand-written one — generateCard(prompt, opts) → MixtapeCard — so the
// evals (and later the server) can call either without knowing which it is.
//
// Reused from ../curator.ts, unchanged: the real SYSTEM prompt, the two
// functions that fence untrusted text, and toTrackList.
//
// Not here yet, on purpose (learning steps still to come):
//   - live per-track streaming: onTrack fires for all 8 once the card lands
//   - `budget` and the round/search/clock limits (step 3)
//   - the check that every track came from a search (step 3)
//
// Try it from server/:  node lc/curator-lc.ts

// Must come first: spotify.ts reads process.env when it is evaluated.
import "../env.ts";
import { createAgent, providerStrategy, tool, toolStrategy } from "langchain";
import * as z from "zod";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { searchCatalog } from "../spotify.ts";
import {
  MODEL,
  SYSTEM,
  generateUserContent,
  catalogResultContent,
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

const agent = createAgent({
  // LC_MODEL=claude-opus-5-5 node lc/curator-lc.ts tries another model.
  model: `anthropic:${process.env.LC_MODEL || MODEL}`,
  tools: [searchSpotify],
  systemPrompt: SYSTEM,
  responseFormat: process.env.LC_NATIVE ? providerStrategy(Card) : toolStrategy(Card),
});

// Same signature as generateCard in ../curator.ts.
async function generateCard(
  prompt: string,
  {
    seed,
    onTrack,
    onCommit,
    signal,
  }: {
    seed?: { name: string; tracks: { artist: string; title: string }[]; total: number } | null;
    onTrack?: (index: number, t: { artist: string; title: string }) => void;
    onCommit?: (attempt: number, gap: string | null) => void;
    signal?: AbortSignal;
    budget?: SearchBudget; // accepted, not spent yet — step 3
  } = {}
): Promise<MixtapeCard> {
  const result = await agent.invoke(
    { messages: [{ role: "user", content: generateUserContent(prompt, seed) }] },
    { signal }
  );

  const card = result.structuredResponse;
  const tracks = toTrackList(card.tracks);
  tracks.forEach((t, i) => onTrack?.(i, t));
  onCommit?.(1, null);
  return { ...card, tracks } as MixtapeCard;
}

export { generateCard };

// Run directly: one card, printed.
if (import.meta.main) {
  try {
    const started = Date.now();
    const card = await generateCard("rainy Sunday morning, slow coffee");
    console.log(`${card.title} — ${card.vibe}  [${card.accent}]`);
    card.tracks.forEach((t, i) =>
      console.log(`${i + 1}. ${t.artist} — ${t.title}  (${t.ref})\n   ${t.note}`)
    );
    console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    // Wait for the LangSmith trace to be sent before the script exits.
    await awaitAllCallbacks();
  }
}
