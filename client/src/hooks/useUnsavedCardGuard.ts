import { useEffect } from "react";
import { isHandingOff } from "../spotifyLink";

// The browser's "Leave site?" prompt while `unsaved` is true. App computes
// `unsaved` (a card on screen, no playlist pressed from it) and also uses it
// for the start-over confirm.
//
// A card is a draft until it's saved: it lives only in this tab. On
// 2026-11-22 a refined card was lost to a reload 20 minutes later, its
// maker sure they'd "created a playlist" — prod's request log had no save
// at all. So leaving with an unsaved card asks first (the browser's own
// "Leave site?" prompt; its wording can't be set).
export default function useUnsavedCardGuard(unsavedCard: boolean) {
  useEffect(() => {
    if (!unsavedCard) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (isHandingOff()) return; // a song opening in the Spotify app, not leaving
      e.preventDefault();
      e.returnValue = ""; // older Chrome/Safari need it set to show the prompt
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsavedCard]);
}
