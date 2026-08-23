// Claude curator: prompt in → validated mixtape card out.
// Uses forced tool choice + strict tool schema so the JSON arrives validated —
// no markdown-fence stripping, no regex.
// Streaming: fine-grained tool-input streaming (eager_input_streaming, GA — no
// beta header) lets us emit each track as the model produces it.

import Anthropic from "@anthropic-ai/sdk";
import {
  searchCatalog,
  isSearchCached,
  recallByRef,
  normalize,
  stripSuffixes,
  formatClock,
} from "./spotify.ts";

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
        "One concrete reason this track earns its place — a fact a search result showed you, lore you'd stake the tape on, or a vivid image of the sound. No unseen numbers, remembered lyrics, or guessed credits. Max 18 words. Never generic.",
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
            track: TRACK_SCHEMA,
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
    "Search Spotify's track catalog. Returns up to 10 real records, each with a ref, artist, title, album, year, and length and position when known. " +
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
- Notes must feel human and specific, not AI-generic — a catalog fact, a piece of lore, an image of the sound.
- Every fact in a note must be either something a search result showed you (artist, title, album, year, length, position) or something so famous you would stake the whole tape on it. Merely pretty sure means leave it out.
- Never put a number in a note that no search result showed you: no unseen track lengths, no timestamps, no BPMs, no take counts. Never quote a lyric from memory. Never name a producer, label, sample, or side-project unless that connection is what the song is famous for.
- When you have no fact, describe the sound instead — what the track does to the room, the road, the hour. A vivid image beats a shaky stat, and both beat a generic compliment.
- The title is max 5 words; the vibe line is max 14 words, written like a dedication.
- Writing the card is a separate step from choosing it: once you commit, fill in all eight track slots (track1 through track8) in that single tool call.`;

const ADJUST_SYSTEM = `${SYSTEM}

You are adjusting an existing mixtape, not building a new one:
- Change ONLY what the user's adjustment asks for. Tracks the adjustment does not touch must NOT appear in changes.
- Never re-emit an unchanged track — omit its index entirely.
- Replacement notes follow the same rules as create_mixtape notes: shown facts, staked lore, or a vivid image of the sound — no guessed specifics. Max 18 words.
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

// ── note grounding: deterministic claims-vs-shown-rows gate ─────
//
// Checks a committed card's notes against the exact search records the model
// cited (by ref), for the claim shapes those records can refute: years,
// durations/timestamps, album position, and "title track". Measured on the 2026-08-18
// baseline: 4 of that run's 18 invented notes are hard catches, and of its 70
// non-invented notes exactly one matches any pattern here (Free Bird's true
// "over nine minutes") and passes — 0 false positives observed. Every rule is
// a no-op when the ref doesn't join or the needed field is null (cache rows
// written before the field expansion — see trimItem).

// Years a liner note can plausibly assert. Deliberately wider than "valid
// release years" — a note claiming 2093 should surface as a mismatch, not
// slip past the regex. Canonical copy: evals/grounding.ts imports this, so
// the gate and the eval diagnostic can never drift apart.
const YEAR_RE = /\b(1[89]\d{2}|20\d{2})\b/g;

function extractYears(note: unknown): string[] {
  return [...String(note ?? "").matchAll(YEAR_RE)].map((m) => m[0]);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
// "six minutes", "six aching minutes", "8 minutes" — at most ONE intervening
// word (captured, for the idiom check), so a number several words away can't
// bind to a stray "minutes".
const WORDED_MINUTES_RE =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?:\s+([a-z]+))?\s+minutes?\b/gi;
// "1:50" — a clock reading, length or position.
const CLOCK_RE = /\b(\d{1,2}):([0-5]\d)\b/g;

// A duration pattern next to these words is a POSITION in the track, not its
// length — "waits eight minutes before the solo" claims a timestamp, and the
// only thing the row can refute is a timestamp past the track's end.
// "around" is positional only next to a CLOCK reading ("kick in around 1:50");
// before a worded quantity it approximates a LENGTH ("around six minutes"),
// which the ±30s tolerance already absorbs — see the position check below.
const POSITION_BEFORE = new Set(["at", "by", "waits"]);
const POSITION_AFTER = new Set(["before", "into", "past", "in"]);
// Directional words get a strict check INSTEAD of the ±30s tolerance: "under
// two minutes" vs 2:17 is off by only 17s, but the direction itself is the
// invention (an observed baseline case).
const DIRECTIONAL = new Set(["under", "over", "nearly", "almost"]);

// Album-position claim shapes. 5 of the 2026-08-23 validation run's 13
// invented notes wrongly asserted "opens/closes the album" — the new dominant
// failure once durations were grounded.
const OPENER_RE = /\b(?:opens|opener|opening\s+(?:cut|track|song|number))\b/i;
const CLOSER_RE = /\b(?:closes|closer|closing\s+(?:cut|track|song|number))\b/i;

// An opener/closer keyword only counts as an ALBUM claim with album context —
// "opens the tape" is the mixtape arc the prompt itself asks for. Context is
// any of: the word "album", the row's album name in the note, or an
// off/from/on link within 3 tokens after the keyword (the wrong-album form:
// "Closing cut off Memories" when the cited row says Pylon).
function albumPositionContext(note: string, item: any, m: RegExpExecArray): boolean {
  if (/\balbum\b/i.test(note)) return true;
  const albumName = normalize(stripSuffixes(item?.album?.name ?? ""));
  if (albumName && normalize(note).includes(albumName)) return true;
  const tokens = note
    .slice(m.index + m[0].length)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return tokens.some((t) => /^(?:off|from|on)$/i.test(t.replace(/[^a-zA-Z]/g, "")));
}

function wordBefore(text: string, index: number): string {
  const m = /([a-z]+)[^a-z]*$/i.exec(text.slice(0, index));
  return m ? m[1]!.toLowerCase() : "";
}

function wordAfter(text: string, index: number): string {
  const m = /^[^a-z]*([a-z]+)/i.exec(text.slice(index));
  return m ? m[1]!.toLowerCase() : "";
}

// Every duration-shaped claim in a note, with its position for context words.
function durationClaims(
  note: string
): { text: string; seconds: number; start: number; end: number; kind: "worded" | "clock" }[] {
  const claims: { text: string; seconds: number; start: number; end: number; kind: "worded" | "clock" }[] = [];
  for (const m of note.matchAll(WORDED_MINUTES_RE)) {
    const raw = m[1]!.toLowerCase();
    // "one more minute of this" is an idiom about the listener, not the track
    if (raw === "one" && m[2]?.toLowerCase() === "more") continue;
    const minutes = NUMBER_WORDS[raw] ?? Number(raw);
    claims.push({
      text: m[0],
      seconds: minutes * 60,
      start: m.index,
      end: m.index + m[0].length,
      kind: "worded",
    });
  }
  for (const m of note.matchAll(CLOCK_RE)) {
    const end = m.index + m[0].length;
    // "a 2:00 AM confession" is a time of day, not a track length
    if (/^\s*[ap]\.?m\b/i.test(note.slice(end))) continue;
    claims.push({
      text: m[0],
      seconds: Number(m[1]) * 60 + Number(m[2]),
      start: m.index,
      end,
      kind: "clock",
    });
  }
  return claims;
}

// Why a committed card's notes can't ship as-is, or null. Returns the reason
// for the FIRST violating note only — one bounce carries one correction.
// `lookup` joins a track's ref to the search record the server fetched
// (production passes spotify's recallByRef; tests inject fixtures).
function noteGroundingReason(
  input: Record<string, unknown>,
  lookup: (ref: string) => any | null
): string | null {
  const tracks = toTrackList((input as any).tracks);
  // The instruction never invites substituting another unverified fact — a
  // bounced model told "fix the number" would just guess a new number.
  const fix = "rewrite the note using only facts your search results showed";
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const ref = t?.ref;
    if (typeof ref !== "string" || !ref || ref === NO_REF) continue;
    const item = lookup(ref);
    if (!item) continue;
    const note = String(t?.note ?? "");

    // 1. Year vs the shown release year. ±1 absorbs reissue-date jitter, and
    // a year that appears in the row's own title or album name is a NAME, not
    // a date claim ("1979" by Smashing Pumpkins on a 1995 album).
    const shownYear = String(item?.album?.release_date || "").slice(0, 4);
    if (shownYear && Number.isFinite(Number(shownYear))) {
      for (const y of extractYears(note)) {
        if (Math.abs(Number(y) - Number(shownYear)) <= 1) continue;
        if (String(item?.name ?? "").includes(y)) continue;
        if (String(item?.album?.name ?? "").includes(y)) continue;
        return `track ${i + 1}'s note says "${y}", but the search result you cited shows ${shownYear} — ${fix}`;
      }
    }

    // 2. Duration claims vs the shown length. > 0, not just a number: Spotify
    // occasionally returns duration_ms 0, and every position claim would flag
    // against a 0:00 track.
    if (typeof item?.duration_ms === "number" && item.duration_ms > 0) {
      const actual = item.duration_ms / 1000;
      const shown = formatClock(item.duration_ms);
      for (const c of durationClaims(note)) {
        const before = wordBefore(note, c.start);
        const after = wordAfter(note, c.end);
        if (
          POSITION_BEFORE.has(before) ||
          POSITION_AFTER.has(after) ||
          (c.kind === "clock" && before === "around")
        ) {
          // a position is only refutable when it points past the end
          if (c.seconds > actual) {
            return `track ${i + 1}'s note puts a moment at "${c.text}", but the search result you cited shows the track is only ${shown} long — ${fix}`;
          }
        } else if (DIRECTIONAL.has(before)) {
          const ok = before === "over" ? actual > c.seconds : actual < c.seconds;
          if (!ok) {
            return `track ${i + 1}'s note says "${before} ${c.text}", but the search result you cited shows the track's length as ${shown} — ${fix}`;
          }
        } else {
          // Worded minutes keep ±30s — "six minutes" is honest rounding for
          // 5:41. A clock claim gets ±5s: the model SEES the length now, so
          // "9:19" against a shown 9:08 is an invention, not rounding
          // (measured: 2 of the 2026-08-23 run's invented notes sat inside
          // the old ±30s window on exact clocks).
          const tolerance = c.kind === "clock" ? 5 : 30;
          if (Math.abs(c.seconds - actual) > tolerance) {
            return `track ${i + 1}'s note calls it "${c.text}", but the search result you cited shows the track's length as ${shown} — ${fix}`;
          }
        }
      }
    }

    // 3. Album-position claims vs the shown track_number/total_tracks. Skips
    // entirely without album context (see albumPositionContext) or on rows
    // that predate the field expansion.
    const trackNo = item?.track_number;
    const totalTracks = item?.album?.total_tracks;
    if (
      Number.isInteger(trackNo) && trackNo > 0 &&
      Number.isInteger(totalTracks) && totalTracks > 0
    ) {
      for (const { re, wantTrack, what } of [
        { re: OPENER_RE, wantTrack: 1, what: "opens the album" },
        { re: CLOSER_RE, wantTrack: totalTracks, what: "closes the album" },
      ]) {
        const m = re.exec(note);
        if (!m || !albumPositionContext(note, item, m)) continue;
        if (trackNo !== wantTrack) {
          return `track ${i + 1}'s note says it ${what} ("${m[0]}"), but the search result you cited shows it as track ${trackNo} of ${totalTracks} — ${fix}`;
        }
      }
    }

    // 4. "Title track" vs the shown album. Normalized (suffixes stripped) so a
    // "(Remastered)" album name can't fake a mismatch; album_type catches the
    // single whose "album" IS the track.
    if (/title track/i.test(note)) {
      const albumName = String(item?.album?.name ?? "");
      const normAlbum = albumName ? normalize(stripSuffixes(albumName)) : "";
      const normTitle = normalize(stripSuffixes(item?.name ?? ""));
      if ((item?.album?.album_type ?? null) === "single") {
        return `track ${i + 1}'s note calls it a "title track", but the search result you cited shows its release is a single, not an album — ${fix}`;
      }
      if (normAlbum && normTitle && normAlbum !== normTitle) {
        return `track ${i + 1}'s note calls it a "title track", but the search result you cited shows the album as "${albumName}", not "${item?.name}" — ${fix}`;
      }
    }
  }
  return null;
}

// Compose the completeness gate with the grounding gate for one generate run.
// A factory so the bounce counter is per-run and the composition is testable
// without a live agent loop. Round one wires this into generateCard ONLY —
// adjustCard's replacement notes stay ungated until live FP telemetry is in.
function makeGroundingGate({
  hard,
  lookup,
}: {
  hard: (input: Record<string, unknown>) => string | null;
  lookup: (ref: string) => any | null;
}): (input: Record<string, unknown>, ctx?: { lastTurn?: boolean }) => string | null {
  let bounces = 0;
  return (input, ctx) => {
    // Hard incompleteness always wins and is never subject to the cap or the
    // last-turn leniency — a hollow card must not ship however late it is.
    const hardGap = hard(input);
    if (hardGap) return hardGap;
    const violation = noteGroundingReason(input, lookup);
    if (!violation) return null;
    // A false positive must degrade to a shipped card, never a dead run: stop
    // bouncing when the cap is spent OR when no retry turn remains — a
    // rejection on the forced last turn is a thrown run, not a retry.
    if (bounces >= 2 || ctx?.lastTurn) {
      console.warn(
        `[curator] grounding gate ${ctx?.lastTurn ? "out of turns" : "exhausted"} — accepting: ${violation}`
      );
      return null;
    }
    bounces++;
    // The "grounding: " prefix is load-bearing: onCommit telemetry records the
    // gap string, and evals split grounding bounces from hollow-commit retries
    // by exactly this prefix.
    return `grounding: ${violation}`;
  };
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
  onCommit,
  signal,
}: {
  system: string;
  userContent: string;
  finalTool: string;
  arrayKey: string;
  // Why this tool call can't be accepted, or null if it can — see
  // cardIncompleteReason. A strict schema validates types, not substance.
  // ctx.lastTurn: a rejection on the forced last turn cannot be retried — the
  // loop below throws instead — so gates with soft rules (grounding) must
  // accept there rather than kill a paid run over a note nit.
  incompleteReason: (
    input: Record<string, unknown>,
    ctx: { lastTurn: boolean }
  ) => string | null;
  onItem?: (index: number, item: any) => void;
  // Fires once per final-tool call, with the gap that rejected it (null =
  // accepted). The retry loop below repairs an incomplete commit, which is
  // right for users but hides how often the model gets it wrong first try —
  // the exact signal the eight-required-keys schema was meant to fix. Only
  // evals/reliability.ts passes this; the app leaves it undefined.
  onCommit?: (attempt: number, gap: string | null) => void;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Explicit rather than inherited. Each turn is ONE request, so 10 minutes
    // is already generous — the bound was never the problem. What killed the
    // 2026-08-17 baseline was streaming sockets dropping mid-turn: a stream
    // abort surfaces as undici's opaque "terminated", not as a clean timeout,
    // and the SDK retried twice in silence before throwing. Three retries buys
    // one more chance at a drop that costs a whole paid run; the timeout is
    // pinned so a future SDK default can't move it under us.
    timeout: 10 * 60 * 1000,
    maxRetries: 3,
  });
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent },
  ];
  let searchesSpent = 0; // quota-costing searches this run — cache hits are free
  let commits = 0; // final-tool calls seen, accepted or not

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
      ? incompleteReason(done.input as Record<string, unknown>, { lastTurn })
      : null;
    if (done) onCommit?.(++commits, gap);
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
    onCommit,
    signal,
  }: {
    seed?: { name: string; tracks: { artist: string; title: string }[]; total: number } | null;
    onTrack?: (index: number, t: { artist: string; title: string }) => void;
    onCommit?: (attempt: number, gap: string | null) => void;
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
    // fresh gate per call — the bounce counter is per-run state
    incompleteReason: makeGroundingGate({
      hard: cardIncompleteReason,
      lookup: recallByRef,
    }),
    onCommit,
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
      track: {
        // ref flows through to resolveTrack's exact-lookup path, same as a
        // created track's — dropping it here would silently demote every
        // replacement to fuzzy search.
        ...(typeof c.track.ref === "string" && c.track.ref
          ? { ref: c.track.ref }
          : {}),
        artist: c.track.artist,
        title: c.track.title,
        note: c.track.note,
      },
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
  // canonical shared logic — evals/grounding.ts imports extractYears from here
  extractYears,
  noteGroundingReason,
  makeGroundingGate,
  // exported for tests only
  SYSTEM,
  extractCompleteTracks,
  toTrackList,
  seedContext,
  cardIncompleteReason,
  diffIncompleteReason,
  TRACK_SCHEMA,
  ADJUST_TOOL,
  NO_REF,
  mapPool,
  SEARCH_BUDGET,
  SEARCH_CONCURRENCY,
};
