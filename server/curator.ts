// Claude curator: prompt in → validated mixtape card out.
// Uses forced tool choice + strict tool schema so the JSON arrives validated —
// no markdown-fence stripping, no regex.
// Streaming: fine-grained tool-input streaming (eager_input_streaming, GA — no
// beta header) lets us emit each track as the model produces it.

import Anthropic from "@anthropic-ai/sdk";
import { searchCatalog, isSearchCached } from "./spotify.ts";

const MODEL = "claude-sonnet-5";
const TRACK_COUNT = 8;

const PLACEHOLDER_RE = /^(your_|<|\.\.\.|xxx)/i;

function anthropicConfigured(): boolean {
  const key = process.env.ANTHROPIC_API_KEY || "";
  return key.length > 0 && !PLACEHOLDER_RE.test(key);
}

// A curated track, plus the optional fields Spotify resolution adds later.
interface Track {
  ref?: string;
  artist: string;
  title: string;
  note: string;
  resolved?: boolean | null;
  spotifyUrl?: string | null;
  spotifyUri?: string;
  albumArt?: string | null;
  matchedName?: string;
}

interface MixtapeCard {
  title: string;
  vibe: string;
  accent: string;
  tracks: Track[];
  prompt?: string;
  seed?: { id: string; name: string };
}

interface AdjustDiff {
  changes: {
    index: number;
    track: { ref?: string; artist: string; title: string; note: string };
  }[];
  title?: string;
  vibe?: string;
  accent?: string;
}

// One track's shape, shared by create_mixtape and adjust_mixtape.
// NO_REF is the documented escape hatch. `ref` has to be REQUIRED for the
// grammar to guarantee it is present at all, but a run where Spotify search
// degraded has no refs to quote — without a sentinel the model would either
// stall or invent one. An explicit "none" is honest and sends that track down
// the normal search path.
const NO_REF = "none";

const TRACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "artist", "title", "note"],
  properties: {
    // Quoting a ref turns resolution from a second fuzzy search into a lookup
    // of the exact record the server fetched — no request, and a track that
    // was never in a search result cannot produce a valid ref.
    ref: {
      type: "string",
      description:
        `The "ref" value, copied character for character, from the search result you verified this track against. ` +
        `Use "${NO_REF}" only if you genuinely did not verify this track with search_spotify.`,
    },
    artist: {
      type: "string",
      description: "The recording artist's name, spelled exactly as the search result shows it.",
    },
    title: {
      type: "string",
      description: "The track title, spelled exactly as the search result shows it.",
    },
    note: {
      type: "string",
      description:
        "One specific, concrete reason this track earns its place — a detail, a moment, a stat. Max 18 words. Never generic.",
    },
  },
};

// track1…track8. The card's tracks are 8 REQUIRED KEYS, not an array — see
// the note on CURATOR_TOOL for why that distinction is the whole fix.
const TRACK_KEYS = Array.from({ length: TRACK_COUNT }, (_, i) => `track${i + 1}`);

const ARC = [
  "the opener",
  "the second track, still building",
  "the build",
  "the build continues",
  "the peak",
  "just past the peak",
  "the comedown",
  "the closer",
];

const CURATOR_TOOL = {
  name: "create_mixtape",
  description:
    "Record the finished mixtape card: a title, a dedication-style vibe line, an accent color, and 8 tracks in DJ-set order, each with a one-line liner note.",
  strict: true,
  // Fine-grained tool-input streaming: track names arrive as the model writes them.
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "vibe", "accent", "tracks"],
    properties: {
      title: {
        type: "string",
        description: "Short evocative playlist title, max 5 words.",
      },
      vibe: {
        type: "string",
        description:
          "One-line dedication, like the note on the back of a record sleeve. Max 14 words.",
      },
      accent: {
        type: "string",
        enum: ["ember", "rose", "plum", "cobalt", "forest", "rust"],
        description: "Accent color matching the mood.",
      },
      // Eight required keys, deliberately NOT an array.
      //
      // This is the one part of the schema the grammar can actually enforce.
      // A strict tool schema ignores minItems, so `tracks: [oneTrack]` was a
      // perfectly legal create_mixtape call — and measured over 10 live runs
      // the model closed the array after a single exemplar track 6 times,
      // stopping cleanly at ~240 output tokens with "All eight verified. Now
      // let's finalize the mixtape." as its text block. It wasn't truncation
      // and it wasn't malformed JSON; it just decided one was enough.
      //
      // `required` on object properties IS compiled into the grammar, so as
      // an object the call cannot close until all eight exist. The array is
      // rebuilt from these keys the moment the input lands (see toTrackList).
      tracks: {
        type: "object",
        additionalProperties: false,
        required: TRACK_KEYS,
        description:
          "All 8 tracks, keyed track1 through track8, ordered like a DJ set with an arc.",
        properties: Object.fromEntries(
          TRACK_KEYS.map((key, i) => [
            key,
            {
              ...TRACK_SCHEMA,
              description: `Track ${i + 1} of 8 — ${ARC[i]}.`,
            },
          ])
        ),
      },
    },
  },
};

// Second-chance refinement: diff-style strict tool. Unchanged tracks are never
// re-emitted by the model, so they survive byte-for-byte by construction
// (see docs/research/second-chance-readjustment.md). Declared statically next
// to CURATOR_TOOL — changing the tool set invalidates the grammar cache.
const ADJUST_TOOL = {
  name: "adjust_mixtape",
  description:
    "Record the minimal set of changes that satisfies the user's adjustment. " +
    "Only include tracks that must change; omit every index the adjustment does not require touching. " +
    "Omit title/vibe/accent unless the adjustment changes the mixtape's identity.",
  strict: true,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["changes"],
    properties: {
      changes: {
        type: "array",
        description: "Replacements, fewest possible. Empty if only title/vibe change.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "track"],
          properties: {
            index: {
              type: "integer",
              enum: [0, 1, 2, 3, 4, 5, 6, 7],
              description: "Position of the track being replaced, from the current mixtape JSON.",
            },
            track: {
              type: "object",
              additionalProperties: false,
              required: ["artist", "title", "note"],
              properties: {
                artist: { type: "string", description: "The recording artist's name." },
                title: { type: "string", description: "The track title." },
                note: {
                  type: "string",
                  description: "Same rules as create_mixtape notes: one specific, concrete reason. Max 18 words.",
                },
              },
            },
          },
        },
      },
      // optional — omitted from `required`, so the model may skip them
      title: { type: "string", description: "New title, only if the adjustment changes the mixtape's identity." },
      vibe: { type: "string", description: "New vibe line, only if the adjustment changes the mixtape's identity." },
      accent: {
        type: "string",
        enum: ["ember", "rose", "plum", "cobalt", "forest", "rust"],
      },
    },
  },
};

// The curator's verification tool — executed server-side against Spotify
// search between model turns. This is what makes "every track exists on
// Spotify" enforceable instead of aspirational.
const SEARCH_TOOL = {
  name: "search_spotify",
  description:
    "Search Spotify's track catalog. Returns up to 10 real records, each with a ref, artist, title, album and year. " +
    "Every track on the card must come from these results, and the track's ref field must be the row's ref copied exactly. " +
    "Searches are a limited daily resource, so prefer broad searches (an artist, a scene, a sound) that can fill several " +
    "slots at once over one narrow search per track, and never repeat a query you have already run.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search — artist and title together works best, e.g. 'Radiohead Let Down'.",
      },
    },
  },
};

// Static tool list for every curator call (generate and adjust alike) —
// varying it between calls would invalidate the compiled-grammar cache.
// (Measured: scoping the list per flow, so a generate run never sees
// adjust_mixtape's legitimately-empty `changes` array, made no difference to
// the truncated-commit rate — 5/10 vs 6/10. The cause was the array itself.)
const TOOLS = [SEARCH_TOOL, CURATOR_TOOL, ADJUST_TOOL];

// Turn budget for the search-then-commit loop. Typical run: one or two turns
// of batched searches, maybe one of replacement searches, then the final tool
// (plus headroom for an incomplete-card retry — see incompleteReason). The
// last turn forces the final tool so a run can never end without a card.
// Raised from 6 after measuring the retry path live: the incomplete-card
// commit chained up to three retries in one run, which left only two turns
// for the search work that preceded it.
const MAX_TOOL_TURNS = 8;

// Spotify searches are a DAILY allowance shared across the whole developer
// account (a few hundred requests), not a per-request resource — so a run gets
// a budget, and the model is told when it runs out rather than being allowed to
// silently exhaust the app for the rest of the day.
//
// 20 covers 8 tracks verified once each plus a dozen replacements. Cache hits
// don't count, so re-running a prompt is nearly free.
const SEARCH_BUDGET = 20;
// Ceiling on simultaneous searches. The model happily emits 9 tool_use blocks
// in one turn; firing all 9 at once is what trips the rolling-window limit.
const SEARCH_CONCURRENCY = 2;

// Run fn over items with at most `concurrency` in flight, preserving order.
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return out;
}

const SYSTEM = `You are a sharp music curator writing liner notes for a mixtape card.
Rules:
- Exactly 8 tracks, and every one must be a real recording that exists on Spotify.
- Every track must come from a search result you have actually seen. Search first, then fill the card from the rows that come back — do not decide on eight tracks and then look each one up.
- Search BROADLY, not one-track-at-a-time: a search for an artist, a scene, or a sound returns ten records, and several of them may earn a slot. Batch a few such searches in one turn, then build the card from everything they returned. Only search again when nothing you have seen fits a slot.
- Copy the artist and title spelling exactly as the result shows it, and copy that row's "ref" into the track's ref field.
- Searches cost a limited daily allowance, so never re-run a query you have already run in this conversation, and never search for a record you have already seen in earlier results.
- Order the tracks like a DJ set with an arc: an opener, a build, a peak, a comedown.
- Notes must feel human and specific, not AI-generic — a detail, a moment, a stat.
- The title is max 5 words; the vibe line is max 14 words, written like a dedication.
- Writing the card is a separate step from choosing it: once you commit, fill in all eight track slots (track1 through track8) in that single tool call.`;

const ADJUST_SYSTEM = `${SYSTEM}

You are adjusting an existing mixtape, not building a new one:
- Change ONLY what the user's adjustment asks for. Tracks the adjustment does not touch must NOT appear in changes.
- Never re-emit an unchanged track — omit its index entirely.
- Replacement notes follow the same rules as new ones: specific, human, never generic.
- Keep the DJ-set arc sensible: each replacement must sit right between its neighbors.
- Tracks marked "resolved": false could not be verified on Spotify — prefer them as swap targets when the user says a track isn't real.
- Every replacement must come from a search_spotify result, with that row's ref copied into its ref field — same rule as new tracks.
- Only include title/vibe/accent when the adjustment changes the mixtape's identity.`;

// Stubs the model reaches for when it commits a card it hasn't really
// written. "placeholder" in every field of a lone track was observed live.
const STUB_RE = /^(placeholder|tbd|todo|n\/?a|unknown|\.{2,})$/i;

function isFilled(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "" && !STUB_RE.test(v.trim());
}

// tracks arrives as {track1: {...}, …, track8: {...}} — flatten it back to the
// array the rest of the app has always used. Tolerates a plain array too, so
// a card that predates the schema change still reads.
function toTrackList(tracks: unknown): any[] {
  if (Array.isArray(tracks)) return tracks;
  if (!tracks || typeof tracks !== "object") return [];
  return TRACK_KEYS.map((key) => (tracks as any)[key]).filter(
    (t) => t !== undefined
  );
}

// Whether a create_mixtape call actually contains a mixtape.
//
// The eight-required-keys schema makes a short card ungrammatical, so this is
// no longer the thing standing between the model and a 1-track mixtape — but
// it stays, for two reasons. Empty input still happens (a wire flake where no
// deltas ever stream for the block), and `required` guarantees the keys are
// present, not that they say anything: {"artist":"placeholder"} is still a
// valid string. Substance is not a thing a schema checks.
//
// Returning a reason makes the agent loop hand the call back as a failed
// tool_result, so the model fills it in on the next turn instead of the
// route shipping a hollow card.
function cardIncompleteReason(input: Record<string, unknown>): string | null {
  if (Object.keys(input).length === 0) return "the input object was empty";
  const raw = (input as any).tracks;
  if (!raw || typeof raw !== "object") return "tracks was missing";
  const tracks = toTrackList(raw);
  if (tracks.length === 0) return "there were no tracks";
  // Only under-count is retried; over-count still falls through to the
  // clamp in generateCard, which has always been the behaviour there.
  if (tracks.length < TRACK_COUNT) {
    return `only ${tracks.length} of the ${TRACK_COUNT} track slots were filled in`;
  }
  const hollow = tracks.findIndex(
    (t: any) =>
      !t || !isFilled(t.artist) || !isFilled(t.title) || !isFilled(t.note)
  );
  if (hollow !== -1) {
    return `track ${hollow + 1} had a missing or placeholder artist, title or note`;
  }
  return null;
}

// Same gate for adjust_mixtape. An empty `changes` array is legitimate here
// (the tool's own description allows it for a title/vibe-only tweak), so the
// no-op case is what gets rejected: nothing changed at all.
function diffIncompleteReason(input: Record<string, unknown>): string | null {
  if (Object.keys(input).length === 0) return "the input object was empty";
  const changes = (input as any).changes;
  if (!Array.isArray(changes)) return "changes was not an array";
  const hollow = changes.findIndex(
    (c: any) =>
      !c?.track ||
      !isFilled(c.track.artist) ||
      !isFilled(c.track.title) ||
      !isFilled(c.track.note)
  );
  if (hollow !== -1) {
    return `change ${hollow + 1} had a missing or placeholder artist, title or note`;
  }
  const identityChanged =
    isFilled((input as any).title) ||
    isFilled((input as any).vibe) ||
    isFilled((input as any).accent);
  if (changes.length === 0 && !identityChanged) {
    return "it changed nothing — no track replacements and no new title, vibe or accent";
  }
  return null;
}

// Scan the accumulated partial JSON of the tool input and return every
// COMPLETE object found inside the named container so far ("tracks" for
// create_mixtape, "changes" for adjust_mixtape).
//
// The container is an object for create_mixtape (track1…track8) and an array
// for adjust_mixtape, so open on whichever bracket comes first and close on
// its mate. The inner scan is identical either way: complete `{...}` objects
// at depth 0, in wire order — which for track1…track8 is card order.
// String-aware brace matching — no assumptions about chunk boundaries.
function extractCompleteTracks(buf: string, arrayKey = "tracks"): any[] {
  const key = buf.indexOf(`"${arrayKey}"`);
  if (key === -1) return [];
  const candidates = [buf.indexOf("[", key), buf.indexOf("{", key)].filter(
    (i) => i !== -1
  );
  if (candidates.length === 0) return [];
  const arrStart = Math.min(...candidates);
  const closer = buf[arrStart] === "[" ? "]" : "}";
  const tracks: any[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let objStart = -1;
  for (let i = arrStart + 1; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          tracks.push(JSON.parse(buf.slice(objStart, i + 1)));
        } catch {
          // incomplete/invalid fragment — ignore, will complete later
        }
        objStart = -1;
      }
    } else if (c === closer && depth === 0) {
      break;
    }
  }
  return tracks;
}

// Serialize a seed playlist ({name, tracks: [{artist, title}], total}) into
// prompt context for "in the spirit of" generation. The dedup rule is load-
// bearing: without it the model's laziest valid answer is the playlist back.
function seedContext(seed: { name: string; tracks: { artist: string; title: string }[]; total: number }): string {
  const lines = seed.tracks.map((t) => `${t.artist} — ${t.title}`).join("\n");
  const scope =
    seed.total > seed.tracks.length
      ? `${seed.tracks.length} of its ${seed.total} tracks, sampled in playlist order`
      : `all ${seed.tracks.length} tracks`;
  return (
    `The listener wants this mixtape in the spirit of their Spotify playlist "${seed.name}" (${scope}):\n${lines}\n\n` +
    `Read this playlist's spirit — the genre blend, the era, the energy, what the picks have in common — and build a NEW mixtape that channels it.\n` +
    `Do not include any track from the list above; every pick must be a different recording.`
  );
}

// The curator agent loop: stream a turn, execute any search_spotify calls
// against Spotify, feed the results back, repeat until the model commits via
// its final tool (create_mixtape / adjust_mixtape). Returns that tool's input.
// onItem(i, item) fires as the model streams each element of the final tool's
// `arrayKey` array — the same real-event streaming the single-call version had.
async function runCuratorAgent({
  system,
  userContent,
  finalTool,
  arrayKey,
  incompleteReason,
  onItem,
  signal,
}: {
  system: string;
  userContent: string;
  finalTool: string;
  arrayKey: string;
  // Why this tool call can't be accepted, or null if it can — see
  // cardIncompleteReason. A strict schema validates types, not substance.
  incompleteReason: (input: Record<string, unknown>) => string | null;
  onItem?: (index: number, item: any) => void;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];
  let searchesSpent = 0; // quota-costing searches this run — cache hits are free

  for (let turn = 1; turn <= MAX_TOOL_TURNS; turn++) {
    const lastTurn = turn === MAX_TOOL_TURNS;
    const stream = client.messages.stream(
      {
        model: MODEL,
        // headroom for search turns' reasoning on top of the card itself
        max_tokens: 4000,
        system,
        tools: TOOLS as any,
        tool_choice: lastTurn
          ? { type: "tool", name: finalTool }
          : { type: "auto" },
        messages,
      },
      { signal }
    );

    // Stream the final tool's array items as they're written. Search calls
    // and prose stream through the same events, so key the buffer to the
    // final tool's content block, not to deltas in general.
    let finalBlockIndex = -1;
    let buf = "";
    let emitted = 0;
    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (
          event.content_block.type === "tool_use" &&
          event.content_block.name === finalTool
        ) {
          finalBlockIndex = event.index;
          buf = "";
          emitted = 0;
        }
      } else if (
        event.type === "content_block_delta" &&
        event.index === finalBlockIndex &&
        event.delta.type === "input_json_delta"
      ) {
        buf += event.delta.partial_json;
        if (!onItem) continue;
        const items = extractCompleteTracks(buf, arrayKey);
        while (emitted < items.length) {
          onItem(emitted, items[emitted]);
          emitted++;
        }
      }
    }

    const response = await stream.finalMessage();
    console.log(
      `[curator] turn ${turn}: stop=${response.stop_reason} blocks=` +
        response.content
          .map((b) => (b.type === "tool_use" ? `tool:${b.name}` : b.type))
          .join(",")
    );
    const done = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === finalTool
    );
    // A final tool call is not automatically the answer — see
    // incompleteReason. A complete one returns; an incomplete one is
    // answered below with an error result so the model calls again.
    const gap = done
      ? incompleteReason(done.input as Record<string, unknown>)
      : null;
    if (done && !gap) {
      return done.input as Record<string, unknown>;
    }

    messages.push({ role: "assistant", content: response.content });
    const searches = response.content.filter(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === SEARCH_TOOL.name
    );
    if (searches.length === 0 && !done) {
      // text-only turn — nudge it to commit instead of narrating
      messages.push({
        role: "user",
        content: `Record the final result now with ${finalTool}.`,
      });
      continue;
    }
    if (searches.length > 0) {
      console.log(`[curator] turn ${turn}: ${searches.length} spotify searches`);
    }
    // All results go back in ONE user message — splitting them across
    // messages trains the model out of batching its searches. Batching is still
    // what we want; the pool below just stops all of them leaving at once.
    const results: Anthropic.ToolResultBlockParam[] = await mapPool(
      searches,
      SEARCH_CONCURRENCY,
      async (s) => {
        const query = String((s.input as any)?.query ?? "");
        const free = isSearchCached(query);
        if (!free && searchesSpent >= SEARCH_BUDGET) {
          // Out of budget. Note what this does NOT say: it never invites the
          // model to fall back on its own knowledge. Verified-only is the
          // whole point of the search loop.
          return {
            type: "tool_result" as const,
            tool_use_id: s.id,
            content:
              `Search budget for this mixtape is used up (${SEARCH_BUDGET} searches). ` +
              `Commit now using only tracks that already came back in earlier ` +
              `search results — do not add a track you have not seen verified.`,
            is_error: true,
          };
        }
        if (!free) searchesSpent++;
        try {
          const found = await searchCatalog(query);
          return {
            type: "tool_result" as const,
            tool_use_id: s.id,
            content: JSON.stringify(found),
          };
        } catch (err: any) {
          // Exhausted daily quota is NOT a degradable condition: resolution is
          // about to fail on every track too, so "rely on your own knowledge"
          // would just produce an unverifiable card full of plausible
          // inventions. Fail the run and say why.
          if (err.quotaExceeded) throw err;
          // A transient outage still degrades to the old behavior (model's own
          // judgment + the resolution gate), rather than killing the run.
          console.warn(`[curator] search_spotify failed: ${err.message}`);
          return {
            type: "tool_result" as const,
            tool_use_id: s.id,
            content:
              "Spotify search is unavailable right now — rely on your own knowledge and prefer well-known recordings.",
            is_error: true,
          };
        }
      }
    );
    if (done) {
      console.warn(
        `[curator] turn ${turn}: incomplete ${finalTool} (${gap}) — retrying`
      );
      results.push({
        type: "tool_result",
        tool_use_id: done.id,
        content:
          `Your ${finalTool} call was not usable: ${gap}. ` +
          `Nothing was recorded. Call ${finalTool} again now, in a single ` +
          `call, with every field filled in — you already have the search ` +
          `results you need, so do not search again.`,
        is_error: true,
      });
    }
    messages.push({ role: "user", content: results });
  }
  // The last turn forces the final tool, so we only land here when even that
  // forced call came back incomplete.
  throw new Error(`Curator never produced a complete ${finalTool} call`);
}

// Generate a card. onTrack(index, {artist, title}) fires as the model streams
// each track — real events, straight from the tool-input stream.
// seed (optional): an existing playlist to channel — see seedContext. With a
// seed the prompt may be empty ("just like this playlist" is a valid ask).
// signal (optional): aborting kills the model stream mid-flight (client
// disconnect must stop the paid request); iteration then throws an abort error.
async function generateCard(
  prompt: string,
  {
    seed,
    onTrack,
    signal,
  }: {
    seed?: { name: string; tracks: { artist: string; title: string }[]; total: number } | null;
    onTrack?: (index: number, t: { artist: string; title: string }) => void;
    signal?: AbortSignal;
  } = {}
): Promise<MixtapeCard> {
  const parts = [
    prompt ? `Build a playlist for this prompt: "${prompt}"` : "Build a playlist.",
  ];
  if (seed) parts.push(seedContext(seed));

  const input = await runCuratorAgent({
    system: SYSTEM,
    userContent: parts.join("\n\n"),
    finalTool: "create_mixtape",
    arrayKey: "tracks",
    incompleteReason: cardIncompleteReason,
    signal,
    onItem: onTrack
      ? (i, t) => {
          // never emit past TRACK_COUNT — the post-stream clamp drops the
          // excess, so the client must not see rows that won't be on the card
          if (i < TRACK_COUNT && t && t.artist && t.title) onTrack(i, t);
        }
      : undefined,
  });

  // track1…track8 back into the array the rest of the app speaks.
  const card = { ...input, tracks: toTrackList((input as any).tracks) } as unknown as MixtapeCard;
  if (card.tracks.length === 0) {
    throw new Error("Curator returned no tracks");
  }
  // Belt-and-braces: eight required keys and additionalProperties:false make
  // a wrong-length card ungrammatical, so this should now be unreachable —
  // but toTrackList still accepts a plain array, and a silent "10 tracks" is
  // exactly the class of bug that hid here before. Log loudly if it ever fires.
  if (card.tracks.length !== TRACK_COUNT) {
    console.warn(
      `[curator] model returned ${card.tracks.length} tracks, expected ${TRACK_COUNT} — clamping`
    );
    card.tracks = card.tracks.slice(0, TRACK_COUNT);
  }
  // How many tracks carry a real ref is the single best signal for whether the
  // search loop is doing its job: every ref is a resolution request not spent,
  // and a card of all-NO_REF means the model committed without verifying.
  const withRef = card.tracks.filter((t) => t.ref && t.ref !== NO_REF).length;
  console.log(`[curator] ${withRef}/${card.tracks.length} tracks committed with a search ref`);
  return card;
}

// Adjust an existing card — stateless single-turn (the card travels as JSON in
// the user message, no replayed transcript). Returns a validated diff:
//   { changes: [{index, track: {artist, title, note}}], title?, vibe?, accent? }
// onChange(i, {index, track}) fires as the model streams each complete change.
// signal: same abort contract as generateCard.
async function adjustCard(
  card: MixtapeCard,
  adjustment: string,
  {
    onChange,
    signal,
  }: {
    onChange?: (i: number, c: { index: number; track: { artist: string; title: string } }) => void;
    signal?: AbortSignal;
  } = {}
): Promise<AdjustDiff> {
  // Strip spotify resolution fields — the model doesn't need them. The
  // `resolved` flag stays: unverified tracks are the natural swap targets.
  const minimalCard = {
    title: card.title,
    vibe: card.vibe,
    accent: card.accent,
    tracks: card.tracks.map((t, index) => ({
      index,
      artist: t.artist,
      title: t.title,
      note: t.note,
      resolved: Boolean(t.resolved),
    })),
  };

  const result = (await runCuratorAgent({
    system: ADJUST_SYSTEM,
    userContent:
      `Original prompt: "${card.prompt || ""}"\n` +
      `Current mixtape (JSON):\n${JSON.stringify(minimalCard)}\n\n` +
      `User adjustment: "${adjustment}"`,
    finalTool: "adjust_mixtape",
    arrayKey: "changes",
    incompleteReason: diffIncompleteReason,
    signal,
    onItem: onChange
      ? (i, c) => {
          if (
            c &&
            Number.isInteger(c.index) &&
            c.track &&
            c.track.artist &&
            c.track.title
          ) {
            onChange(i, c);
          }
        }
      : undefined,
  })) as any;
  const rawChanges = Array.isArray(result.changes) ? result.changes : [];
  // Strict schemas can't enforce array length, index range against THIS card,
  // or duplicate indices — clamp/validate here, like the 8-track clamp above.
  const seen = new Set<number>();
  const changes: AdjustDiff["changes"] = [];
  for (const c of rawChanges) {
    const valid =
      c &&
      Number.isInteger(c.index) &&
      c.index >= 0 &&
      c.index < card.tracks.length &&
      c.track &&
      typeof c.track.artist === "string" &&
      c.track.artist &&
      typeof c.track.title === "string" &&
      c.track.title &&
      typeof c.track.note === "string";
    if (!valid) {
      console.warn(
        `[curator] dropping malformed/out-of-range change: ${JSON.stringify(c)}`
      );
      continue;
    }
    if (seen.has(c.index)) {
      console.warn(`[curator] dropping duplicate change for index ${c.index}`);
      continue;
    }
    seen.add(c.index);
    changes.push({
      index: c.index,
      track: { artist: c.track.artist, title: c.track.title, note: c.track.note },
    });
  }
  const diff: AdjustDiff = { changes };
  if (typeof result.title === "string" && result.title) diff.title = result.title;
  if (typeof result.vibe === "string" && result.vibe) diff.vibe = result.vibe;
  if (typeof result.accent === "string" && result.accent) diff.accent = result.accent;
  return diff;
}

export type { Track, MixtapeCard };
export {
  anthropicConfigured,
  generateCard,
  adjustCard,
  MODEL,
  TRACK_COUNT,
  // exported for tests only
  extractCompleteTracks,
  toTrackList,
  seedContext,
  cardIncompleteReason,
  diffIncompleteReason,
  TRACK_SCHEMA,
  NO_REF,
  mapPool,
  SEARCH_BUDGET,
  SEARCH_CONCURRENCY,
};
