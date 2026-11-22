import { useState } from "react";
import { loadRecent, recordRecent, type RecentMixtape } from "../recent";

// "your mixtapes": this browser's presses and the "+ N more" toggle. The
// toggle lives here, not in RecentMixtapes, so it survives the home screen
// unmounting under a card. `record` writes against this render's list,
// which is also the fallback when storage can't be read (recent.ts).

// a getter, not a value: in some browsers reading `window.localStorage`
// itself throws (blocked storage); recent.ts catches that as well
const browserStorage = () => window.localStorage;

export default function useRecentMixtapes() {
  // "your mixtapes": this browser's presses, newest first (see recent.ts)
  const [recent, setRecent] = useState<RecentMixtape[]>(() => loadRecent(browserStorage));
  const [showAllRecent, setShowAllRecent] = useState(false);

  const record = (entry: RecentMixtape) =>
    setRecent(recordRecent(browserStorage, recent, entry));

  return {
    recent,
    record,
    showAll: showAllRecent,
    toggleShowAll: () => setShowAllRecent((v) => !v),
  };
}
