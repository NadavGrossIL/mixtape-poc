import { useEffect, useState } from "react";

// Who is looking: whether this browser has a connected Spotify (null while
// /auth/status answers) and whether it is the owner's. App calls this first
// so /auth/status stays the first request on load (then latest, then view).
export default function useSession() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null); // null = checking
  const [isOwner, setIsOwner] = useState(false); // shows the shelf's "hide"; the server enforces it

  useEffect(() => {
    fetch("/auth/status")
      .then((r) => r.json())
      .then((d: { loggedIn?: boolean; owner?: boolean }) => {
        setLoggedIn(Boolean(d.loggedIn));
        setIsOwner(Boolean(d.owner));
      })
      .catch(() => setLoggedIn(false));
  }, []);

  return { loggedIn, isOwner };
}
