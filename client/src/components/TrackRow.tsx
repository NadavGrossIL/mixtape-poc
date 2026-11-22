import { type MutableRefObject } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { followSpotifyLink } from "../spotifyLink";
import { type Track } from "../types";

const UNVERIFIED_TITLE =
  "Spotify couldn't confirm this track exists — the curator may have " +
  "misremembered it. Tap to search Spotify yourself.";

// One row on the sleeve. The entire row is the drag surface (dnd-kit sortable);
// while not editable it degrades to the plain link row it always was.
// While a refine is in flight, drag and the swap button are disabled — the
// server merges against the card the client sent, so mid-flight edits would
// be clobbered by the merged result.
interface TrackRowProps {
  id: string;
  t: Track;
  index: number;
  accentInk: string;
  editable: boolean;
  adjusting: boolean;
  replacing: boolean;
  href: string;
  justDragged: MutableRefObject<boolean>;
  onSwap: () => void;
}

export default function TrackRow({ id, t, index, accentInk, editable, adjusting, replacing, href, justDragged, onSwap }: TrackRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !editable || adjusting });

  return (
    <a
      ref={setNodeRef}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...(editable ? attributes : {})}
      {...(editable ? listeners : {})}
      // An <a href> is natively draggable: without this, Chrome starts its own
      // link-drag on the same gesture and dnd-kit's reorder never lands.
      draggable={editable ? false : undefined}
      onDragStart={editable ? (e) => e.preventDefault() : undefined}
      onClick={(e) => {
        if (justDragged.current) {
          e.preventDefault();
          return;
        }
        followSpotifyLink(e, href);
      }}
      className={
        "track-row" + (isDragging ? " dragging" : "") + (replacing ? " replacing" : "")
      }
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        cursor: editable ? "grab" : "pointer",
        // manipulation (not none): only the grip drags on touch, so swipes
        // over the rest of the row must still scroll the page
        touchAction: editable ? "manipulation" : "auto",
      }}
      aria-label={`${t.artist} — ${t.title}${
        t.resolved ? "" : ", unverified"
      } (opens Spotify)`}
    >
      {editable && (
        // the "this row moves" sign. A mouse drags from anywhere on the row
        // (here it is the hint, with the grab cursor); on touch this is the
        // only place a drag starts (GripTouchSensor).
        // Hidden from assistive tech: the row itself is the keyboard handle.
        <span
          className="grip"
          data-grip
          aria-hidden
          // a tap on the grip is not a tap on the song
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <svg viewBox="0 0 8 14" width="8" height="14">
            {[2, 7, 12].map((y) =>
              [2, 6].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.3" />)
            )}
          </svg>
        </span>
      )}
      {t.resolved && t.albumArt ? (
        <img src={t.albumArt} alt="" className="album-art" draggable={false} />
      ) : (
        <div className="album-art-placeholder" />
      )}
      <div className="track-num" style={{ color: accentInk }}>
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="track-main">
        <div className="track-title">
          {t.artist} — {t.title}
        </div>
        <div className="track-note">{t.note}</div>
        {/* under the note, not in the chrome column: as a sibling it
            squeezed a phone's title column to ~110px */}
        {!t.resolved && (
          <div className="unverified" title={UNVERIFIED_TITLE}>
            unverified
          </div>
        )}
        {/* under the note, as podcast apps put an episode's actions: beside
            the title it squeezed a phone's song name onto three lines */}
        {editable && (
          <button
            type="button"
            className="swap-btn"
            disabled={adjusting}
            title="Replace this song with a different one that fits the mixtape"
            aria-label={`Replace track ${index + 1}, ${t.artist} — ${t.title}, with a different song`}
            // keep the button out of the row's drag-activation path —
            // each sensor listens on its own start event
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            // and out of the keyboard sensor's: Space on the button is a replace,
            // but bubbling to the row it would pick the row up instead
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              // a plain click must neither open the track nor start a drag
              e.preventDefault();
              e.stopPropagation();
              onSwap();
            }}
          >
            {/* "↻ swap" read as reload or as "swap places"; the verb says
                what happens to this song, and phones keep the word too */}
            <span aria-hidden className="swap-icon">↻</span>
            <span className="swap-label">replace</span>
          </button>
        )}
      </div>
    </a>
  );
}
