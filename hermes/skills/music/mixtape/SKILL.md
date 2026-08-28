---
name: mixtape
description: "Make a real Spotify mixtape from a mood or a sentence — 8 tracks with liner notes, then press it as a public playlist the person keeps with one tap."
version: 1.0.0
platforms: [macos, linux]
prerequisites:
  commands: [node]
metadata:
  hermes:
    tags: [music, spotify, playlist, mixtape]
    category: music
---

# Mixtape

Turns a sentence ("rainy drive through the Negev", "something for cooking
with friends, 90s but not obvious") into an 8-track mixtape curated by
Claude, resolved against Spotify, and pressed as a public playlist on the
Mixtape host account. The person opens the link in Spotify and taps **+** to
keep it. Live app: https://mixtape-poc-production.up.railway.app

## When to use

- Someone asks for a playlist, a mixtape, "songs for…", "music like…"
- Someone reacts to a mixtape you just made ("less synth", "swap track 3",
  "more Hebrew") — that is an **adjust**, not a new generate
- Someone says "press it", "make the playlist", "send me the link" — **press**

## Procedure

All three steps are one script. `$SKILL_DIR` is this skill's directory
(`~/Projects/mixtape-poc/hermes/skills/music/mixtape`).

1. **Generate** (30–120 s, sometimes longer — tell the person you're on it
   before running):
   `node $SKILL_DIR/scripts/mixtape.mjs generate "<their words, plus what
   you remember about their taste>"`
   Fold in taste from memory as plain English in the prompt, e.g.
   `"… — they usually prefer female vocals and dislike EDM"`. Do not invent
   taste you were not told.
2. **Adjust** a mixtape they reacted to:
   `node $SKILL_DIR/scripts/mixtape.mjs adjust "<their reaction>"`
   Only the changed tracks go through the model; the rest stay identical.
3. **Press** when they're happy (or straight away if they asked for a
   playlist, not a card): add `--press` to generate/adjust, or run
   `node $SKILL_DIR/scripts/mixtape.mjs press` for the last card.
   The script prints the Spotify link — send it verbatim.

## Replying

- Send the script's output as-is: title, one-line vibe, numbered tracks with
  their notes. It is already chat-shaped. Do not re-summarise it.
- Tracks marked *unverified* are ones the curator invented that don't exist
  on Spotify. Leave the mark in — it's honest, and it's the app's whole point.
  They are not pressed.
- After a press, the link is the answer. One line, no ceremony.

## Memory

After a press, if the person said anything about their taste (loved a
track, "never again with X"), save it with the `memory` tool as a short
fact about **them**, not about the mixtape. This is what makes the second
mixtape better than the first.

## Limits — say these plainly when they bite

- The app is capped for everyone: 5 mixtapes per guest per day, 12 for all
  guests together. When the script prints *"today's tapes are all pressed"*
  that is the whole answer — tomorrow.
- A playlist is public on the Mixtape account and can never be deleted or
  made private (that would revoke it from everyone who kept it). Don't offer
  to.
- The playlist carries only the title, never the prompt.
