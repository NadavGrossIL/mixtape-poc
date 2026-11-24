import { useEffect, useState } from "react";
import SiteHeader from "./SiteHeader";
import MixtapeCard from "./MixtapeCard";
import SpotifyMark from "./SpotifyMark";
import ShareButton from "./ShareButton";
import { followSpotifyLink } from "../spotifyLink";
import { startAnalytics, track } from "../analytics";
import useSession from "../hooks/useSession";
import usePageView from "../hooks/usePageView";
import { type MixCard } from "../types";

// The share page, /m/<playlist id> (server/shares.ts): what a friend lands
// on from a shared link. The pressed card, read-only, then OPEN IN SPOTIFY,
// share it on, and "make your own" back to the front page. A mixtape pressed
// before share pages existed has only its shelf entry (title + vibe, no
// tracks), so that shows as a title block instead of a card.
//
// A jam set shows as its Taped Setlist card, chips and all, read-only. One
// shared without a Spotify save (a 23-char id) has no playlist: `url` is
// null, so there is no OPEN IN SPOTIFY — each row's own Spotify chip still
// opens its track — and the share button sends this page's own link.
type Shared = MixCard & { id: string; url: string | null };

export default function SharedMixtape({ id }: { id: string }) {
  const { loggedIn, isOwner } = useSession();
  usePageView();
  useEffect(() => {
    if (loggedIn !== null) startAnalytics({ owner: isOwner });
  }, [loggedIn, isOwner]);

  const [state, setState] = useState<"loading" | "missing" | Shared>("loading");
  useEffect(() => {
    fetch(`/api/mixtape/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { mixtape?: Shared } | null) => {
        if (!d?.mixtape) return setState("missing");
        setState(d.mixtape);
        document.title = `${d.mixtape.title} — a Mixtape`;
        track("shared_page_viewed", { tracks: d.mixtape.tracks.length });
      })
      .catch(() => setState("missing"));
  }, [id]);

  const [announce, setAnnounce] = useState("");

  return (
    <div className="app">
      <div className="vh" role="status" aria-live="polite">
        {announce}
      </div>
      <SiteHeader compact />
      <main className="main-col">
        {state === "loading" && <div className="checking">finding the tape…</div>}
        {state === "missing" && (
          <div className="shared-missing">
            <p>This mixtape isn’t here anymore.</p>
            <a className="btn-press" href="/">
              MAKE YOUR OWN
            </a>
          </div>
        )}
        {typeof state === "object" && (
          <div className="card-wrap">
            <div className="shared-kicker">
              {state.mode === "jam" ? "someone made you a jam set" : "someone made you a mixtape"}
            </div>
            {state.tracks.length > 0 ? (
              <MixtapeCard
                card={state}
                editable={false}
                adjusting={false}
                swapping={null}
                saved
                onReorder={() => {}}
                onSwap={() => {}}
              />
            ) : (
              <div className="shared-plain">
                <h2 className="shared-title">{state.title}</h2>
                {state.vibe && <p className="shared-vibe">“{state.vibe}”</p>}
              </div>
            )}
            <div className="pressed">
              {state.url && (
                <a
                  href={state.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-press pressed-open"
                  aria-label="Open this mixtape in Spotify"
                  onClick={(e) => {
                    track("playlist_opened", { where: "page" });
                    if (state.url) followSpotifyLink(e, state.url);
                  }}
                >
                  <SpotifyMark />
                  OPEN IN SPOTIFY
                </a>
              )}
              <ShareButton
                title={state.title}
                {...(state.url
                  ? { spotifyUrl: state.url }
                  : { url: `${window.location.origin}/m/${state.id}`, kind: "set" as const })}
                where="page"
                className="btn-share pressed-share"
                label="SHARE IT ON"
                ariaLabel="Share this mixtape"
                announce={setAnnounce}
              />
              <a
                className="shared-own"
                href="/"
                onClick={() => track("shared_make_own")}
              >
                {/* not "make your own set": jam mode is invite-only, so most friends
                    who tap this land on the mixtape maker — say what they'll get */}
                {"make your own mixtape →"}
              </a>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
