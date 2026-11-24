import { useRef, useState } from "react";
import { type MixCard } from "../types";

// Sharing a jam set without saving it to Spotify: POST /api/share makes its
// page (/m/<23-char id>, server/shares.ts) from the curator's own copy of the
// card, and answers with the link. The link is kept for the card it was made
// for, so a second tap shares at once — a phone can refuse the share sheet
// or the clipboard when a network wait sat between the tap and the share,
// and then the second tap is the one that works. A different card (a
// reorder, a swap, a refine) asks again. Errors are the server's own line
// (it never says more than "make it again"), shown with ErrorAlert by App.
export default function useShareSet({ card }: { card: MixCard | null }) {
  const made = useRef<{ card: MixCard; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  // the link, shown on screen when neither the sheet nor the clipboard took it
  const [shownUrl, setShownUrl] = useState<string | null>(null);

  const fail = (message: string) => {
    setError(message);
    setErrorTick((n) => n + 1);
  };

  const link = async (): Promise<string | null> => {
    if (!card) return null;
    if (made.current?.card === card) return made.current.url;
    setError(null);
    setShownUrl(null);
    const uris = card.tracks.filter((t) => t.resolved).map((t) => t.spotifyUri);
    if (!uris.length) {
      fail("No verified songs to share.");
      return null;
    }
    try {
      const response = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: card.title, vibe: card.vibe, uris }),
      });
      const data: { id?: string; error?: string } = await response.json().catch(() => ({}));
      if (!response.ok || !data.id) {
        fail(data.error || "Couldn't make the link. Try again.");
        return null;
      }
      // this page's own origin, not the server's idea of its host: in dev
      // the server sits behind Vite's proxy on another port
      const url = `${window.location.origin}/m/${data.id}`;
      made.current = { card, url };
      return url;
    } catch (e) {
      console.error(e);
      fail("Couldn't make the link. Try again.");
      return null;
    }
  };

  return {
    link,
    error,
    errorTick,
    shownUrl,
    showUrl: setShownUrl,
    reset: () => {
      made.current = null;
      setError(null);
      setShownUrl(null);
    },
  };
}
