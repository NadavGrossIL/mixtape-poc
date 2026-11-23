import SpotifyMark from "./SpotifyMark";
import { followSpotifyLink } from "../spotifyLink";
import ShareButton from "./ShareButton";
import { pressedAgo, shelfFor, type LatestMixtape } from "../latest";

// "fresh off the press": everyone's newest presses, minus the ones this
// browser already lists (`ownUrls`), with the owner's "hide". Renders
// nothing when that leaves it empty.
export default function LatestShelf({
  latest,
  ownUrls,
  isOwner,
  onHide,
}: {
  latest: LatestMixtape[];
  ownUrls: string[];
  isOwner: boolean;
  onHide: (id: string, title: string) => void;
}) {
  // one clock reading per render, for the filter and every row's label
  const shelfNow = Date.now();
  const shelf = shelfFor(latest, ownUrls, shelfNow);
  if (shelf.length === 0) return null;
  return (
    <section className="recent latest" aria-labelledby="latest-heading">
      <div className="section-note" id="latest-heading">
        fresh off the press
      </div>
      <ul className="recent-list">
        {shelf.map((m) => (
          <li key={m.id} className="latest-item">
            <a
              href={m.url}
              target="_blank"
              rel="noopener noreferrer"
              className="recent-row latest-row"
              aria-label={`${m.title}, pressed ${pressedAgo(m.pressedAt, shelfNow)} (opens Spotify)`}
              onClick={(e) => followSpotifyLink(e, m.url)}
            >
              <SpotifyMark size={14} />
              <span className="latest-text">
                <span className="recent-title">{m.title}</span>
                {m.vibe && <span className="latest-vibe">“{m.vibe}”</span>}
              </span>
              <span className="recent-open" aria-hidden>
                {pressedAgo(m.pressedAt, shelfNow)}
              </span>
            </a>
            <ShareButton
              title={m.title}
              spotifyUrl={m.url}
              where="latest"
              className="row-share"
            />
            {isOwner && (
              <button
                type="button"
                className="latest-hide"
                aria-label={`hide ${m.title} from this list`}
                onClick={() => onHide(m.id, m.title)}
              >
                hide
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
