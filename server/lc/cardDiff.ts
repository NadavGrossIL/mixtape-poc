// Adjust, the LangChain way: the model writes the WHOLE new card, and code —
// not the model — works out what changed.
//
// The hand-written loop this replaced asked the model for a diff. Here the
// model only knows one delivery tool, create_mixtape, so an adjust comes back
// as eight tracks again. The UI still expects the AdjustDiff shape (only the
// changed rows, each with its position), so the comparison happens here. A
// comparison has one right answer, which makes it a unit test, not an eval.

import { fence } from "../curator.ts";
import type { AdjustDiff } from "../curator.ts";

type TrackLike = {
  ref?: string;
  artist: string;
  title: string;
  note: string;
  // Set by track resolution: false means Spotify could not confirm the record.
  resolved?: boolean | null;
};
type CardLike = { title: string; vibe: string; accent: string; tracks: TrackLike[]; prompt?: string };

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

// Same row? Artist and title ignore case and outer spaces (the model may
// re-capitalise); the note is compared as written, so "rewrite the notes" is
// a real change.
function sameTrack(a: Partial<TrackLike> | undefined, b: Partial<TrackLike> | undefined): boolean {
  if (!a || !b) return false;
  return (
    norm(a.artist) === norm(b.artist) &&
    norm(a.title) === norm(b.title) &&
    String(a.note ?? "").trim() === String(b.note ?? "").trim()
  );
}

// Old card vs new card → only what changed. Positions past the end of the old
// card are ignored: index.ts writes each change into the listener's card by
// index, so a change it has no row for must not reach it.
function diffCards(before: CardLike, after: CardLike): AdjustDiff {
  const changes: AdjustDiff["changes"] = [];
  const count = Math.min(before.tracks.length, after.tracks.length);
  for (let index = 0; index < count; index++) {
    const t = after.tracks[index]!;
    if (sameTrack(before.tracks[index], t)) continue;
    changes.push({
      index,
      track: {
        // the ref lets track resolution look the record up directly
        ...(typeof t.ref === "string" && t.ref ? { ref: t.ref } : {}),
        artist: t.artist,
        title: t.title,
        note: t.note,
      },
    });
  }
  const diff: AdjustDiff = { changes };
  if (after.title && after.title !== before.title) diff.title = after.title;
  if (after.vibe && after.vibe !== before.vibe) diff.vibe = after.vibe;
  if (after.accent && after.accent !== before.accent) diff.accent = after.accent;
  return diff;
}

function isEmptyDiff(diff: AdjustDiff): boolean {
  return diff.changes.length === 0 && !diff.title && !diff.vibe && !diff.accent;
}

// The message for an adjust run. The listener's card is sent every time, even
// when the thread remembers it: the card on their screen is the truth (they
// may have dragged rows into a new order), and after a server restart the
// thread is gone and this message is all the model has.
//
// Everything in the card came back from the browser, so every string in it is
// text a caller chose — it goes inside fences, as in curator.ts.
//
// Carried over from the hand-written adjust this replaced (its
// adjustUserContent and ADJUST_SYSTEM). That one told the model which rows Spotify could not verify
// and to swap those first; without the flag "replace the ones that aren't
// real" is a guess, because every row looks the same. `resolved` is forced to
// a boolean here, so it is the one field in the card that is not caller text.
//
// The rules below are ADJUST_SYSTEM's, reworded for a model that hands back
// the whole card instead of a list of changes. Two of them have no meaning
// here and are left out: "never re-emit an unchanged track" and "omit its
// index" — this model MUST re-emit them, and diffCards drops the unchanged
// ones. Their purpose survives as "copy exactly": a kept row that comes back
// reworded is reported as a change and loses its Spotify match.
function adjustMessage(card: CardLike, adjustment: string): string {
  const current = {
    title: card.title,
    vibe: card.vibe,
    accent: card.accent,
    tracks: card.tracks.map((t, i) => ({
      slot: `track${i + 1}`,
      ref: t.ref || "none",
      artist: t.artist,
      title: t.title,
      note: t.note,
      resolved: Boolean(t.resolved),
    })),
  };
  return (
    `Original prompt:\n${fence("listener_prompt", card.prompt || "")}\n` +
    `The mixtape as the listener has it now (JSON):\n${fence("current_mixtape", JSON.stringify(current))}\n\n` +
    `The listener asks for this change:\n${fence("listener_adjustment", adjustment)}\n\n` +
    "You are adjusting an existing mixtape, not building a new one:\n" +
    "- Change only what the request touches. Every other track stays in its slot, " +
    "with its ref, artist, title and note copied exactly — do not search for those again.\n" +
    '- Tracks marked "resolved": false could not be verified on Spotify — prefer them ' +
    "as the ones to swap out when the listener says a track isn't real.\n" +
    "- Every replacement must come from a search result, as always, with that row's ref " +
    "copied into its ref field.\n" +
    "- Replacement notes follow the same rules as any note: shown facts, staked lore, or " +
    "a vivid image of the sound — no guessed specifics. Max 18 words.\n" +
    "- Keep the DJ-set arc sensible: each replacement must sit right between its neighbors.\n" +
    "- Copy the title, vibe and accent exactly unless the request changes the mixtape's identity.\n" +
    "Then call create_mixtape with the full card: all eight tracks."
  );
}

export type { CardLike, TrackLike };
export { sameTrack, diffCards, isEmptyDiff, adjustMessage };
