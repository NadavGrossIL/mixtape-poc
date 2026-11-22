import { Fragment, useEffect, useRef } from "react";
import TrackList from "./TrackList";
import { BRAND } from "../brand";
import { accentInkFor } from "../card";
import { cardFacts, type MixCard, type Track } from "../types";

// The mixtape card itself: spine, eyebrow, title, vibe, prompt line, the
// legend, the sortable track list and the footer. `saved` is "a playlist
// was pressed from it" (the legend's wording). It focuses its own title
// when it mounts, which is when a card arrives.
export default function MixtapeCard({
  card,
  editable,
  adjusting,
  saved,
  onReorder,
  onSwap,
}: {
  card: MixCard;
  editable: boolean;
  adjusting: boolean;
  saved: boolean;
  onReorder: (activeId: string, overId: string) => void;
  onSwap: (i: number, t: Track) => void;
}) {
  const accentInk = accentInkFor(card);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  // Move focus to the result when it lands, so keyboard and
  // screen-reader users aren't stranded back at the prompt. Only when a card
  // arrives where there was none: a reorder, a swap or a refine is a new
  // card object too, and focusing the title on those jumped the page away
  // from the row the visitor was working on.
  //
  // A mount effect, replacing App's hadCardRef and its effect on [card].
  // Same trigger: App renders this exactly while `card` is non-null, at a
  // fixed place in the tree, so it mounts exactly when a card arrives where
  // there was none, and a reorder, swap or refine re-renders this same
  // instance. Never give it (or TrackList) a `key` such as the title: a
  // refine would then remount it, steal focus to the title and drop
  // TrackList's pending keyboard-drop refocus. On the arrival commit
  // TrackList's [tracks] effect runs first (child before parent) but has no
  // pending row, so only this one moves focus. Mount-only is safe because
  // there is no StrictMode (main.tsx); under it this would run twice.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <div className="card">
      {/* spine */}
      <div className="spine" style={{ background: accentInk }}>
        <span className="spine-text">{card.title.toUpperCase()}</span>
      </div>

      <div className="card-body">
        {/* facts and date in two spans so a narrow card wraps at the
            date; each fact is its own no-wrap span so a line never
            breaks inside "1984–2018" */}
        <div className="eyebrow">
          <span>
            {["SIDE A", `${card.tracks.length} TRACKS`, ...cardFacts(card.tracks)].map(
              (fact, i) => (
                <Fragment key={fact}>
                  {i > 0 && " · "}
                  <span className="fact">{fact}</span>
                </Fragment>
              )
            )}
          </span>
          <span>
            CUT{" "}
            {new Date()
              .toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "2-digit",
              })
              .toUpperCase()}
          </span>
        </div>
        <h2 className="card-title" tabIndex={-1} ref={titleRef}>
          {card.title}
        </h2>
        <div className="vibe" style={{ borderColor: accentInk }}>
          “{card.vibe}”
        </div>
        <div className="prompt-line">
          {card.prompt && (
            <>
              prompted: <em>{card.prompt}</em>
            </>
          )}
          {card.prompt && card.seed && " · "}
          {card.seed && (
            <>
              in the spirit of: <em>{card.seed.name}</em>
            </>
          )}
        </div>

        {/* how the list works, said before the list. It used to be the
            card's last line, under eight rows — read after the fact,
            if at all. */}
        <div className="card-legend">
          {/* keyed to "not saved yet", not to `editable`: that goes
              false the moment save is tapped, and the shorter text
              shifted the whole list up a line on a phone */}
          {!saved
            ? "tap a song to open it in Spotify · drag ⋮⋮ to reorder"
            : "tap a song to open it in Spotify"}
        </div>

        <TrackList
          tracks={card.tracks}
          accentInk={accentInk}
          editable={editable}
          adjusting={adjusting}
          onReorder={onReorder}
          onSwap={onSwap}
        />

        <div className="card-footer">
          <span className="footer-brand">{BRAND} · STEREO</span>
          <div className="barcode" aria-hidden />
        </div>
      </div>
    </div>
  );
}
