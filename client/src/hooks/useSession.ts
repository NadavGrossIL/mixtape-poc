import { useEffect, useState } from "react";

// Who is looking: whether this browser has a connected Spotify (null while
// /auth/status answers), whether it is the owner's, and whether the server
// offers jam mode (JAM_MODE=1, server/jamMode.ts). App calls this first
// so /auth/status stays the first request on load (then latest, then view).
export default function useSession() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null); // null = checking
  const [isOwner, setIsOwner] = useState(false); // shows the shelf's "hide"; the server enforces it
  const [jamMode, setJamMode] = useState(false); // shows the Mixtape · Jam toggle

  useEffect(() => {
    fetch("/auth/status")
      .then((r) => r.json())
      .then((d: { loggedIn?: boolean; owner?: boolean; jamMode?: boolean }) => {
        setLoggedIn(Boolean(d.loggedIn));
        setIsOwner(Boolean(d.owner));
        setJamMode(d.jamMode === true);
      })
      .catch(() => setLoggedIn(false));
  }, []);

  return { loggedIn, isOwner, jamMode };
}
