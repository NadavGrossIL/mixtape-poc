import { useEffect, useRef, useState } from "react";
import SpotifyMark from "./SpotifyMark";
import { followSpotifyLink } from "../spotifyLink";
import { shareOrCopy } from "../share";
import { trackListText } from "../card";
import { bringIntoView } from "../bringIntoView";
import { type MixCard } from "../types";
import { track } from "../analytics";

// What replaces the save button once the playlist exists: OPEN IN SPOTIFY,
// the share button, and the editable-copy details with "copy song list".
// It owns the "copied ✓" label state and both clipboard handlers, and on
// mount brings itself into view with focus on OPEN IN SPOTIFY.
//
// `copied` is local because every reset it used to get in App ("make
// another one", a new run) also cleared the playlist URL, which unmounts
// this panel: unmounting is the reset.
export default function PressedPanel({
  playlistUrl,
  savedToLibrary,
  card,
  announce,
}: {
  playlistUrl: string;
  savedToLibrary: boolean;
  card: MixCard;
  announce: (line: string) => void;
}) {
  const [copied, setCopied] = useState<"tracks" | "share" | null>(null);
  const pressedRef = useRef<HTMLDivElement | null>(null);
  const pressedOpenRef = useRef<HTMLAnchorElement | null>(null);

  // A save that worked unmounts the sticky save button and mounts the
  // OPEN IN SPOTIFY block in the page's flow, under the card — on a phone,
  // below the fold, so the button just vanished and nothing said it worked.
  // Bring the block up and put focus on its one action.
  //
  // A mount effect, replacing App's effect on [playlistUrl]. Same trigger:
  // this panel renders exactly while a card is up and playlistUrl is set,
  // playlistUrl only ever turns non-null in useSave's save (from the save
  // button, which only exists while it is null, and with a card up that
  // can't be cleared mid-save), and it never changes from one URL to
  // another. So this mounts exactly when a save just landed, which is when
  // the old effect found its refs set. Mount-only is safe because there is
  // no StrictMode (main.tsx); under it this would run twice.
  useEffect(() => {
    if (pressedRef.current && pressedOpenRef.current) {
      bringIntoView(pressedRef.current, pressedOpenRef.current);
    }
  }, []);

  // Clipboard feedback is the button's own label for a beat, not a toast.
  const copyText = async (text: string, what: "tracks") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      announce("Song list copied.");
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
    } catch {
      announce("Couldn't copy — select it by hand.");
    }
  };

  // Native share sheet where there is one; otherwise the same clipboard path
  // "copy link" uses. The decision (and the "dismissed is not a copy" rule)
  // lives in share.ts so it is unit-tested; this is only the DOM edge.
  const shareMixtape = async () => {
    const outcome = await shareOrCopy(
      { title: card.title, url: playlistUrl },
      {
        share: navigator.share ? navigator.share.bind(navigator) : undefined,
        copy: (t) => navigator.clipboard.writeText(t),
      },
    );
    track("mixtape_shared", { outcome });
    if (outcome === "copied") {
      setCopied("share");
      announce("Link copied.");
      setTimeout(() => setCopied((c) => (c === "share" ? null : c)), 1800);
    } else if (outcome === "failed") {
      announce("Couldn't copy — select it by hand.");
    }
    // "shared" / "dismissed": the sheet was the feedback — nothing to report
  };

  return (
    <div className="pressed" ref={pressedRef}>
      {/* the one primary action after pressing: open it. The https
          href stays in the DOM (copy, middle-click, no-app fallback);
          a desktop click hands off to the installed app, a phone
          tap lets the anchor navigate (see spotifyLink.ts). */}
      <a
        ref={pressedOpenRef}
        href={playlistUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-press pressed-open"
        aria-label="Open this mixtape in Spotify"
        onClick={(e) => {
          track("playlist_opened");
          followSpotifyLink(e, playlistUrl);
        }}
      >
        <SpotifyMark />
        OPEN IN SPOTIFY
      </a>
      <div className="save-note pressed-note">
        {savedToLibrary
          ? "Saved — it’s in your Spotify library."
          : "Your playlist is ready. Open it and tap + to add it to your library."}
      </div>
      <div className="pressed-actions">
        {/* one button, not "copy link" + "share": with no share
            sheet (a desktop) share IS a copy, so the pair was the
            same action twice */}
        <button
          type="button"
          className="btn-ghost"
          aria-label="Share this mixtape"
          onClick={shareMixtape}
        >
          {copied === "share" ? "copied ✓" : "share"}
        </button>
      </div>
      {/* no embedded player here (removed 2026-09-08): it repeated
          the track list above, ran 352px tall on a phone, and its
          one unique control — the save heart — needs a Spotify
          cookie inside a cross-site iframe, which Safari and iOS
          block. OPEN IN SPOTIFY is the listen action. */}
      <details className="pressed-mine">
        <summary>want your own editable copy?</summary>
        <p>
          Tapping + follows Mixtape’s playlist. To make one you can edit:
          in Spotify, open it → ⋯ → <b>Add to other playlist</b> →{" "}
          <b>New playlist</b>. Or copy the tracks and build it anywhere.
        </p>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => copyText(trackListText(card.tracks), "tracks")}
        >
          {copied === "tracks" ? "copied ✓" : "copy song list"}
        </button>
      </details>
    </div>
  );
}
