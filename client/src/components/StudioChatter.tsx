import { useEffect, useState } from "react";

// Studio chatter: the rotating flavour line ("thumbing the dividers…"), the
// product's version of an assistant's "thinking…". Cosmetic on purpose: the
// step line above it states the stage in plain words, and this is the part
// that keeps moving while no song has landed yet, keyed to the stage so it
// never claims a step that isn't happening. It was cut from the generate
// screen for a day as noise (2026-11-21) and put back the same day: the
// owner missed it, and it is the screen's charm. aria-hidden: the live
// region narrates the milestones.
const CHATTER = {
  reading: [
    "reading your liner notes…",
    "decoding the vibe…",
    "warming up the tubes…",
    "tuning the dial…",
    "checking the levels…",
    "sharpening the pencil…",
  ],
  seeding: [
    "dropping the needle on your playlist…",
    "reading the grooves…",
    "taking notes from your crate…",
    "rewinding to track one…",
    "listening for the through-line…",
  ],
  curating: [
    "thumbing the dividers…",
    "flipping past the B-sides…",
    "dusting off a deep cut…",
    "asking the record-store guy…",
    "arguing about the opener…",
    "sequencing side A…",
    "pulling a few sleeves…",
    "checking the bpm…",
    "holding out for the closer…",
    "cutting one that didn't earn it…",
  ],
  resolving: [
    "matching wax to Spotify…",
    "checking the barcodes…",
    "cueing up the tracks…",
    "aligning the tape heads…",
    "winding the cassette…",
    "labelling the spine…",
  ],
  // the refine flow: same card, one instruction, a few tracks swapped
  rewinding: [
    "rewinding the tape…",
    "reading your note…",
    "listening back to the sequence…",
    "finding the track that's off…",
    "splicing in a replacement…",
    "keeping what worked…",
    "checking the segue…",
    "re-dubbing side B…",
  ],
};
type ChatterPool = keyof typeof CHATTER;
const CHATTER_MS = 2600;

export default function StudioChatter({ pool: name, inline }: { pool: ChatterPool; inline?: boolean }) {
  const pool = CHATTER[name];
  const [line, setLine] = useState(pool[0]);
  useEffect(() => {
    // new stage → its first line immediately, then wander the pool without
    // repeating the line that's on screen
    let current = pool[0];
    setLine(current);
    const id = setInterval(() => {
      const rest = pool.filter((l) => l !== current);
      current = rest[Math.floor(Math.random() * rest.length)];
      setLine(current);
    }, CHATTER_MS);
    return () => clearInterval(id);
  }, [pool]);
  // key on the text so the fade-in re-runs on every change
  return (
    <div
      className={"studio-chatter" + (inline ? " inline" : "")}
      aria-hidden
      key={line}
    >
      {line}
    </div>
  );
}
