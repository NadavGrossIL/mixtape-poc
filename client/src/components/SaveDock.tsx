import SpotifyMark from "./SpotifyMark";

// The save button in its sticky dock, and the notes under it: not on
// Spotify yet, no login needed, and how many unverified songs stay off.
// Presentational: the save run lives in useSave.
export default function SaveDock({
  saving,
  stage,
  verified,
  total,
  disabled,
  loggedIn,
  onSave,
}: {
  saving: boolean;
  stage: string | null;
  verified: number;
  total: number;
  disabled: boolean;
  loggedIn: boolean | null;
  onSave: () => void;
}) {
  const unverified = total - verified;
  return (
    <>
      {/* the dock: a strip the button rides in, so rows scroll under
          a bar instead of a button floating over a song title */}
      <div className="save-dock">
        <button
          onClick={onSave}
          disabled={disabled}
          className="btn-press press-cta"
        >
          {/* says what the tap does in the visitor's words. It was
              "PRESS IT TO SPOTIFY": the brand verb, which a stranger
              has to decode at the one button that matters most */}
          {!saving && <SpotifyMark />}
          {saving
            ? stage || "SAVING…"
            : unverified === 0
              ? "SAVE AS A SPOTIFY PLAYLIST"
              : `SAVE ${verified} OF ${total} SONGS TO SPOTIFY`}
        </button>
      </div>
      {/* what a stranger wonders at this button: is it on Spotify
          already (no — a card looked like a finished playlist to
          the person who built the app), will it ask for my login.
          Answered here, with the honest number of taps left. */}
      <div className="save-note">
        <b>not on Spotify yet</b>
        {!loggedIn &&
          " — no login needed: we make the playlist, you tap + in Spotify to keep it"}
      </div>
      {unverified > 0 && (
        <div className="save-note">
          {unverified} unverified song
          {unverified === 1 ? "" : "s"} — Spotify couldn’t
          confirm {unverified === 1 ? "it exists" : "they exist"},
          so {unverified === 1 ? "it’ll" : "they’ll"} be left off
          the playlist
        </div>
      )}
    </>
  );
}
