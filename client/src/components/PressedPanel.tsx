import { type RefObject } from "react";
import SpotifyMark from "./SpotifyMark";
import { followSpotifyLink } from "../spotifyLink";

// What replaces the save button once the playlist exists: OPEN IN SPOTIFY,
// the share button, and the editable-copy details with "copy song list".
// The copy state and both handlers live in App for now; `panelRef` and
// `openRef` are how App's save-landed effect scrolls and focuses it.
export default function PressedPanel({
  playlistUrl,
  savedToLibrary,
  copied,
  onShare,
  onCopyTracks,
  panelRef,
  openRef,
}: {
  playlistUrl: string;
  savedToLibrary: boolean;
  copied: "tracks" | "share" | null;
  onShare: () => void;
  onCopyTracks: () => void;
  panelRef: RefObject<HTMLDivElement>;
  openRef: RefObject<HTMLAnchorElement>;
}) {
  return (
    <div className="pressed" ref={panelRef}>
      {/* the one primary action after pressing: open it. The https
          href stays in the DOM (copy, middle-click, no-app fallback);
          a desktop click hands off to the installed app, a phone
          tap lets the anchor navigate (see spotifyLink.ts). */}
      <a
        ref={openRef}
        href={playlistUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-press pressed-open"
        aria-label="Open this mixtape in Spotify"
        onClick={(e) => followSpotifyLink(e, playlistUrl)}
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
          onClick={onShare}
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
          onClick={onCopyTracks}
        >
          {copied === "tracks" ? "copied ✓" : "copy song list"}
        </button>
      </details>
    </div>
  );
}
