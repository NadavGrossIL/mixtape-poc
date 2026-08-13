// Claude curator: prompt in → validated mixtape card out.
// Uses forced tool choice + strict tool schema so the JSON arrives validated —
// no markdown-fence stripping, no regex.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5";

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

const SYSTEM = `You are a sharp music curator writing liner notes for a mixtape card.
Rules:
- Exactly 8 tracks. Real, well-known recordings only — if unsure a song exists, pick one you are sure of.
- Order the tracks like a DJ set with an arc: an opener, a build, a peak, a comedown.
- Notes must feel human and specific, not AI-generic — a detail, a moment, a stat.
- The title is max 5 words; the vibe line is max 14 words, written like a dedication.`;

async function generateCard(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [CURATOR_TOOL],
    tool_choice: { type: "tool", name: "create_mixtape" },
    messages: [
      {
        role: "user",
        content: `Build a playlist for this prompt: "${prompt}"`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Curator returned no tool_use block");
  }
  const card = toolUse.input;
  if (!Array.isArray(card.tracks) || card.tracks.length === 0) {
    throw new Error("Curator returned no tracks");
  }
  // Strict schemas can't enforce array length — clamp here as a safety net.
  card.tracks = card.tracks.slice(0, 8);
  return card;
}

module.exports = { anthropicConfigured, generateCard, MODEL };
