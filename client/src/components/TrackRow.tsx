import { type MutableRefObject } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { openInSpotify } from "../spotifyLink";
import { type Track } from "../types";

const UNVERIFIED_TITLE =
  "Spotify couldn't confirm this track exists — the curator may have " +
  "misremembered it. Tap to search Spotify yourself.";

// Identity for a track. Not guaranteed unique: a repeated curated track, or
// two entries resolving to the same URI, would collide.
const trackId = (t: Track) => t.spotifyUri || `${t.artist}—${t.title}`;

// Sortable/key id, made unique by position. Computed from the card's current
// order at render time — dnd-kit snapshots items at drag start, so ids stay
// stable for the duration of a drag, and the positional suffix makes the
// drag-end indexOf lookup exact even with duplicate tracks.
export const sortableId = (t: Track, i: number) => `${trackId(t)}#${i}`;

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
  href: string;
  justDragged: MutableRefObject<boolean>;
  onSwap: () => void;
}

export default function TrackRow({ id, t, index, accentInk, editable, adjusting, href, justDragged, onSwap }: TrackRowProps) {
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
        // cmd/ctrl/shift-click keeps its native "open the web URL" meaning;
        // so does a phone tap — the anchor's own navigation is the one
        // hand-off that works inside an in-app webview (see spotifyLink.ts)
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (openInSpotify(href)) e.preventDefault();
      }}
      className={"track-row" + (isDragging ? " dragging" : "")}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        cursor: editable ? "grab" : "pointer",
        // manipulation (not none): the TouchSensor hold-delay owns dragging,
        // so plain swipes over the row must still scroll the page
        touchAction: editable ? "manipulation" : "auto",
      }}
      aria-label={`${t.artist} — ${t.title}${
        t.resolved ? "" : ", unverified"
      } (opens Spotify)`}
    >
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
      </div>
      {editable && (
        <button
          type="button"
          className="swap-btn"
          disabled={adjusting}
          title="Swap this track for a different one that fits"
          aria-label={`Swap track ${index + 1}, ${t.artist} — ${t.title}, for a different one`}
          // keep the button out of the row's drag-activation path —
          // each sensor listens on its own start event
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          // and out of the keyboard sensor's: Space on the button is a swap,
          // but bubbling to the row it would pick the row up instead
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            // a plain click must neither open the track nor start a drag
            e.preventDefault();
            e.stopPropagation();
            onSwap();
          }}
        >
          <span aria-hidden>↻</span>
          <span className="swap-label">swap</span>
        </button>
      )}
    </a>
  );
}
