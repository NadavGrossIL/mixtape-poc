import { useEffect, useState } from "react";
import { parseLatestResponse, type LatestMixtape } from "../latest";

// "fresh off the press": everyone's newest presses (server/latest.ts), read
// on mount and again by `reload` after a save, plus the owner's `hide`.
// Which rows show is LatestShelf's job (shelfFor in latest.ts).
export default function useLatestShelf() {
  const [latest, setLatest] = useState<LatestMixtape[]>([]);

  // The shelf is a nice-to-have: any failure just leaves it off the page.
  // Re-read after this visitor's own press, so the list is current when
  // they come back to the composer.
  const loadLatest = () => {
    fetch("/api/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLatest(parseLatestResponse(d)))
      .catch(() => {});
  };
  useEffect(loadLatest, []);

  // owner only, and not undoable from here — so it asks first
  const hideLatest = (id: string, title: string) => {
    if (!window.confirm(`Hide “${title}” from the home page? The playlist itself stays.`)) return;
    fetch("/api/latest/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`hide failed: ${r.status}`);
        return r.json();
      })
      .then((d) => setLatest(parseLatestResponse(d)))
      .catch((e) => window.alert(`Couldn't hide it (${e.message}).`));
  };

  return { latest, reload: loadLatest, hide: hideLatest };
}
