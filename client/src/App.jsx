import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { openInSpotify } from "./spotifyLink";

// Color tokens live in styles.css. This map is the per-mixtape accent,
// darkened per hue to hold ≥4.5:1 contrast as ink on the cream card.
const ACCENT_INK = {
  crimson: "#A81F24",
  cobalt: "#1F4BC7",
  forest: "#1D6A43",
  tangerine: "#B34A08",
  violet: "#5F3DC4",
  gold: "#8A6508",
};

// Each example demonstrates a different prompt axis: speed/skill,
// mood+moment, discovery/language, era+audience.
const EXAMPLES = [
  "fastest rap verses ever recorded — Rap God energy",
  "songs that sound like driving home at 2am",
  "hebrew indie that deserves a bigger audience",
  "90s hip-hop for a newborn's first road trip",
];

// Candidate product names — cycle with the tiny dev switcher in the corner.
// Where a slash exists it keeps the orange slash accent.
const BRANDS = ["MADE YOU A MIXTAPE", "DEEP/CUTS", "PROMP/TAPE"];

const UNVERIFIED_TITLE =
  "Spotify couldn't confirm this track exists — the curator may have " +
  "misremembered it. Tap to search Spotify yourself.";

// Minimal SSE parser over a fetch ReadableStream (native only, no libraries).
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          // per spec: strip one leading space only, join multi-line data with \n
          const value = line.slice(5);
          dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
        }
      }
      const data = dataLines.join("\n");
      let parsed = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        /* keep null */
      }
      onEvent(event, parsed);
    }
  }
}

// Cassette mark. Stroke-based so it stays crisp at header size: the shell
// inherits currentColor; reels and the spilled tape carry the accent.
function Logo() {
  return (
    <svg
      className="logo"
      viewBox="0 0 44 33"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="40" height="22" rx="3" />
      <path d="M15 9.5h14" className="logo-accent" />
      <circle cx="15" cy="14" r="4.5" className="logo-accent" />
      <circle cx="29" cy="14" r="4.5" className="logo-accent" />
      <path d="M15.5 25l1.8-4h9.4l1.8 4" />
      <path
        d="M9 25c0 4.5 5.5 5 10.5 3.5 4-1.2 8-1 12.5 1"
        className="logo-accent"
      />
    </svg>
  );
}

function BrandText({ text }) {
  const i = text.indexOf("/");
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="slash">/</span>
      {text.slice(i + 1)}
    </>
  );
}

// Identity for a track. Not guaranteed unique: a repeated curated track, or
// two entries resolving to the same URI, would collide.
const trackId = (t) => t.spotifyUri || `${t.artist}—${t.title}`;

// Sortable/key id, made unique by position. Computed from the card's current
// order at render time — dnd-kit snapshots items at drag start, so ids stay
// stable for the duration of a drag, and the positional suffix makes the
// drag-end indexOf lookup exact even with duplicate tracks.
const sortableId = (t, i) => `${trackId(t)}#${i}`;

// One row on the sleeve. The entire row is the drag surface (dnd-kit sortable);
// while not editable it degrades to the plain link row it always was.
// While a refine is in flight, drag and the swap button are disabled — the
// server merges against the card the client sent, so mid-flight edits would
// be clobbered by the merged result.
function TrackRow({ id, t, index, accentInk, editable, adjusting, href, justDragged, onSwap }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !editable || adjusting });

  return (
    <a
      ref={setNodeRef}
      href={href}
      target="_blank"
      rel="noreferrer"
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
        // cmd/ctrl/shift-click keeps its native "open the web URL" meaning
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openInSpotify(href);
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
      </div>
      {t.resolved ? (
        <div className="play-hint" aria-hidden>
          ▸
        </div>
      ) : (
        <div className="unverified" title={UNVERIFIED_TITLE}>
          unverified
        </div>
      )}
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
          onClick={(e) => {
            // a plain click must neither open the track nor start a drag
            e.preventDefault();
            e.stopPropagation();
            onSwap();
          }}
        >
          ↻
        </button>
      )}
    </a>
  );
}

export default function LinerNotes() {
  const [prompt, setPrompt] = useState("");
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loggedIn, setLoggedIn] = useState(null); // null = checking
  const [brandIdx, setBrandIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState(null);
  const [saveError, setSaveError] = useState(null);
  // real progress, driven only by SSE events from the backend
  const [stage, setStage] = useState(null); // "seeding" | "curating" | "resolving"
  const [logTracks, setLogTracks] = useState([]); // {artist, title, resolved?}
  const [seedLog, setSeedLog] = useState(null); // {name} while seeding this run
  // "in the spirit of" seed picker
  const [playlists, setPlaylists] = useState(null); // null=loading | [] | "unauthorized" | "error"
  const [seedId, setSeedId] = useState("");
  const [saveStage, setSaveStage] = useState(null); // "creating" | "adding N"
  const [inputHint, setInputHint] = useState(null);
  const [announce, setAnnounce] = useState(""); // screen-reader milestones
  // second-chance refine — same real-SSE discipline as generate
  const [adjustText, setAdjustText] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState(null);
  const [adjustStage, setAdjustStage] = useState(null); // "adjusting" | "resolving"
  const [adjustLog, setAdjustLog] = useState([]); // {index, artist, title, resolved?}

  const inputRef = useRef(null);
  const refineRef = useRef(null);
  const cardTitleRef = useRef(null);
  const abortRef = useRef(null);
  const adjustAbortRef = useRef(null);

  // drag-to-reorder: the whole row is the drag surface. Mouse drags activate
  // after 8px (a click still opens Spotify); touch needs a 250ms hold so a
  // finger can still scroll the list — moving during the hold cancels the drag.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
  );
  const justDragged = useRef(false);

  const brand = BRANDS[brandIdx];

  useEffect(() => {
    fetch("/auth/status")
      .then((r) => r.json())
      .then((d) => setLoggedIn(Boolean(d.loggedIn)))
      .catch(() => setLoggedIn(false));
  }, []);

  // the seed picker's playlist list. 403 = the stored token predates the
  // playlist-read scopes — surfaced as a "reconnect Spotify" link.
  useEffect(() => {
    if (loggedIn !== true) return;
    fetch("/api/playlists")
      .then(async (r) => {
        if (r.status === 403) return setPlaylists("unauthorized");
        if (!r.ok) throw new Error("playlists failed");
        const d = await r.json();
        setPlaylists(Array.isArray(d.playlists) ? d.playlists : []);
      })
      .catch(() => setPlaylists("error"));
  }, [loggedIn]);

  // Move focus to the result when it lands, so keyboard and
  // screen-reader users aren't stranded back at the prompt.
  useEffect(() => {
    if (card) cardTitleRef.current?.focus();
  }, [card]);

  const seedPlaylist = Array.isArray(playlists)
    ? playlists.find((p) => p.id === seedId) || null
    : null;

  const generate = async (p) => {
    const thePrompt = (p ?? prompt).trim();
    if (loading || adjusting) return;
    // a seed playlist alone is a valid ask ("just like this one")
    if (!thePrompt && !seedPlaylist) {
      setInputHint(
        "Type a vibe first — a mood, a moment, an era — or pick a playlist to channel."
      );
      inputRef.current?.focus();
      return;
    }
    setLoading(true);
    setError(null);
    setCard(null);
    setPlaylistUrl(null);
    setSaveError(null);
    setAdjustError(null);
    setAdjustText("");
    setStage(null);
    setLogTracks([]);
    setSeedLog(null);
    setAnnounce("Pressing your mixtape.");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: thePrompt,
          ...(seedPlaylist
            ? { seed: { id: seedPlaylist.id, name: seedPlaylist.name } }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "generate failed");
      }
      let doneCard = null;
      let streamError = null;
      await readSSE(response, (event, data) => {
        if (event === "seeding") {
          setStage("seeding");
          setSeedLog({ name: data?.name || "your playlist" });
          setAnnounce("Reading your playlist.");
        } else if (event === "curating") {
          setStage("curating");
          setAnnounce("Digging through the crates.");
        } else if (event === "track") {
          setLogTracks((ts) => {
            const next = [...ts];
            next[data.index] = { artist: data.artist, title: data.title };
            return next;
          });
        } else if (event === "curated") {
          setStage("resolving");
          setAnnounce("Resolving tracks on Spotify.");
        } else if (event === "resolved") {
          setLogTracks((ts) => {
            const next = [...ts];
            if (next[data.index]) {
              next[data.index] = { ...next[data.index], resolved: data.resolved };
            }
            return next;
          });
        } else if (event === "done") {
          doneCard = data?.card;
        } else if (event === "error") {
          streamError = data?.message || "generate failed";
        }
      });
      if (streamError) throw new Error(streamError);
      if (!doneCard?.tracks?.length) throw new Error("empty");
      const verified = doneCard.tracks.filter((t) => t.resolved).length;
      setAnnounce(
        `Mixtape ready: ${doneCard.tracks.length} tracks, ${verified} verified on Spotify.`
      );
      setCard(doneCard);
    } catch (e) {
      if (e.name === "AbortError") {
        setAnnounce("Stopped.");
      } else {
        console.error(e);
        setError("The curator dropped the needle. Try the same prompt again.");
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  const stopGenerating = () => {
    abortRef.current?.abort();
  };

  // Second-chance refine: send the current card + an adjustment instruction,
  // stream the diff, swap in the merged card. One pipeline serves both the
  // refine box and the per-track ↻ swap buttons.
  const refine = async (instruction) => {
    const theInstruction = (instruction ?? adjustText).trim();
    if (!card || adjusting || saving || loading) return;
    if (!theInstruction) {
      refineRef.current?.focus();
      return;
    }
    setAdjusting(true);
    setAdjustError(null);
    setAdjustStage(null);
    setAdjustLog([]);
    setAnnounce("Rewinding the tape.");
    let changeCount = 0;
    const controller = new AbortController();
    adjustAbortRef.current = controller;
    try {
      const response = await fetch("/api/adjust/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ card, adjustment: theInstruction }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "adjust failed");
      }
      let doneCard = null;
      let streamError = null;
      await readSSE(response, (event, data) => {
        if (event === "adjusting") {
          setAdjustStage("adjusting");
        } else if (event === "change") {
          changeCount++;
          setAdjustLog((ls) => [
            ...ls,
            { index: data.index, artist: data.artist, title: data.title },
          ]);
        } else if (event === "adjusted") {
          setAdjustStage("resolving");
          setAnnounce("Resolving the new tracks on Spotify.");
        } else if (event === "resolved") {
          setAdjustLog((ls) =>
            ls.map((l) =>
              l.index === data.index ? { ...l, resolved: data.resolved } : l
            )
          );
        } else if (event === "done") {
          doneCard = data?.card;
        } else if (event === "error") {
          streamError = data?.message || "adjust failed";
        }
      });
      if (streamError) throw new Error(streamError);
      if (!doneCard?.tracks?.length) throw new Error("empty");
      setAnnounce(
        `Mixtape adjusted: ${changeCount} track${changeCount === 1 ? "" : "s"} changed.`
      );
      setCard(doneCard);
      setAdjustText("");
    } catch (e) {
      if (e.name === "AbortError") {
        setAnnounce("Stopped.");
      } else {
        console.error(e);
        setAdjustError("The curator couldn't rewind that one. Try rewording it.");
      }
    } finally {
      adjustAbortRef.current = null;
      setAdjusting(false);
      setAdjustStage(null);
      setAdjustLog([]);
    }
  };

  const stopAdjusting = () => {
    adjustAbortRef.current?.abort();
  };

  // Per-track swap: a canned instruction through the same refine pipeline.
  const swapTrack = (i, t) =>
    refine(
      `Replace track ${i + 1} (${t.artist} — ${t.title}) with a different track that fits the mixtape. Keep every other track exactly as it is.`
    );

  const saveToSpotify = async () => {
    if (!card || saving) return;
    const uris = card.tracks.filter((t) => t.resolved).map((t) => t.spotifyUri);
    if (!uris.length) {
      setSaveError("No verified tracks to save.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveStage(null);
    try {
      const response = await fetch("/api/playlist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          title: card.title,
          uris,
          // seed-only cards have no prompt — the playlist description should
          // still say where the mixtape came from
          prompt:
            card.prompt ||
            (card.seed ? `in the spirit of ${card.seed.name}` : ""),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "save failed");
      }
      let url = null;
      let streamError = null;
      await readSSE(response, (event, data) => {
        if (event === "creating") setSaveStage("CREATING PLAYLIST…");
        else if (event === "adding") setSaveStage(`ADDING ${data?.count} TRACKS…`);
        else if (event === "done") url = data?.playlistUrl;
        else if (event === "error") streamError = data?.message || "save failed";
      });
      if (streamError) throw new Error(streamError);
      setAnnounce("Playlist saved to Spotify.");
      setPlaylistUrl(url);
    } catch (e) {
      console.error(e);
      setSaveError("Couldn't press it to Spotify. Try again.");
    } finally {
      setSaving(false);
      setSaveStage(null);
    }
  };

  const accentInk = card
    ? ACCENT_INK[card.accent] || ACCENT_INK.crimson
    : ACCENT_INK.crimson;

  const liveVerified = logTracks.filter((t) => t && t.resolved === true).length;
  const cardVerified = card ? card.tracks.filter((t) => t.resolved).length : 0;
  const cardUnverified = card ? card.tracks.length - cardVerified : 0;
  const cursor = (
    <span className="cursor" aria-hidden>
      ▮
    </span>
  );

  const spotifySearch = (t) =>
    `https://open.spotify.com/search/${encodeURIComponent(t.artist + " " + t.title)}`;

  // reorder is a pure client-side edit; the save flow reads card.tracks in
  // order, so the pressed playlist follows whatever order is on the card
  const editable = Boolean(card) && !playlistUrl && !saving;

  const onDragEnd = ({ active, over }) => {
    // the click that follows a drop must not open the track
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    if (over && active.id !== over.id) {
      setCard((c) => {
        const ids = c.tracks.map(sortableId);
        return {
          ...c,
          tracks: arrayMove(c.tracks, ids.indexOf(active.id), ids.indexOf(over.id)),
        };
      });
    }
  };

  return (
    <div className="app">
      {/* screen-reader milestones: one line per stage, never per token */}
      <div className="vh" role="status" aria-live="polite">
        {announce}
      </div>

      <header className="header">
        <h1 className="wordmark">
          <Logo />
          <BrandText text={brand} />
        </h1>
        <div className="tagline">one prompt in. a record sleeve out.</div>
      </header>

      <main className="main-col">
        {loggedIn === null && <div className="checking">checking the deck…</div>}

        {/* login gate */}
        {loggedIn === false && (
          <a href="/auth/login" className="btn-press">
            CONNECT SPOTIFY
          </a>
        )}

        {loggedIn === true && (
          <>
            {/* input */}
            <div className="input-row">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  if (inputHint) setInputHint(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    generate();
                  }
                }}
                placeholder="songs for driving at night through 1984…"
                rows={2}
                className="prompt-input"
                aria-label="Playlist prompt"
              />
              <button
                onClick={loading ? stopGenerating : () => generate()}
                className="btn-press"
              >
                {loading ? "STOP" : "PRESS IT"}
              </button>
            </div>
            {inputHint && (
              <div className="input-hint" role="alert">
                {inputHint}
              </div>
            )}

            {/* "in the spirit of" seed picker — optional; with a playlist
                picked, the prompt may stay empty */}
            {!card && !loading && (
              <div className="seed-row">
                <label htmlFor="seed-select" className="seed-label">
                  in the spirit of
                </label>
                {Array.isArray(playlists) ? (
                  <select
                    id="seed-select"
                    className="seed-select"
                    value={seedId}
                    onChange={(e) => {
                      setSeedId(e.target.value);
                      setInputHint(null);
                    }}
                  >
                    <option value="">— nothing, fresh from the prompt —</option>
                    {playlists.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.total != null ? ` · ${p.total} tracks` : ""}
                      </option>
                    ))}
                  </select>
                ) : playlists === "unauthorized" ? (
                  <a href="/auth/login" className="seed-reauth">
                    reconnect Spotify to browse your playlists
                  </a>
                ) : playlists === "error" ? (
                  <span className="seed-note">couldn’t load your playlists</span>
                ) : (
                  <span className="seed-note">loading your playlists…</span>
                )}
              </div>
            )}

            {!card && !loading && (
              <div className="scope-line">
                describe a vibe, moment, or era — you get 8 real tracks with
                liner notes
              </div>
            )}

            {/* example chips: populate the prompt, stay editable */}
            {!card && !loading && (
              <div className="chips">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="chip"
                    onClick={() => {
                      setPrompt(ex);
                      setInputHint(null);
                      inputRef.current?.focus();
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {loading && (
          <div className="loading">
            <div className="spinner-disc" aria-hidden />
            {/* studio-console progress log — every line is a real backend event.
                aria-hidden: the live region above narrates the milestones. */}
            <div className="progress-log" aria-hidden>
              {!stage && <div className="log-line">reading your prompt…{cursor}</div>}
              {seedLog && (
                <div className="log-line">
                  pulling from “{seedLog.name}”…
                  {stage === "seeding" ? cursor : <span className="log-ok"> ok</span>}
                </div>
              )}
              {stage && stage !== "seeding" && (
                <div className="log-line">
                  digging through the crates…
                  {stage === "curating" ? cursor : <span className="log-ok"> ok</span>}
                </div>
              )}
              {logTracks.map(
                (t, i) =>
                  t && (
                    <div key={i} className="log-track">
                      <span className="log-arrow">→</span>{" "}
                      <span className="log-num">
                        {String(i + 1).padStart(2, "0")}
                      </span>{" "}
                      {t.artist} — {t.title}
                      {t.resolved === true && <span className="log-check"> ✓</span>}
                      {t.resolved === false && (
                        <span className="log-unverified"> unverified</span>
                      )}
                    </div>
                  )
              )}
              {stage === "resolving" && (
                <div className="log-line">
                  resolving on spotify… {liveVerified}/{logTracks.length} verified
                  {cursor}
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {/* the card */}
        {card && (
          <div className="card-wrap">
            <div className="card">
              {/* spine */}
              <div className="spine" style={{ background: accentInk }}>
                <span className="spine-text">{card.title.toUpperCase()}</span>
              </div>

              <div className="card-body">
                <div className="eyebrow">
                  SIDE A · {card.tracks.length} TRACKS · CUT{" "}
                  {new Date()
                    .toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "2-digit",
                    })
                    .toUpperCase()}
                </div>
                <h2 className="card-title" tabIndex={-1} ref={cardTitleRef}>
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

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                >
                  <SortableContext
                    items={card.tracks.map(sortableId)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="track-list">
                      {card.tracks.map((t, i) => (
                        <TrackRow
                          key={sortableId(t, i)}
                          id={sortableId(t, i)}
                          t={t}
                          index={i}
                          accentInk={accentInk}
                          editable={editable}
                          adjusting={adjusting}
                          href={
                            t.resolved && t.spotifyUrl ? t.spotifyUrl : spotifySearch(t)
                          }
                          justDragged={justDragged}
                          onSwap={() => swapTrack(i, t)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                <div className="card-footer">
                  <span>
                    {editable
                      ? "tap to open · drag to reorder · ↻ swaps a track"
                      : "tap a track to open it in Spotify"}
                  </span>
                  <span className="footer-brand">
                    <BrandText text={brand} /> · STEREO
                  </span>
                  <div className="barcode" aria-hidden />
                </div>
              </div>
            </div>

            {/* second chance: refine the card in place — only in the editable
                window, same gating as drag-to-reorder */}
            {editable && (
              <div className="refine-area">
                <div className="refine-row">
                  <input
                    ref={refineRef}
                    value={adjustText}
                    onChange={(e) => setAdjustText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        refine();
                      }
                    }}
                    placeholder="tweak it — less 80s, more instrumental…"
                    className="refine-input"
                    disabled={adjusting}
                    aria-label="Refine the mixtape"
                  />
                  <button
                    onClick={adjusting ? stopAdjusting : () => refine()}
                    className="btn-ghost refine-btn"
                  >
                    {adjusting ? "STOP" : "REFINE"}
                  </button>
                </div>
                {adjusting && (
                  /* same console-log aesthetic as generate — every line is a
                     real SSE event; the live region above narrates milestones */
                  <div className="progress-log refine-log" aria-hidden>
                    <div className="log-line">
                      rewinding the tape…
                      {adjustStage === "resolving" ? (
                        <span className="log-ok"> ok</span>
                      ) : (
                        cursor
                      )}
                    </div>
                    {adjustLog.map((l, i) => (
                      <div key={i} className="log-track">
                        <span className="log-arrow">→</span>{" "}
                        <span className="log-num">
                          {String(l.index + 1).padStart(2, "0")}
                        </span>{" "}
                        {l.artist} — {l.title}
                        {l.resolved === true && <span className="log-check"> ✓</span>}
                        {l.resolved === false && (
                          <span className="log-unverified"> unverified</span>
                        )}
                      </div>
                    ))}
                    {adjustStage === "resolving" && (
                      <div className="log-line">resolving on spotify…{cursor}</div>
                    )}
                  </div>
                )}
                {adjustError && (
                  <div className="error" role="alert">
                    {adjustError}
                  </div>
                )}
              </div>
            )}

            {/* save to spotify — primary action; everything else stays quiet */}
            {!playlistUrl && (
              <>
                <button
                  onClick={saveToSpotify}
                  disabled={saving || adjusting}
                  className="btn-press"
                  style={{ marginTop: 24 }}
                >
                  {saving
                    ? saveStage || "PRESSING TO WAX…"
                    : `PRESS ${cardVerified} OF ${card.tracks.length} TRACKS TO SPOTIFY`}
                </button>
                {cardUnverified > 0 && (
                  <div className="save-note">
                    {cardUnverified} unverified track
                    {cardUnverified === 1 ? "" : "s"} will be left off the
                    playlist
                  </div>
                )}
              </>
            )}
            {playlistUrl && (
              <a
                href={playlistUrl}
                target="_blank"
                rel="noreferrer"
                className="playlist-link"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  openInSpotify(playlistUrl);
                }}
              >
                pressed. open in Spotify ▸
              </a>
            )}
            {saveError && (
              <div className="error" role="alert">
                {saveError}
              </div>
            )}

            <button
              onClick={() => {
                setCard(null);
                setPlaylistUrl(null);
                setSaveError(null);
                setAdjustError(null);
                setAdjustText("");
                inputRef.current?.focus();
              }}
              // disabled while adjusting: the in-flight refine would land its
              // merged card right back on the cleared state
              disabled={adjusting}
              className="btn-ghost"
              style={{ marginTop: 20 }}
            >
              press another one
            </button>
          </div>
        )}
      </main>

      {/* dev-only wordmark switcher — the product name is undecided */}
      {import.meta.env.DEV && (
        <button
          className="brand-switcher"
          onClick={() => setBrandIdx((i) => (i + 1) % BRANDS.length)}
          title="cycle candidate wordmarks (dev only)"
        >
          wordmark {brandIdx + 1}/{BRANDS.length}
        </button>
      )}
    </div>
  );
}
