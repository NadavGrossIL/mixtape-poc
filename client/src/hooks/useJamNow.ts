import { useState } from "react";
import { trackId } from "../card";
import { JAM_NOW_KEY, nextIndex, nowIndex, nowLine, parseJamNow, type JamNow } from "../jamNow";
import { type MixCard, type Track } from "../types";

// A jam card's now-playing mark (jamNow.ts says why it is keyed as it is).
// Written to sessionStorage inside the click that sets it, not in an effect:
// an in-app webview may unload this page as the link opens, before any
// effect would run. Storage can throw (blocked); then the mark just doesn't
// survive Back.
const store = () => window.sessionStorage;

function read(title: string): JamNow | null {
  try {
    return parseJamNow(store().getItem(JAM_NOW_KEY), title);
  } catch {
    return null;
  }
}

export default function useJamNow(card: MixCard, announce: (line: string) => void) {
  const jam = card.mode === "jam";
  // read once on mount: a restored card after Back finds its mark. A new
  // card remounts MixtapeCard (App renders nothing between two cards).
  const [now, setNow] = useState<JamNow | null>(() => (jam ? read(card.title) : null));
  // a refine that renames the card leaves the mark behind, as it would in
  // storage: a mark belongs to one card title
  const index = jam && now?.title === card.title ? nowIndex(card.tracks, now) : -1;

  const mark = (i: number, t: Track) => {
    const next = { title: card.title, trackId: trackId(t) };
    setNow(next);
    try {
      store().setItem(JAM_NOW_KEY, JSON.stringify(next));
    } catch {
      // blocked storage: the mark holds for this page view only
    }
    announce(nowLine(i, t));
  };

  const clear = () => {
    setNow(null);
    try {
      store().removeItem(JAM_NOW_KEY);
    } catch {
      // nothing stored to clear
    }
    announce("Now-playing mark cleared");
  };

  return { index, next: nextIndex(index, card.tracks.length), mark, clear };
}
