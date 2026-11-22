import { Fragment, type RefObject } from "react";
import TrackList from "./TrackList";
import { BRAND } from "../brand";
import { accentInkFor } from "../card";
import { cardFacts, type MixCard, type Track } from "../types";

// The mixtape card itself: spine, eyebrow, title, vibe, prompt line, the
// legend, the sortable track list and the footer. `saved` is "a playlist
// was pressed from it" (the legend's wording); `titleRef` is how App's
// first-card effect focuses the title.
export default function MixtapeCard({
  card,
  editable,
  adjusting,
  saved,
  titleRef,
  onReorder,
  onSwap,
}: {
  card: MixCard;
  editable: boolean;
  adjusting: boolean;
  saved: boolean;
  titleRef: RefObject<HTMLHeadingElement>;
  onReorder: (activeId: string, overId: string) => void;
  onSwap: (i: number, t: Track) => void;
}) {
  const accentInk = accentInkFor(card);
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
            ? "tap a song to open it in Spotify · drag to reorder · ↻ swaps one"
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
