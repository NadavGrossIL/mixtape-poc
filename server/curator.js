// Claude curator: prompt in → validated mixtape card out.
// Uses forced tool choice + strict tool schema so the JSON arrives validated —
// no markdown-fence stripping, no regex.
// Streaming: fine-grained tool-input streaming (eager_input_streaming, GA — no
// beta header) lets us emit each track as the model produces it.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5";
const TRACK_COUNT = 8;

const PLACEHOLDER_RE = /^(your_|<|\.\.\.|xxx)/i;

function anthropicConfigured() {
  const key = process.env.ANTHROPIC_API_KEY || "";
  return key.length > 0 && !PLACEHOLDER_RE.test(key);
}

const CURATOR_TOOL = {
  name: "create_mixtape",
  description:
    "Record the finished mixtape card: a title, a dedication-style vibe line, an accent color, and exactly 8 tracks in DJ-set order, each with a one-line liner note.",
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
        enum: ["crimson", "cobalt", "forest", "tangerine", "violet", "gold"],
        description: "Accent color matching the mood.",
      },
      tracks: {
        type: "array",
        description: "Exactly 8 tracks, ordered like a DJ set with an arc.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["artist", "title", "note"],
          properties: {
            artist: { type: "string", description: "The recording artist's name." },
            title: { type: "string", description: "The track title." },
            note: {
              type: "string",
              description:
                "One specific, concrete reason this track earns its place — a detail, a moment, a stat. Max 18 words. Never generic.",
            },
          },
        },
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
        enum: ["crimson", "cobalt", "forest", "tangerine", "violet", "gold"],
      },
    },
  },
};

const SYSTEM = `You are a sharp music curator writing liner notes for a mixtape card.
Rules:
- Exactly 8 tracks. Real, well-known recordings only — if unsure a song exists, pick one you are sure of.
- Order the tracks like a DJ set with an arc: an opener, a build, a peak, a comedown.
- Notes must feel human and specific, not AI-generic — a detail, a moment, a stat.
- The title is max 5 words; the vibe line is max 14 words, written like a dedication.`;

const ADJUST_SYSTEM = `${SYSTEM}

You are adjusting an existing mixtape, not building a new one:
- Change ONLY what the user's adjustment asks for. Tracks the adjustment does not touch must NOT appear in changes.
- Never re-emit an unchanged track — omit its index entirely.
- Replacement notes follow the same rules as new ones: specific, human, never generic.
- Keep the DJ-set arc sensible: each replacement must sit right between its neighbors.
- Tracks marked "resolved": false could not be verified on Spotify — prefer them as swap targets when the user says a track isn't real.
- Only include title/vibe/accent when the adjustment changes the mixtape's identity.`;

// Scan the accumulated partial JSON of the tool input and return every
// COMPLETE object found inside the named array so far ("tracks" for
// create_mixtape, "changes" for adjust_mixtape).
// String-aware brace matching — no assumptions about chunk boundaries.
function extractCompleteTracks(buf, arrayKey = "tracks") {
  const key = buf.indexOf(`"${arrayKey}"`);
  if (key === -1) return [];
  const arrStart = buf.indexOf("[", key);
  if (arrStart === -1) return [];
  const tracks = [];
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
    } else if (c === "]" && depth === 0) {
      break;
    }
  }
  return tracks;
}

// Serialize a seed playlist ({name, tracks: [{artist, title}], total}) into
// prompt context for "in the spirit of" generation. The dedup rule is load-
// bearing: without it the model's laziest valid answer is the playlist back.
function seedContext(seed) {
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

// Generate a card. onTrack(index, {artist, title}) fires as the model streams
// each track — real events, straight from the tool-input stream.
// seed (optional): an existing playlist to channel — see seedContext. With a
// seed the prompt may be empty ("just like this playlist" is a valid ask).
// signal (optional): aborting kills the model stream mid-flight (client
// disconnect must stop the paid request); iteration then throws an abort error.
async function generateCard(prompt, { seed, onTrack, signal } = {}) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const parts = [
    prompt ? `Build a playlist for this prompt: "${prompt}"` : "Build a playlist.",
  ];
  if (seed) parts.push(seedContext(seed));

  const stream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [CURATOR_TOOL],
      tool_choice: { type: "tool", name: "create_mixtape" },
      messages: [
        {
          role: "user",
          content: parts.join("\n\n"),
        },
      ],
    },
    { signal }
  );

  let buf = "";
  let emitted = 0;
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "input_json_delta"
    ) {
      buf += event.delta.partial_json;
      if (!onTrack) continue;
      const tracks = extractCompleteTracks(buf);
      // never emit past TRACK_COUNT — the post-stream clamp drops the excess,
      // so the client must not see rows that won't be on the card
      while (emitted < tracks.length && emitted < TRACK_COUNT) {
        const t = tracks[emitted];
        if (t && t.artist && t.title) onTrack(emitted, t);
        emitted++;
      }
    }
  }

  const response = await stream.finalMessage();
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Curator returned no tool_use block");
  }
  const card = toolUse.input;
  if (!Array.isArray(card.tracks) || card.tracks.length === 0) {
    throw new Error("Curator returned no tracks");
  }
  // Strict schemas can't enforce array length — clamp here as a safety net,
  // and log loudly when the model ignored the spec (this is how "10 tracks"
  // slips through silently otherwise).
  if (card.tracks.length !== TRACK_COUNT) {
    console.warn(
      `[curator] model returned ${card.tracks.length} tracks, expected ${TRACK_COUNT} — clamping`
    );
    card.tracks = card.tracks.slice(0, TRACK_COUNT);
  }
  return card;
}

// Adjust an existing card — stateless single-turn (the card travels as JSON in
// the user message, no replayed transcript). Returns a validated diff:
//   { changes: [{index, track: {artist, title, note}}], title?, vibe?, accent? }
// onChange(i, {index, track}) fires as the model streams each complete change.
// signal: same abort contract as generateCard.
async function adjustCard(card, adjustment, { onChange, signal } = {}) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  const stream = client.messages.stream(
    {
      model: MODEL,
      max_tokens: 2000,
      system: ADJUST_SYSTEM,
      // Static tool list (both tools, always) — varying it would invalidate the
      // compiled-grammar cache.
      tools: [CURATOR_TOOL, ADJUST_TOOL],
      tool_choice: { type: "tool", name: "adjust_mixtape" },
      messages: [
        {
          role: "user",
          content:
            `Original prompt: "${card.prompt || ""}"\n` +
            `Current mixtape (JSON):\n${JSON.stringify(minimalCard)}\n\n` +
            `User adjustment: "${adjustment}"`,
        },
      ],
    },
    { signal }
  );

  let buf = "";
  let emitted = 0;
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "input_json_delta"
    ) {
      buf += event.delta.partial_json;
      if (!onChange) continue;
      const changes = extractCompleteTracks(buf, "changes");
      while (emitted < changes.length) {
        const c = changes[emitted];
        if (
          c &&
          Number.isInteger(c.index) &&
          c.track &&
          c.track.artist &&
          c.track.title
        ) {
          onChange(emitted, c);
        }
        emitted++;
      }
    }
  }

  const response = await stream.finalMessage();
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Curator returned no tool_use block");
  }
  const result = toolUse.input;
  const rawChanges = Array.isArray(result.changes) ? result.changes : [];
  // Strict schemas can't enforce array length, index range against THIS card,
  // or duplicate indices — clamp/validate here, like the 8-track clamp above.
  const seen = new Set();
  const changes = [];
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
  const diff = { changes };
  if (typeof result.title === "string" && result.title) diff.title = result.title;
  if (typeof result.vibe === "string" && result.vibe) diff.vibe = result.vibe;
  if (typeof result.accent === "string" && result.accent) diff.accent = result.accent;
  return diff;
}

module.exports = {
  anthropicConfigured,
  generateCard,
  adjustCard,
  MODEL,
  TRACK_COUNT,
  // exported for tests only
  extractCompleteTracks,
  seedContext,
};
