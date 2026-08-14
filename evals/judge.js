// Eval step 2: the truthfulness judge.
//
// For each card, ONE judge call (cost: batches all 8 notes) classifies every
// liner note and fact-checks the checkable ones with the server-side
// web_search tool. Verdicts come back through a strict tool schema.
//
// Usage:
//   node evals/judge.js                    # judge the latest run
//   node evals/judge.js evals/runs/<ts>    # judge a specific run
//
// Writes <run>/verdicts.json (incrementally, one entry per card).

const fs = require("fs");
const path = require("path");
const {
  loadServerEnv,
  requireAnthropic,
  resolveRunDir,
  readJson,
  writeJson,
} = require("./util");

loadServerEnv();

const Anthropic = requireAnthropic();

const JUDGE_MODEL = "claude-opus-5";
const MAX_SEARCHES_PER_CARD = 15; // hard cap; the prompt caps ~3 per note
const MAX_TURNS = 10; // pause_turn / retry safety bound

const VERDICTS_TOOL = {
  name: "record_verdicts",
  description:
    "Record the final classification and verification verdict for every liner note on the card. Call exactly once, after all fact-checking is done, with one entry per note in index order.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        description: "One entry per liner note, in index order (0-based).",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "index",
            "classification",
            "verification",
            "reasoning",
            "evidence",
          ],
          properties: {
            index: { type: "integer", description: "0-based note index." },
            classification: {
              type: "string",
              enum: ["generic", "specific-subjective", "specific-checkable"],
              description: "Which content class the note falls into.",
            },
            verification: {
              type: "string",
              enum: ["true", "invented", "unverifiable", "not-applicable"],
              description:
                "Verification outcome. Must be 'not-applicable' unless classification is 'specific-checkable'.",
            },
            reasoning: {
              type: "string",
              description:
                "Concise justification: what claim was checked, what the evidence showed (or why no check applies).",
            },
            evidence: {
              type: "array",
              description:
                "Sources consulted. REQUIRED non-empty for a 'true' verdict; empty for non-checkable notes.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["url", "snippet"],
                properties: {
                  url: { type: "string", description: "Source URL." },
                  snippet: {
                    type: "string",
                    description: "The confirming/contradicting snippet from that source.",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const JUDGE_SYSTEM = `You are a skeptical fact-checking judge for mixtape liner notes. Each note is a one-line claim about a specific song. Your job: classify every note, and verify the ones that assert checkable facts.

Classification (pick exactly one per note):
- "generic" — no concrete detail unique to this track; the sentence would fit many songs (e.g. "a perfect late-night groove").
- "specific-subjective" — concrete imagery or opinion tied to the track but not fact-checkable (e.g. "the bassline mimics lane markers ticking past").
- "specific-checkable" — asserts a verifiable fact: a lyric quote, a timestamp, a stat (BPM, chart position, speed record, solo length), a credit (producer, sample, featured artist), a release detail (year, label, album), or a historical claim. Only these proceed to verification.

Verification (only for "specific-checkable"; everything else gets "not-applicable"):
- "true" — web evidence confirms the fact. You MUST cite the source URL and the confirming snippet in the evidence array.
- "invented" — evidence contradicts the fact, or the claimed fact demonstrably does not exist (including: the song itself does not exist, or the artist—title attribution is wrong).
- "unverifiable" — you searched and found no adequate evidence either way.

JUDGE RULES (binding):
- Default skeptical.
- "true" requires cited evidence, never model memory. If you did not find a source, the verdict cannot be "true".
- "unverifiable" is the mandatory fallback and must NEVER be merged with "true" in reporting. When in doubt between true and unverifiable, choose unverifiable.
- A lyric quote counts "true" only if the quoted words actually appear in the song's lyrics per a source.
- Also verify the artist—title attribution implied by the note when checking: if the note's fact is real but belongs to a different song or artist, or the song does not exist as attributed, the verdict is "invented".
- Search budget: at most 3 web searches per note, and search only for "specific-checkable" notes. Batch efficiently — one search can settle several notes about well-documented songs.

When all notes are handled, call record_verdicts exactly once with one entry per note (indexes 0 through N-1, in order). Do not answer in prose.`;

// Finding 9: the judge prompt's binding rule — a "true" verdict requires
// cited evidence — cannot be expressed in the strict schema, so enforce it
// here instead of trusting the model. Same for the verification enum itself
// (strict mode should guarantee it, but don't rely on that). Violations are
// downgraded to "unverifiable", never dropped: the record keeps the original
// value in `rawVerification` plus a `downgraded` flag so aggregate.js can
// count them.
const VALID_VERIFICATIONS =
  VERDICTS_TOOL.input_schema.properties.verdicts.items.properties.verification.enum;

function enforceVerdict(v, cardId) {
  if (!VALID_VERIFICATIONS.includes(v.verification)) {
    console.warn(
      `[judge]   downgrade ${cardId}#${v.index}: unknown verification ${JSON.stringify(v.verification)} -> "unverifiable"`
    );
    return {
      ...v,
      rawVerification: v.verification,
      verification: "unverifiable",
      downgraded: "invalid-verdict",
    };
  }
  if (v.verification === "true" && !(Array.isArray(v.evidence) && v.evidence.length > 0)) {
    console.warn(
      `[judge]   downgrade ${cardId}#${v.index}: "true" with no cited evidence -> "unverifiable"`
    );
    return {
      ...v,
      rawVerification: v.verification,
      verification: "unverifiable",
      downgraded: "evidence-missing",
    };
  }
  return v;
}

// Finding 17: an entry only counts as done if it actually carries verdicts —
// error entries stay in the file for the record but get retried on rerun.
function doneIds(existing) {
  return new Set(existing.filter((e) => e.notes).map((e) => e.id));
}

// Finding 17: a retried card replaces its earlier (error) entry instead of
// appending a duplicate id.
function upsert(list, entry) {
  const at = list.findIndex((e) => e.id === entry.id);
  if (at === -1) list.push(entry);
  else list[at] = entry;
}

function buildCardMessage(entry) {
  const lines = entry.card.tracks.map(
    (t, i) => `${i}. ${t.artist} — "${t.title}"\n   note: ${JSON.stringify(t.note)}`
  );
  return `Playlist prompt: ${JSON.stringify(entry.prompt)}
Card title: ${JSON.stringify(entry.card.title)}

Liner notes to judge (${entry.card.tracks.length} tracks):

${lines.join("\n")}`;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
  };
}

function addUsage(total, usage) {
  if (!usage) return;
  total.input_tokens += usage.input_tokens || 0;
  total.output_tokens += usage.output_tokens || 0;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  total.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  total.web_search_requests += usage.server_tool_use?.web_search_requests || 0;
}

// One judge conversation per card. Loops on pause_turn (server-side search
// iteration limit) and nudges once if the model ends without calling the tool.
async function judgeCard(client, entry, usageTotal) {
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES_PER_CARD },
    VERDICTS_TOOL,
  ];
  const messages = [{ role: "user", content: buildCardMessage(entry) }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: JUDGE_SYSTEM,
          cache_control: { type: "ephemeral" }, // tools+system cached across the 18 cards
        },
      ],
      tools,
      messages,
    });
    addUsage(usageTotal, response.usage);

    const toolUse = response.content.find(
      (b) => b.type === "tool_use" && b.name === "record_verdicts"
    );
    if (toolUse) return toolUse.input.verdicts;

    if (response.stop_reason === "pause_turn") {
      // Server-side search loop paused — re-send to resume.
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    if (response.stop_reason === "refusal") {
      throw new Error("judge refused the request");
    }

    // Ended without the tool call — nudge once, then keep looping.
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content:
        "Now call record_verdicts exactly once with your final verdict for every note.",
    });
  }
  throw new Error(`no record_verdicts call after ${MAX_TURNS} turns`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[judge] ANTHROPIC_API_KEY missing — check server/.env");
    process.exit(1);
  }

  const runDir = resolveRunDir(process.argv.slice(2));
  const cards = readJson(path.join(runDir, "cards.json")).filter((e) => e.card);
  const verdictsPath = path.join(runDir, "verdicts.json");
  const existing = fs.existsSync(verdictsPath) ? readJson(verdictsPath) : [];
  const done = doneIds(existing);
  const retriable = existing.length - done.size;

  console.log(`[judge] run dir: ${runDir}`);
  console.log(
    `[judge] ${cards.length} cards, model ${JUDGE_MODEL} (${done.size} already judged${retriable ? `, ${retriable} failed — retrying` : ""})`
  );

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results = existing;

  for (const [i, entry] of cards.entries()) {
    if (done.has(entry.id)) continue;
    console.log(`\n[judge] ${i + 1}/${cards.length} (${entry.id})`);
    const usage = emptyUsage();
    let verdicts;
    try {
      verdicts = await judgeCard(client, entry, usage);
    } catch (err) {
      console.error(`[judge] ✗ ${entry.id}: ${err.message}`);
      upsert(results, { id: entry.id, error: err.message, usage });
      writeJson(verdictsPath, results);
      continue;
    }

    const notes = entry.card.tracks.map((t, idx) => {
      const raw = verdicts.find((x) => x.index === idx) || null;
      const v = raw ? enforceVerdict(raw, entry.id) : null;
      const note = {
        index: idx,
        artist: t.artist,
        title: t.title,
        note: t.note,
        resolved: t.resolved,
        classification: v ? v.classification : "missing",
        verification: v ? v.verification : "missing",
        reasoning: v ? v.reasoning : "judge returned no verdict for this index",
        evidence: v && Array.isArray(v.evidence) ? v.evidence : [],
      };
      if (v && v.downgraded) {
        note.downgraded = v.downgraded;
        note.rawVerification = v.rawVerification;
      }
      return note;
    });

    const summary = notes.map((n) =>
      n.classification === "specific-checkable" ? n.verification : n.classification
    );
    console.log(`[judge]   verdicts: ${summary.join(", ")}`);
    console.log(`[judge]   searches: ${usage.web_search_requests}`);

    upsert(results, {
      id: entry.id,
      category: entry.category,
      prompt: entry.prompt,
      cardTitle: entry.card.title,
      notes,
      usage,
    });
    writeJson(verdictsPath, results); // incremental
  }

  console.log(`\n[judge] done → ${verdictsPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for evals/selftest.js — pure logic only, no API calls.
module.exports = { enforceVerdict, doneIds, upsert };
