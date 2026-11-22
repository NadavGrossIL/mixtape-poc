import { useEffect } from "react";

// The page-view tick. App calls this after useSession and useLatestShelf so
// /api/view stays the third request on load.

// see the /api/view effect below — survives a hot-reload remount
let viewCounted = false;

export default function usePageView() {
  // One page-view tick per load, counted server-side (server/metrics.ts).
  // The module-level guard, not the empty dep array, is what makes it once:
  // a dev hot-reload remounts the app without reloading the page.
  useEffect(() => {
    if (viewCounted) return;
    viewCounted = true;
    fetch("/api/view", { method: "POST", keepalive: true }).catch(() => {});
  }, []);
}
