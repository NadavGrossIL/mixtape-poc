import { type MouseEvent, type MutableRefObject } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { followSpotifyLink, noteOutboundLink } from "../spotifyLink";
import { cleanTitle, jamLinks } from "../jamLinks";
import { track } from "../analytics";
import { type Track } from "../types";

const UNVERIFIED_TITLE =
  "Spotify couldn't confirm this track exists — the curator may have " +
  "misremembered it. Tap to search Spotify yourself.";
const UNVERIFIED_JAM_TITLE =
  "Spotify couldn't confirm this track exists — the curator may have " +
  "misremembered it.";

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
//
// A jam card's row (card.mode "jam") has no hidden links at all: the owner's
// rule is that nothing on it surprises (docs/demos/jam-design-brief.md). Its
// title is plain text with no overlay, its art is only a picture, and the
// chips under the entry are the row's only links, each naming its site.
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
  // a jam card's row: plain title, and the link chips under the entry
  jam: boolean;
  // a jam row's place in the room: the song being played, or the next one
  now: "now" | "next" | null;
  // any of a jam row's links was opened: it becomes the now-playing row
  onOpenLink: () => void;
  onClearNow?: () => void;
}

export default function TrackRow({ id, t, index, accentInk, editable, adjusting, replacing, href, justDragged, onSwap, jam, now, onOpenLink, onClearNow }: TrackRowProps) {
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

  // the one replace control, placed per mode: under the note on a mixtape,
  // at the end of the artist line on a jam card (saves a line per row)
  const swapButton = editable && (
    <button
      type="button"
      className="swap-btn"
      disabled={adjusting}
      title={
        jam
          ? "Swap this song for a different one that fits the set"
          : "Replace this song with a different one that fits the mixtape"
      }
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
      <span className="swap-label">{jam ? "swap song" : "replace"}</span>
    </button>
  );

  const title = jam ? cleanTitle(t.title) : t.title;

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
        "track-row" +
        (isDragging ? " dragging" : "") +
        (replacing ? " replacing" : "") +
        (now === "now" ? " jam-now" : "")
      }
      aria-current={now === "now" ? "true" : undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // a jam row is not a link: no pointer hand promising a tap
        cursor: editable ? "grab" : jam ? "auto" : "pointer",
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
      {jam ? (
        // the setlist's red marker number, written over the art's corner
        <div className="jam-art">
          {t.resolved && t.albumArt ? (
            <img src={t.albumArt} alt="" className="album-art" draggable={false} />
          ) : (
            <div className="album-art-placeholder" />
          )}
          <span className="jam-num">{index + 1}</span>
        </div>
      ) : (
        <>
          {t.resolved && t.albumArt ? (
            <img src={t.albumArt} alt="" className="album-art" draggable={false} />
          ) : (
            <div className="album-art-placeholder" />
          )}
          <div className="track-num" style={{ color: accentInk }}>
            {String(index + 1).padStart(2, "0")}
          </div>
        </>
      )}
      <div className="track-main">
        {/* the room's place in the set. The NOW tag is its own undo: a
            labelled button, kept out of the row's drag like replace */}
        {now === "now" && (
          <button
            type="button"
            className="jam-now-tag"
            aria-label={`Now playing: ${title}. Clear the mark`}
            title="Clear the now-playing mark"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={onClearNow}
          >
            <span className="jam-now-label">NOW</span>
            <span className="jam-now-clear">clear ×</span>
          </button>
        )}
        {now === "next" && <div className="jam-next-tag">UP NEXT</div>}
        <div className="track-title">
          {jam ? (
            // Plain text, not a link (no surprises). Still an <a>, without an
            // href, because two things look for `.track-title a`: dnd-kit's
            // keyboard pickup needs a focusable activator, and TrackList
            // puts focus back on it after a keyboard drop. While editable it
            // takes dnd-kit's own attributes and is announced as a sortable
            // button; otherwise it is inert text.
            <a
              ref={editable ? setActivatorNodeRef : undefined}
              {...(editable ? attributes : {})}
            >
              {title}
            </a>
          ) : (
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
          )}
        </div>
        {jam && (
          <div className="jam-artist-line">
            <span className="jam-artist">{t.artist}</span>
            {swapButton}
          </div>
        )}
        <div className="track-note">{t.note}</div>
        {/* under the note, not in the chrome column: as a sibling it
            squeezed a phone's title column to ~110px. Above the link's
            overlay so its tooltip shows; a click on it still opens the
            song, as the tooltip promises. On a jam card it is only a
            label: its sole link would be one nobody was told about. */}
        {!t.resolved && (
          <div
            className="unverified"
            title={jam ? UNVERIFIED_JAM_TITLE : UNVERIFIED_TITLE}
            onClick={jam ? undefined : openSong}
          >
            unverified
          </div>
        )}
        {/* under the note, as podcast apps put an episode's actions: beside
            the title it squeezed a phone's song name onto three lines */}
        {!jam && swapButton}
      </div>
      {/* a jam card's links, resolved or not: search pages on the sites
          musicians use (jamLinks.ts), built from the curator's own artist
          and title, plus Listen on Spotify for a verified track. The row's
          only links, so each says where it goes (↗ = a new tab; the site in
          its tooltip and accessible name). ph-no-capture: autocapture
          would record the href, which holds the artist and title;
          jam_link_opened carries the site only. The presses stay out of
          the row's drag, like the replace button's. */}
      {jam && (
        <nav
          className="jam-links ph-no-capture"
          aria-label={`Links for ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {jamLinks(t).map((l) => (
            <a
              key={l.site}
              className={"jam-chip" + (l.site === "chords" ? " jam-chip--main" : "")}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              draggable={false}
              title={`${l.label} on ${l.siteName}`}
              aria-label={`${l.label} for ${title} by ${t.artist} on ${l.siteName} (opens in a new tab)`}
              onClick={() => {
                noteOutboundLink();
                track("jam_link_opened", { site: l.site });
                onOpenLink();
              }}
            >
              {l.label}
              <span aria-hidden className="jam-chip-arrow">↗</span>
            </a>
          ))}
          {/* the verified song itself; the same hand-off as a mixtape's
              row link (app on desktop, Spotify's page on a phone), and no
              jam_link_opened: it is not one of the jam sites */}
          {t.resolved && t.spotifyUrl && (
            <a
              className="jam-chip"
              href={t.spotifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              draggable={false}
              title="Listen on Spotify"
              aria-label={`Listen to ${title} by ${t.artist} on Spotify (opens in a new tab)`}
              onClick={(e) => {
                noteOutboundLink();
                onOpenLink();
                followSpotifyLink(e, t.spotifyUrl!);
              }}
            >
              Listen
              <span aria-hidden className="jam-chip-arrow">↗</span>
            </a>
          )}
        </nav>
      )}
    </li>
  );
}
