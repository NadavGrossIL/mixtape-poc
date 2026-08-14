# Second-chance / readjustment flow — research

**Question:** After a mixtape card is generated, the user wants to refine it — "less 80s, more instrumental", "swap track 3". What is the best UX, API pattern, and track-preservation mechanism, backed by primary sources?

> Repo has no docs/notes convention (only `README.md`), so this file establishes `docs/research/` — first file of its kind here.
>
> Researched 2026-08-14 against the code at that date (`server/curator.js`, `server/index.js`, `server/spotify.js`). Anthropic docs now live at `platform.claude.com/docs` (formerly docs.anthropic.com / docs.claude.com); all doc citations below use that host.

---

## Recommendation (up front)

1. **UX — single "Refine" prompt box on the card + a per-track swap action. No chat thread.**
   This is exactly what Spotify shipped twice (AI Playlist's *Refine playlist* button, Prompted Playlist's *Edit prompt*), and per-item regeneration is what Suno converged on (*Replace Section* — everything outside the selection stays untouched). A per-track "swap" button just submits a canned instruction ("replace track N, keep everything else") through the same refine pipeline — one backend path serves both.

2. **API — stateless single-turn regeneration, not replayed multi-turn history.**
   Send a fresh request: system prompt + current card serialized as JSON in the user message + the adjustment instruction, with a **second strict tool `adjust_mixtape` forced via `tool_choice`**. Both patterns are legal per the docs (details below), but multi-turn buys nothing here — the prefix is too small for prompt caching to engage on Sonnet 5 (1,024-token minimum), it forces `tool_result` bookkeeping, and its cost grows with every refinement round while the stateless request stays constant-size. The client already holds the card; the server stays stateless as it is today.

3. **Preservation — diff-style strict output: `{changes: [{index, track}], title?, vibe?}`, merged server-side.**
   A diff schema is fully compatible with `strict: true` (`index` as an integer `enum: [0..7]` — integer enums are explicitly supported; `minItems`/`maxItems` beyond 0/1 are not, so array lengths are clamped in code exactly like today's 8-track clamp). Untouched tracks are never re-emitted, so they are **byte-identical by construction** — order, identity, liner note, and `spotifyUri` all survive because the server owns them. Only changed indices go back through Spotify resolution (`resolveTracks` on the subset); unchanged tracks keep their `spotifyUri`/`resolved`/`albumArt` fields untouched — confirmed trivial from `server/spotify.js`.

---

## 1. Precedents — how shipped products handle playlist refinement

### Spotify AI Playlist (2024 feature) — refine prompt + per-track remove

First-party support doc ([support.spotify.com — AI Playlist](https://support.spotify.com/ug-en/article/ai-playlist/)):

- Refinement is a **prompt edit, not a chat**: "Tap **Refine playlist** next to your profile, then edit your prompt to enhance your playlist."
- **Per-item action during preview**: use the add/save icon to include tracks or "tap [the remove icon] to remove tracks from being recommended" before tapping Create.
- Prompt guidance: "Some of the most successful playlists are generated with prompts that contain a combination of genres, moods, artists, or decades."

*(Verified from the live support article. The original April 2024 newsroom post now 404s; early press coverage described typed follow-up refinements like "more pop" / "less upbeat" — that specific wording could not be re-verified against a first-party page and is listed under Unverified below.)*

### Spotify Prompted Playlists (2025–2026 successor) — edit prompt + per-song notes

- Support doc ([support.spotify.com — Prompted Playlists](https://support.spotify.com/us/article/prompted-playlists/)): "you can edit your prompt anytime by selecting **Edit prompt** and choose how broad or specific you want to go." Also: "Each playlist includes simple notes explaining why certain songs or episodes fit" (same idea as our liner notes).
- Newsroom, Dec 2025 ([You're in Control: Spotify Lets You Steer the Algorithm](https://newsroom.spotify.com/2025-12-10/spotify-prompted-playlists-algorithm-gustav-soderstrom/)): users can "fine-tune the results by editing the prompt, or start fresh whenever you want" — plus optional daily/weekly refresh.
- Newsroom, Jan 2026 ([Prompted Playlist expansion](https://newsroom.spotify.com/2026-01-22/prompted-playlists-expansion/)): "You can edit your prompt anytime, or start fresh whenever inspiration hits."

Notably, **neither generation of the feature is a chat thread**. Both are: one prompt, one playlist, one edit affordance.

### Amazon Music Maestro — one-shot, no refinement loop

First-party announcement ([aboutamazon.com — Maestro](https://www.aboutamazon.com/news/entertainment/amazon-music-maestro-ai-playlist-generator)): prompt (text/voice/emoji) → "Tap 'Let's go!' to stream your playlist" → listen / save / share. The page describes **no refinement or iteration mechanism at all** — one result per prompt. Useful as the floor: shipping without a second-chance flow is the weakest version of this product category.

### Suno — scoped regeneration, keep the rest

First-party help center ([Song Editor](https://help.suno.com/en/articles/6141505)): highlight a region → "Choose 'Replace' from the left panel or click the Quick Replace button" → "Click Generate More to explore additional options." The editor's contract is the key design idea: **only the targeted section is regenerated; everything outside the selection stays exactly as it was.** That is the audio-domain equivalent of "swap track 3, keep the other 7" — and the strongest precedent for a diff/patch regeneration model rather than full re-roll. Suno also separates *Remix* (keep a recognizable part) from full *regenerate* (concept was wrong) — mirroring our refine-vs-new-prompt split.

### ChatGPT / Claude pattern (labeled inference)

General-purpose assistants use a full chat thread for refinement — but for *artifact-shaped* outputs both products converged on an artifact/canvas panel with targeted edits, not just re-prompting the transcript. This is product observation, not a doc citation (see Unverified). For a single-purpose card generator, the domain products above are the better model: chat threads invite open-ended conversation the tool can't honor (questions, multi-topic asks), while a refine box scopes expectations to "adjust this card."

### Convergence

| Product | Refinement UX | Per-item action |
|---|---|---|
| Spotify AI Playlist | Edit/extend the prompt ("Refine playlist") | Remove track in preview |
| Spotify Prompted Playlist | "Edit prompt" | Notes per song; no documented per-song swap |
| Amazon Maestro | None documented | None documented |
| Suno | Regenerate = new prompt; Remix/Replace = keep the rest | Replace a selected section, rest untouched |

**Pattern: single refinement input + per-item surgical action.** No shipped playlist product uses a chat thread.

---

## 2. API pattern — multi-turn replay vs stateless single-turn

Current code (`server/curator.js`): single-turn `messages.stream` on `claude-sonnet-5`, one strict tool `create_mixtape` with `eager_input_streaming: true`, forced via `tool_choice: {type: "tool", name: "create_mixtape"}`, no `thinking` param.

### What the docs require for option (a) — real multi-turn

- **A `tool_use` turn must be answered by `tool_result`, immediately.** [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls): "Tool result blocks must immediately follow their corresponding tool use blocks in the message history. You cannot include any messages between the assistant's tool use message and the user's tool result message." Violation → 400: "tool_use ids were found without tool_result blocks immediately after."
- **Adjustment text can ride the same user turn**, but ordering is fixed: "In the user message containing tool results, the tool_result blocks must come FIRST in the content array. Any text must come AFTER all tool results." So the shape would be:
  ```
  user:      "Build a playlist for: <prompt>"
  assistant: [tool_use create_mixtape {card}]          ← replay verbatim
  user:      [tool_result "Card rendered. 6/8 resolved on Spotify.",
              text "Adjustment: less 80s, more instrumental"]
  → request with tool_choice forced again
  ```
- **Forced `tool_choice` on later turns is fine.** [Define tools — Forcing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) documents no turn-position restriction; the only compatibility caveat is thinking mode: "When using manual extended thinking (`thinking: {type: "enabled"}`) … `tool_choice: {"type": "tool", …}` [is] not supported … Adaptive thinking, including on models where thinking is on by default …, supports forced tool use." We pass no `thinking` param (Sonnet 5 runs adaptive by default), so forced tool use is supported — as the current working code already demonstrates.
- Forced tool choice also means "the models will not emit a natural language response or explanation before `tool_use` content blocks" — no chat filler to strip, in either pattern.

### What the docs say about caching (the usual argument for multi-turn)

[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):

- Minimum cacheable prompt on **Claude Sonnet 5: 1,024 tokens** — "Shorter prompts cannot be cached … no error is returned."
- Our stable prefix is roughly: tool-use system prompt (474 tokens on Sonnet 5 for `tool_choice: tool`, per the [tool use overview pricing table](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)) + `create_mixtape`/`adjust_mixtape` schemas (~400–600) + `SYSTEM` (~130). Borderline ~1,000–1,200 tokens — caching may not engage at all, and at 0.1× read pricing on a ~$0.002 prefix it is economically irrelevant either way. **Caching is not a deciding factor here.**
- If it ever matters: "Changes to `tool_choice` parameter only affect message blocks. Tool definitions and system prompts remain cached" — and changing tool definitions invalidates everything, so define both tools in one static `tools` array from day one.

### Cost and complexity comparison

Per refinement round (rough estimates; card ≈ 600–900 tokens as JSON):

| | (a) multi-turn replay | (b) stateless single-turn |
|---|---|---|
| Input per round | prior prompt + full `tool_use` card + `tool_result` + instruction; **grows every round** (round N carries N cards) | system + current card + instruction; **constant** |
| Server/client state | must persist and re-ship the full transcript | card JSON only (client already holds it — `done` event) |
| Doc constraints | `tool_result` bookkeeping, block ordering | none beyond what exists today |
| Idempotency / retry | replay must be byte-exact | trivially retryable |
| Documented "editing workflow" guidance | none found | none found |

The docs contain **no recommendation specific to editing/regeneration workflows** — multi-turn history is documented as the mechanism for *the model to consume tool results it asked for*, which is not our situation: `create_mixtape` is a recording tool, not an information tool; the model gains nothing from the transcript that a serialized card doesn't carry. Where the docs don't settle it, the constant-size, zero-state, zero-bookkeeping option wins for a POC. **Choose (b).**

One real trade-off conceded: multi-turn would preserve nuance from the *original* prompt conversation across many refinement rounds. Mitigation in (b): always include `card.prompt` (already stored on the card by `server/index.js`) in the adjustment request, so the original intent travels with every round.

---

## 3. Preservation — making the model keep what the user didn't touch

### What strict schemas can and cannot express

[Structured outputs — JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) (applies to `strict: true` tools per [Strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)):

- **Supported:** all basic types; `enum` ("strings, numbers, bools, or nulls only"); `const`; `anyOf`/`allOf` (limits); `required` + `additionalProperties: false` (mandatory for objects); array `minItems` only 0 or 1.
- **Not supported:** numerical constraints (`minimum`/`maximum`), string length constraints, "array constraints beyond `minItems` of 0 or 1", recursive schemas.

Consequences:
- `index` **can** be schema-locked to the card with `{"type": "integer", "enum": [0,1,2,3,4,5,6,7]}` — the strict-tool doc itself uses integer enums (`passengers`).
- Array length ("at most 8 changes", "exactly 8 tracks") **cannot** be schema-enforced — clamp in code, as `generateCard` already does for the 8-track rule.
- Duplicate indices in `changes` cannot be schema-prevented — last-write-wins in the merge, or dedupe in code.
- Schema note: changing the tool set invalidates the compiled-grammar cache ("The set of tools in your request"), another reason to declare both tools statically.

### Candidate mechanisms

| Mechanism | Strict-compatible? | Preservation guarantee | Verdict |
|---|---|---|---|
| **Prompt rule only** ("re-emit unchanged tracks verbatim") + full re-emit of all 8 | yes (today's schema) | none — model may paraphrase notes, drift artist spelling, reorder; every "unchanged" track must be string-matched against the old card to decide whether to re-resolve, and near-misses re-trigger Spotify search or, worse, silently alter the card | fallback only |
| **Per-track `keep` flag** in a full re-emit | yes (`boolean` or `const`) | weak — the model still re-emits every track, so a `keep: true` track can still arrive subtly altered; the flag documents intent without enforcing it | rejected |
| **Locked tracks in input + diff output** `{changes: [{index, track}], title?, vibe?}` | **yes** — integer-enum index, nested track object, optional top-level fields via `required` omission | **structural** — unchanged tracks are never in the model's output, so identity, order, note text, and `spotifyUri` survive bit-for-bit; the model's only degrees of freedom are the replacements themselves | **recommended** |

Where the docs don't settle it (they say nothing about *behavioral* faithfulness of re-emitted content), the reasoning is: every field the model re-emits is a field the model can change; the only way to guarantee preservation is to not let unchanged content pass through the model at all. That is Suno's Replace-Section contract applied to JSON.

Known limitations of the diff shape (accepted for this POC):
- **No reordering** — an index-diff can't express "move the peak earlier." Neither can Spotify's shipped refinement. If ever needed, add an optional `order: [ints]` field later.
- A sweeping adjustment ("completely different vibe") arrives as 8 changes — the diff degrades gracefully into a full regeneration.
- The model must *see* the current card to diff against it: serialize the full card (index, artist, title, note, resolved flag) into the user message, and tell it in the tool description that untouched indices must be omitted, and that `resolved: false` tracks are good swap candidates when the user complains about a track "not being real."

### Proposed `adjust_mixtape` tool (implementation-ready)

```js
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
            index: { type: "integer", enum: [0, 1, 2, 3, 4, 5, 6, 7] },
            track: {
              type: "object",
              additionalProperties: false,
              required: ["artist", "title", "note"],
              properties: {
                artist: { type: "string" },
                title: { type: "string" },
                note: { type: "string", description: "Same rules as create_mixtape notes." },
              },
            },
          },
        },
      },
      // optional — omitted from `required`, so the model may skip them
      title: { type: "string" },
      vibe: { type: "string" },
      accent: { type: "string", enum: ["crimson", "cobalt", "forest", "tangerine", "violet", "gold"] },
    },
  },
};
```

Request shape (stateless, forced):

```js
client.messages.stream({
  model: MODEL,
  max_tokens: 2000,
  system: SYSTEM,                       // same curator persona
  tools: [CURATOR_TOOL, ADJUST_TOOL],   // static tool list — never varies per request
  tool_choice: { type: "tool", name: "adjust_mixtape" },
  messages: [{
    role: "user",
    content:
      `Original prompt: "${card.prompt}"\n` +
      `Current mixtape (JSON):\n${JSON.stringify(minimalCard)}\n\n` +
      `User adjustment: "${instruction}"`,
  }],
});
```

`minimalCard` = `{title, vibe, accent, tracks: [{index, artist, title, note, resolved}]}` — strip `spotifyUri`/`albumArt`/`matchedName` to save tokens; the model doesn't need them. Track streaming works unchanged: scan the accumulated partial JSON for complete objects inside `"changes"` (same brace-matcher as `extractCompleteTracks`, keyed on `"changes"` instead of `"tracks"`), emitting `track-changed {index, artist, title}` SSE events so only the affected rows animate on the card.

### Spotify side — re-resolve only what changed (confirmed trivial)

`server/spotify.js` already makes this free:
- `resolveTrack` returns `{...track, resolved: true, spotifyUri, spotifyUrl, albumArt, matchedName}` on success (lines ~288–298) — resolution state lives **on each track object**, not in any shared structure.
- `resolveTracks(tracks, concurrency, onProgress)` is a pure function over whatever array it's given (lines ~302–331) — pass it just the replacement tracks.

Merge is therefore:

```js
const replacements = changes.map((c) => c.track);
const resolved = await spotify.resolveTracks(replacements, 3, sse);
changes.forEach((c, i) => { card.tracks[c.index] = resolved[i]; });
// untouched entries still carry their original spotifyUri / resolved / albumArt
```

The `/api/playlist` save path reads `uris` from the client-held card, so it needs no changes.

### Endpoint sketch

`POST /api/adjust/stream` `{card, instruction}` → SSE: `adjusting` → `track-changed` (per streamed change) → `adjusted {changeCount}` → `resolving`/`resolved` (changed indices only, reusing existing events with original indices) → `done {card, verified}` | `error`. The client swaps in the new card and keeps a one-level "undo" by retaining the previous card object — cheap insurance the precedents don't offer but users expect.

### UI notes (from the precedents)

- One inline input under the card: placeholder "Refine it — 'less 80s, more instrumental'" (Spotify's *Refine playlist* / *Edit prompt* affordance).
- Per-track ↻ button → sends `Replace track ${i+1} ("${artist} — ${title}") with a different track that fits the mixtape; keep all other tracks.` through the same endpoint (Suno's Replace-Section contract; Spotify's per-track remove).
- Unresolved (`unverified`) tracks are the natural first target for the swap button — surfaces the hallucination gate as a feature.
- Keep "start fresh" (existing prompt box) visually distinct from "refine" — both Spotify newsroom posts frame these as separate actions ("edit your prompt, or start fresh").

---

## Unverified / inferred — flagged explicitly

1. **Spotify's 2024 typed follow-up refinements ("more pop", "less upbeat") and swipe-to-delete.** Reported in 2024 press coverage; the original newsroom post (April 2024) now returns 404 and the current support article documents only the *Refine playlist* → edit-prompt flow plus tap-to-remove icons. Treat the "typed follow-up chips" detail as unverified.
2. **Amazon Maestro having *no* refinement loop** is inferred from absence: the first-party page describes none, but a help-center page behind sign-in could document one.
3. **ChatGPT/Claude "artifact + targeted edit" convergence** is product observation from general knowledge, not tied to a citable first-party doc. It is supporting color only; the recommendation stands on the Spotify/Suno sources.
4. **"Full re-emit lets the model silently alter kept tracks"** is reasoned from the strict-schema constraint set (schemas validate shape, not faithfulness to prior output) and general model behavior — no doc states it. It is the design assumption behind choosing the diff; if implementation testing shows Sonnet 5 re-emits verbatim reliably, full re-emit remains a viable simpler fallback.
5. **Token estimates** (card ≈ 600–900 tokens; prefix ≈ 1,000–1,200) are back-of-envelope, not measured with `count_tokens`. The caching conclusion (below the 1,024 minimum / economically irrelevant) is robust to the estimate being off by 2×, but measure before relying on it.
6. **Prompt-caching invalidation detail** ("tool_choice changes affect message blocks only") is quoted from the docs but untested against this exact request shape.

## Source index

**Product (first-party):**
- Spotify support — AI Playlist: https://support.spotify.com/ug-en/article/ai-playlist/
- Spotify support — Prompted Playlists: https://support.spotify.com/us/article/prompted-playlists/
- Spotify newsroom (2025-12-10): https://newsroom.spotify.com/2025-12-10/spotify-prompted-playlists-algorithm-gustav-soderstrom/
- Spotify newsroom (2026-01-22): https://newsroom.spotify.com/2026-01-22/prompted-playlists-expansion/
- Amazon (Maestro launch): https://www.aboutamazon.com/news/entertainment/amazon-music-maestro-ai-playlist-generator
- Suno help — Song Editor: https://help.suno.com/en/articles/6141505

**Anthropic docs:**
- Tool use overview (incl. tool_choice system-prompt token table): https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Handle tool calls (tool_result rules, 400 errors): https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
- Define tools (forcing tool use, thinking compatibility, tool_choice caching note): https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Strict tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
- Structured outputs (JSON Schema limitations, grammar cache): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Prompt caching (1,024-token Sonnet 5 minimum, invalidation hierarchy): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
