import { useEffect, useState } from "react";

// "keep screen on" for a jam card: a phone propped on a knee mid-song must
// not lock. Opt-in only, and offered only where the Screen Wake Lock API
// exists (`supported`). The browser drops the lock whenever the tab is
// hidden, so it is taken again on every return while the toggle is on, and
// released when the toggle goes off or the card goes away.
export default function useWakeLock() {
  const supported = typeof navigator !== "undefined" && "wakeLock" in navigator;
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on || !supported) return;
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (live) lock = l;
          else void l.release();
        })
        // refused (battery saver, no user gesture, an iframe's policy): the
        // screen just sleeps as it would have; the toggle says it's off
        .catch(() => live && setOn(false));
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => {});
    };
  }, [on, supported]);

  return { supported, on, toggle: () => setOn((v) => !v) };
}
