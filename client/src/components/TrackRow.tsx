import { type MouseEvent, type MutableRefObject } from "react";
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
//
// The row is an <li>, not a link: a <button> inside an <a> is invalid HTML,
// and iOS VoiceOver read the whole row as one element, so "replace" was out
// of a screen reader's reach. The link is the title, stretched over the row
// by `.track-title a::after` (card.css) so a click anywhere still opens the
// song; the grip, the replace button and the unverified tag sit above that
// overlay. Reading order: the song link, then replace.
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
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !editable || adjusting });

  const openSong = (e: MouseEvent) => {
    // the click that follows a drop must not open the track
    if (justDragged.current) {
      e.preventDefault();
      return;
    }
    followSpotifyLink(e, href);
  };

  return (
    <li
      ref={setNodeRef}
      // The listeners sit on the row, so a mouse drags from anywhere on it
      // (events from the link bubble up) and GripTouchSensor sees touches on
      // the grip. Keyboard pickup is narrowed to the link: it is the
      // activator node, and dnd-kit's KeyboardSensor ignores a Space whose
      // target is not the activator.
      {...(editable ? listeners : {})}
      // An <a href> and an <img> are natively draggable: without this, Chrome
      // starts its own drag on the same gesture and dnd-kit's reorder never
      // lands.
      onDragStart={editable ? (e) => e.preventDefault() : undefined}
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
    >
      {editable && (
        // the "this row moves" sign. A mouse drags from anywhere on the row
        // (here it is the hint, with the grab cursor); on touch this is the
        // only place a drag starts (GripTouchSensor).
        // Hidden from assistive tech: the song link is the keyboard handle.
        <span className="grip" data-grip aria-hidden>
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
          <a
            ref={editable ? setActivatorNodeRef : undefined}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            draggable={editable ? false : undefined}
            // Only dnd-kit's keyboard instructions ("press space bar to pick
            // up") come along from its `attributes`: its role="button" and
            // aria-roledescription="sortable" would have hidden that this
            // is a link, and a link is focusable on its own.
            aria-describedby={editable ? attributes["aria-describedby"] : undefined}
            aria-label={`${t.artist} — ${t.title}${
              t.resolved ? "" : ", unverified"
            } (opens Spotify)`}
            onClick={openSong}
          >
            {t.artist} — {t.title}
          </a>
        </div>
        <div className="track-note">{t.note}</div>
        {/* under the note, not in the chrome column: as a sibling it
            squeezed a phone's title column to ~110px. Above the link's
            overlay so its tooltip shows; a click on it still opens the
            song, as the tooltip promises. */}
        {!t.resolved && (
          <div className="unverified" title={UNVERIFIED_TITLE} onClick={openSong}>
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
            // and out of the keyboard sensor's: Space on the button is a
            // replace, never a pickup (the activator check says so too)
            onKeyDown={(e) => e.stopPropagation()}
            onClick={onSwap}
          >
            {/* "↻ swap" read as reload or as "swap places"; the verb says
                what happens to this song, and phones keep the word too */}
            <span aria-hidden className="swap-icon">↻</span>
            <span className="swap-label">replace</span>
          </button>
        )}
      </div>
    </li>
  );
}
