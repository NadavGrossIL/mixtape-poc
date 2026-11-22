import { useEffect, useState } from "react";
import { parsePlaylistLink, seedPlaylistFor, visibleSeedPlaylists, type SeedPlaylists } from "../seed";
import { type Playlist } from "../types";

// The "in the spirit of" seed: the connected visitor's playlist list, the
// picked or pasted playlist that is armed (`armed`), and the picker panel's
// open/filter/paste state. The panel state lives here, not in SeedPanel:
// the panel unmounts while a run is loading and on toggle-close without
// clearing it, and today it survives both. SeedPanel and the composer's
// token and trigger are its UI; generate calls `nameFromServer` while
// seeding and `clearAfterRun` once a card lands.
export type SeedPicker = ReturnType<typeof useSeedPicker>;

export default function useSeedPicker({
  loggedIn,
  announce,
  setHint,
  focusPrompt,
}: {
  loggedIn: boolean | null;
  announce: (line: string) => void;
  setHint: (hint: string | null) => void;
  focusPrompt: () => void;
}) {
  // "in the spirit of" seed picker
  const [playlists, setPlaylists] = useState<SeedPlaylists>(null); // null=loading
  const [seedId, setSeedId] = useState("");
  const [seedOpen, setSeedOpen] = useState(false); // the inline picker panel
  const [seedFilter, setSeedFilter] = useState("");
  // a seed that arrived as a pasted link — visitors without a connected
  // Spotify have no shelf to pick from, so they paste a playlist link
  // instead; the server reads it with the host account and names it
  const [pastedSeed, setPastedSeed] = useState<Playlist | null>(null);
  const [seedPaste, setSeedPaste] = useState("");

  // the seed picker's playlist list. 403 = the stored token predates the
  // playlist-read scopes — surfaced as a "reconnect Spotify" link. A named
  // function (not just an effect) so the error state can offer a retry.
  const loadPlaylists = () => {
    setPlaylists(null);
    fetch("/api/playlists")
      .then(async (r) => {
        if (r.status === 403) return setPlaylists("unauthorized");
        if (!r.ok) throw new Error("playlists failed");
        const d: { playlists?: Playlist[] } = await r.json();
        setPlaylists(Array.isArray(d.playlists) ? d.playlists : []);
      })
      .catch(() => setPlaylists("error"));
  };
  useEffect(() => {
    if (loggedIn === true) loadPlaylists();
  }, [loggedIn]);

  const seedPlaylist = seedPlaylistFor(playlists, seedId, pastedSeed);

  // the picker's rows (seed.ts)
  const seedShown = visibleSeedPlaylists(playlists, seedFilter);

  // arm a pasted playlist link as the seed; the server names it while seeding
  const applyPastedSeed = () => {
    const id = parsePlaylistLink(seedPaste);
    if (!id) {
      setHint("That doesn't look like a Spotify playlist link — copy it from Share → Copy link in Spotify.");
      return;
    }
    setPastedSeed({ id, name: "", total: null, mine: false });
    setSeedPaste("");
    setSeedOpen(false);
    setHint(null);
    announce("Using your pasted playlist. The prompt is now optional.");
    focusPrompt();
  };

  const pick = (p: Playlist) => {
    setSeedId(p.id);
    setSeedOpen(false);
    setSeedFilter("");
    setHint(null);
    announce(`Using ${p.name}. The prompt is now optional.`);
    focusPrompt();
  };

  // the token's ✕
  const clear = () => {
    setSeedId("");
    setPastedSeed(null);
    focusPrompt();
  };

  // after a run that produced a card (generate explains why)
  const clearAfterRun = () => {
    setSeedId("");
    // a pasted seed too: seedPlaylist falls back to it once seedId is empty
    setPastedSeed(null);
    setSeedOpen(false);
  };

  // the name the `seeding` event carries; only a pasted seed lacks one
  const nameFromServer = (name: string) =>
    setPastedSeed((s) => (s ? { ...s, name } : s));

  return {
    playlists,
    reload: loadPlaylists,
    armed: seedPlaylist,
    shown: seedShown,
    open: seedOpen,
    toggle: () => setSeedOpen(!seedOpen),
    // the panel's ✕
    close: () => {
      setSeedOpen(false);
      setSeedFilter("");
    },
    filter: seedFilter,
    setFilter: setSeedFilter,
    paste: seedPaste,
    setPaste: setSeedPaste,
    pick,
    applyPaste: applyPastedSeed,
    clear,
    clearAfterRun,
    nameFromServer,
    // the composer's "+ start from a playlist": nothing armed yet, and not a
    // connected visitor whose list came back empty
    canOffer: !seedPlaylist && !(Array.isArray(playlists) && playlists.length === 0),
  };
}
