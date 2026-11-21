// Adjust, the LangChain way: the model writes the WHOLE new card, and code —
// not the model — works out what changed.
//
// The hand-written agent asks the model for a diff (adjust_mixtape). Here the
// model only knows one delivery tool, create_mixtape, so an adjust comes back
// as eight tracks again. The UI still expects the AdjustDiff shape (only the
// changed rows, each with its position), so the comparison happens here. A
// comparison has one right answer, which makes it a unit test, not an eval.

import { fence } from "../curator.ts";
import type { AdjustDiff } from "../curator.ts";

type TrackLike = { ref?: string; artist: string; title: string; note: string };
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
// index, and the hand-written agent drops out-of-range changes the same way.
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
    })),
  };
  return (
    `Original prompt:\n${fence("listener_prompt", card.prompt || "")}\n` +
    `The mixtape as the listener has it now (JSON):\n${fence("current_mixtape", JSON.stringify(current))}\n\n` +
    `The listener asks for this change:\n${fence("listener_adjustment", adjustment)}\n\n` +
    "Change only what the request touches. Every other track stays in its slot, " +
    "with its ref, artist, title and note copied exactly — do not search for those again. " +
    "New tracks must come from search results, as always. " +
    "Then call create_mixtape with the full card: all eight tracks."
  );
}

export type { CardLike, TrackLike };
export { sameTrack, diffCards, isEmptyDiff, adjustMessage };
