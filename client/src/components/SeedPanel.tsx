import { type SeedPicker } from "../hooks/useSeedPicker";

// The seed picker panel, opened from the composer-bar trigger: the paste
// form for a visitor without a connected Spotify, otherwise their playlist
// list (with a filter past six), the reconnect link, the retry row, or the
// loading line. It is the only UI for useSeedPicker's panel state, so it
// takes the whole picker as one prop rather than a dozen.
export default function SeedPanel({
  picker,
  loggedIn,
}: {
  picker: SeedPicker;
  loggedIn: boolean | null;
}) {
  const { playlists } = picker;
  return (
    <div className="seed-panel">
      <div className="seed-panel-head">
        <span>{loggedIn ? "pick a playlist to base it on" : "paste a playlist to base it on"}</span>
        <button
          type="button"
          className="seed-panel-close"
          aria-label="Close the playlist picker"
          onClick={picker.close}
        >
          ✕
        </button>
      </div>
      {!loggedIn ? (
        <>
          <form
            className="seed-paste"
            onSubmit={(e) => {
              e.preventDefault();
              picker.applyPaste();
            }}
          >
            <input
              className="seed-filter"
              value={picker.paste}
              onChange={(e) => picker.setPaste(e.target.value)}
              placeholder="https://open.spotify.com/playlist/…"
              aria-label="Spotify playlist link"
              inputMode="url"
              autoFocus
            />
            <button type="submit" className="seed-retry">
              use it
            </button>
          </form>
          <div className="seed-explainer">
            in Spotify: the playlist’s ⋯ menu → Share → Copy link. Public
            playlists only — we read its tracks, then make a new
            mixtape in the same spirit
          </div>
        </>
      ) : Array.isArray(playlists) ? (
        <>
          {playlists.length > 6 && (
            <input
              className="seed-filter"
              value={picker.filter}
              onChange={(e) => picker.setFilter(e.target.value)}
              placeholder="find a playlist…"
              aria-label="Filter your playlists"
            />
          )}
          <div className="seed-list">
            {picker.shown.map((p) => (
              <button
                key={p.id}
                type="button"
                className="seed-item"
                onClick={() => picker.pick(p)}
              >
                <span className="seed-item-name">{p.name}</span>
                <span className="seed-item-meta">
                  {p.total != null
                    ? `${p.total} track${p.total === 1 ? "" : "s"}`
                    : ""}
                  {p.mine === false && p.owner
                    ? `${p.total != null ? " · " : ""}by ${p.owner}`
                    : ""}
                </span>
              </button>
            ))}
            {picker.shown.length === 0 && (
              <div className="seed-note">
                nothing matches “{picker.filter.trim()}”
              </div>
            )}
          </div>
          <div className="seed-explainer">
            we read its tracks, then make a new mixtape in the
            same spirit — no songs copied over
          </div>
        </>
      ) : playlists === "unauthorized" ? (
        <a href="/auth/login" className="seed-reauth">
          reconnect Spotify to browse your playlists
        </a>
      ) : playlists === "error" ? (
        <div className="seed-error-row">
          <span className="seed-note">
            couldn’t load your playlists
          </span>
          <button
            type="button"
            className="seed-retry"
            onClick={picker.reload}
          >
            retry
          </button>
        </div>
      ) : (
        <span className="seed-note">loading your playlists…</span>
      )}
    </div>
  );
}
