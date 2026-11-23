import SpotifyMark from "./SpotifyMark";
import { followSpotifyLink } from "../spotifyLink";
import ShareButton from "./ShareButton";
import { type RecentMixtape } from "../recent";

// "your mixtapes": this browser's presses, newest first, the rest behind a
// "+ N more" toggle, and the link to the host profile that holds them all.
// Renders nothing until this browser has pressed one. The toggle's state
// lives in hooks/useRecentMixtapes.ts, so it survives the home screen
// unmounting under a card.

// how many of "your mixtapes" show before the "+ N more" toggle
const RECENT_SHOWN = 3;

// the host account every mixtape is pressed to (ADR 0002) — the fallback for
// anything this browser's list doesn't hold. Must be the account
// SPOTIFY_HOST_REFRESH_TOKEN holds — or the owner's, which spotify.ts falls
// back to when that is unset — or this link points at the wrong shelf.
const MIXTAPE_PROFILE_URL = "https://open.spotify.com/user/31urgkolpmjmtftwah2ohwg3hzmy";

export default function RecentMixtapes({
  recent,
  showAll,
  onToggle,
}: {
  recent: RecentMixtape[];
  showAll: boolean;
  onToggle: () => void;
}) {
  if (recent.length === 0) return null;
  return (
    <section className="recent" aria-labelledby="recent-heading">
      <div className="section-note" id="recent-heading">
        your mixtapes
      </div>
      <ul className="recent-list">
        {(showAll ? recent : recent.slice(0, RECENT_SHOWN)).map((m) => (
          <li key={m.url} className="latest-item">
            <a
              href={m.url}
              target="_blank"
              rel="noopener noreferrer"
              className="recent-row latest-row"
              aria-label={`${m.title} (opens Spotify)`}
              onClick={(e) => followSpotifyLink(e, m.url)}
            >
              <SpotifyMark size={14} />
              <span className="recent-title">{m.title}</span>
              <span className="recent-open" aria-hidden>
                open ↗
              </span>
            </a>
            <ShareButton
              title={m.title}
              spotifyUrl={m.url}
              where="recent"
              className="row-share"
            />
          </li>
        ))}
      </ul>
      {recent.length > RECENT_SHOWN && (
        <button
          type="button"
          className="recent-more"
          aria-expanded={showAll}
          onClick={onToggle}
        >
          {showAll ? "show fewer" : `+ ${recent.length - RECENT_SHOWN} more`}
        </button>
      )}
      <a
        className="recent-fallback"
        href={MIXTAPE_PROFILE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        every mixtape lives on Mixtape’s Spotify profile
      </a>
    </section>
  );
}
