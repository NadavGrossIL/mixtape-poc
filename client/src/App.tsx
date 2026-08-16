import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { openInSpotify } from "./spotifyLink";

// The card/track shapes the server streams back. Unresolved tracks keep only
// the curator's fields; the Spotify fields land on successful resolution.
interface Track {
  artist: string;
  title: string;
  note: string;
  resolved: boolean;
  spotifyUri?: string | null;
  spotifyUrl?: string | null;
  albumArt?: string | null;
}

interface MixCard {
  title: string;
  vibe: string;
  accent: string;
  prompt?: string;
  seed?: { id?: string; name: string };
  tracks: Track[];
}

interface Playlist {
  id: string;
  name: string;
  total?: number | null;
}

// Progress-log line for the generate stream — written sparsely by index, so
// the array can have holes until every "track" event has landed.
interface LogTrack {
  artist: string;
  title: string;
  resolved?: boolean;
}

// Progress-log line for the refine stream.
interface AdjustLogLine {
  index: number;
  artist: string;
  title: string;
  resolved?: boolean;
}

// SSE payloads, per stream, as [event, data] tuples — a discriminated tuple
// union, so narrowing on the event name types the data in the callback.
// Events the client ignores ("seeded", "resolving") are listed for honesty.
type GenerateStreamEvent =
  | ["seeding", { name?: string } | null]
  | ["seeded", { count: number; total: number } | null]
  | ["curating", { prompt?: string } | null]
  | ["track", { index: number; artist: string; title: string }]
  | ["curated", { count: number; title: string } | null]
  | ["resolving", { index: number; artist: string; title: string } | null]
  | ["resolved", { index: number; resolved: boolean }]
  | ["done", { card?: MixCard; verified?: number } | null]
  | ["error", { message?: string } | null];

type AdjustStreamEvent =
  | ["adjusting", { adjustment?: string } | null]
  | ["change", { index: number; artist: string; title: string }]
  | ["adjusted", { count: number } | null]
  | ["resolving", { index: number; artist: string; title: string } | null]
  | ["resolved", { index: number; resolved: boolean }]
  | ["done", { card?: MixCard } | null]
  | ["error", { message?: string } | null];

type SaveStreamEvent =
  | ["creating", { name?: string } | null]
  | ["adding", { count?: number } | null]
  | ["done", { playlistUrl?: string } | null]
  | ["error", { message?: string } | null];

// Web Speech API — prefixed in Chrome/Safari, absent in Firefox.
// The mic button only renders when the browser can actually transcribe.
const SpeechRecognitionImpl =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

// Once a browser has stored a "deny" for the mic, recognition fails the
// instant it starts and no web page can reopen the permission prompt — the
// only way back is the browser's own site settings, which live somewhere
// different on every platform. Spell out the path for this one.
const MIC_UNBLOCK_STEPS = (() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad|iPod/.test(ua))
    return (
      "tap the ᴀA button in the address bar → Website Settings → " +
      "Microphone → Allow. Dictation itself must also be on: " +
      "iOS Settings → General → Keyboard → Enable Dictation."
    );
  if (/Android/.test(ua))
    return (
      "tap the icon left of the address bar → Permissions → " +
      "Microphone → Allow, then reload."
    );
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome/.test(ua))
    return (
      "open the Safari menu → Settings for This Website → " +
      "Microphone → Allow."
    );
  return (
    "click the icon left of the address bar → Site settings → " +
    "Microphone → Allow, then reload."
  );
})();

// Color tokens live in styles.css. This map is the per-mixtape accent,
// darkened per hue to hold ≥4.5:1 contrast as ink on the cream card.
// Record<string, string>: the accent name arrives from the server, and the
// lookup below already falls back to ember for anything unknown — including
// cards curated before the Clay Wall palette, whose accent names no longer exist.
// Keep these names in sync with the `accent` enums in server/curator.ts.
const ACCENT_INK: Record<string, string> = {
  ember: "#a83a0a",
  rose: "#a92e5c",
  plum: "#6a3a86",
  cobalt: "#2f5aa8",
  forest: "#237a4a",
  rust: "#7a5518",
};

// Each example demonstrates a different prompt axis: speed/skill,
// mood+moment, discovery/language, era+audience.
// Rotating input placeholders — one evocative prompt at a time beats a
// static example at selling what the box can do.
const PLACEHOLDERS = [
  "songs for driving at night through 1984…",
  "a mixtape for cooking with the windows open…",
  "the sound of a beach town in the off-season…",
  "b-sides for a long train ride north…",
  "what my record-store clerk crush would play…",
];

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
// E is the caller's [event, data] tuple union for the stream being read — a
// declared contract, not something the wire can prove.
async function readSSE<E extends [string, unknown]>(
  response: Response,
  onEvent: (...args: E) => void
) {
  // these endpoints always stream a body; a bodyless response would have
  // thrown here before the migration too
  const reader = response.body!.getReader();
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
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        /* keep null */
      }
      // the one cast at the wire boundary: the server's events are trusted to
      // match the caller's declared union (unknown events fall through the
      // caller's if/else chains unhandled, exactly as before)
      onEvent(...([event, parsed] as E));
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

const TAPE_SPILL =
  "M140 120 C118 138 88 146 76 136 C66 127 80 118 90 127 " +
  "C100 136 118 150 152 152 C196 154 224 144 262 152 C270 153.5 276 156 278 158";

// Empty-state hero: an idle deck mid-play — spoked reels turning at
// different speeds (the take-up pack is smaller, so it spins faster) and
// tape spilling out into a slow shimmer. Pure decoration, aria-hidden;
// all motion lives in CSS behind the reduced-motion gate.
function DeckHero() {
  return (
    <div className="deck-hero" aria-hidden="true">
      <svg
        className="deck"
        viewBox="0 0 280 172"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="40" y="14" width="200" height="104" rx="8" />
        <rect
          x="64"
          y="28"
          width="152"
          height="48"
          rx="4"
          strokeWidth="1.5"
          className="deck-line"
        />
        {/* screws */}
        <g className="deck-line" strokeWidth="1.5">
          <circle cx="50" cy="24" r="2" />
          <circle cx="230" cy="24" r="2" />
          <circle cx="50" cy="108" r="2" />
          <circle cx="230" cy="108" r="2" />
        </g>
        {/* supply reel: fat tape pack, spoked hub */}
        <circle cx="104" cy="52" r="17" strokeWidth="2" className="deck-accent" />
        <g className="deck-reel deck-reel-supply">
          <circle cx="104" cy="52" r="8" />
          <path
            strokeWidth="1.5"
            d="M104 45v14M97.9 48.5l12.2 7M97.9 55.5l12.2-7"
          />
        </g>
        {/* take-up reel: thin pack */}
        <circle cx="176" cy="52" r="11" strokeWidth="2" className="deck-accent" />
        <g className="deck-reel deck-reel-takeup">
          <circle cx="176" cy="52" r="8" />
          <path
            strokeWidth="1.5"
            d="M176 45v14M169.9 48.5l12.2 7M169.9 55.5l12.2-7"
          />
        </g>
        {/* tape running pack-top to pack-top */}
        <path d="M104 35 L176 41" strokeWidth="2" className="deck-accent" />
        <text x="140" y="96" textAnchor="middle" className="deck-label">
          MIXTAPE — SIDE A
        </text>
        {/* bottom notch + capstan holes */}
        <path d="M96 118l6-12h76l6 12" />
        <g className="deck-line" strokeWidth="1.5">
          <circle cx="112" cy="112" r="2.5" />
          <circle cx="168" cy="112" r="2.5" />
        </g>
        {/* spilled tape: solid run + a brighter dash sliding along it */}
        <path className="deck-tape" d={TAPE_SPILL} />
        <path className="deck-tape-flow" d={TAPE_SPILL} />
      </svg>
    </div>
  );
}

function BrandText({ text }: { text: string }) {
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
const trackId = (t: Track) => t.spotifyUri || `${t.artist}—${t.title}`;

// Sortable/key id, made unique by position. Computed from the card's current
// order at render time — dnd-kit snapshots items at drag start, so ids stay
// stable for the duration of a drag, and the positional suffix makes the
// drag-end indexOf lookup exact even with duplicate tracks.
const sortableId = (t: Track, i: number) => `${trackId(t)}#${i}`;

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

function TrackRow({ id, t, index, accentInk, editable, adjusting, href, justDragged, onSwap }: TrackRowProps) {
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
  const [card, setCard] = useState<MixCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null); // null = checking
  const [brandIdx, setBrandIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // real progress, driven only by SSE events from the backend
  const [stage, setStage] = useState<"seeding" | "curating" | "resolving" | null>(null);
  const [logTracks, setLogTracks] = useState<(LogTrack | undefined)[]>([]); // sparse until every "track" lands
  const [seedLog, setSeedLog] = useState<{ name: string } | null>(null); // while seeding this run
  // "in the spirit of" seed picker
  const [playlists, setPlaylists] = useState<
    Playlist[] | "unauthorized" | "error" | null
  >(null); // null=loading
  const [seedId, setSeedId] = useState("");
  const [saveStage, setSaveStage] = useState<string | null>(null); // "creating" | "adding N"
  const [inputHint, setInputHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(""); // screen-reader milestones
  // second-chance refine — same real-SSE discipline as generate
  const [adjustText, setAdjustText] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustStage, setAdjustStage] = useState<"adjusting" | "resolving" | null>(null);
  const [adjustLog, setAdjustLog] = useState<AdjustLogLine[]>([]);

  // voice input — dictation appends to whatever is already typed
  const [listening, setListening] = useState(false);
  const recogRef = useRef<SpeechRecognition | null>(null);
  const dictatingRef = useRef(false); // user intent: mic toggled on
  const dictationBaseRef = useRef(""); // text that precedes this session's speech
  const dictatedRef = useRef(""); // latest composed text, for restart folding

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const refineRef = useRef<HTMLInputElement | null>(null);
  const cardTitleRef = useRef<HTMLHeadingElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const adjustAbortRef = useRef<AbortController | null>(null);

  // drag-to-reorder: the whole row is the drag surface. Mouse drags activate
  // after 8px (a click still opens Spotify); touch needs a 250ms hold so a
  // finger can still scroll the list — moving during the hold cancels the drag.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } })
  );
  const justDragged = useRef(false);

  const brand = BRANDS[brandIdx];

  // cycle the empty-input placeholder; hold still for reduced-motion users
  const [phIndex, setPhIndex] = useState(0);
  useEffect(() => {
    if (card || loading) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(
      () => setPhIndex((i) => (i + 1) % PLACEHOLDERS.length),
      3500
    );
    return () => clearInterval(t);
  }, [card, loading]);

  useEffect(() => {
    fetch("/auth/status")
      .then((r) => r.json())
      .then((d: { loggedIn?: boolean }) => setLoggedIn(Boolean(d.loggedIn)))
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
        const d: { playlists?: Playlist[] } = await r.json();
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

  // a page-leave mid-dictation must not leave the mic hot
  useEffect(
    () => () => {
      dictatingRef.current = false;
      recogRef.current?.abort();
    },
    []
  );

  // The engine ends a session on its own — after a pause in speech, or at
  // Chrome's session-length cap. dictatingRef holds the user's intent
  // ("the mic button is on"), so onend can tell an engine timeout apart
  // from a deliberate stop and reopen the mic mid-take.
  const startRecognition = () => {
    // non-null: only reachable through the mic button, which renders (and
    // wires these handlers) only when SpeechRecognitionImpl exists
    const recog = new SpeechRecognitionImpl!();
    // one language per session is a Web Speech limitation; the browser's
    // own locale is the best single guess we have
    recog.lang = navigator.language || "en-US";
    recog.interimResults = true; // words land in the box as they're spoken
    recog.continuous = true; // a pause for thought must not end the take
    recog.onresult = (e) => {
      const heard = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join("");
      const composed = dictationBaseRef.current + heard;
      dictatedRef.current = composed;
      setPrompt(composed);
      setInputHint(null);
    };
    recog.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        dictatingRef.current = false;
        setInputHint(`The mic is blocked for this site — ${MIC_UNBLOCK_STEPS}`);
      } else if (e.error !== "aborted" && e.error !== "no-speech") {
        // real failure (network, audio-capture) — don't restart-loop on it
        dictatingRef.current = false;
        setInputHint("Couldn’t catch that — try again, or just type.");
      }
    };
    recog.onend = () => {
      if (dictatingRef.current) {
        // engine gave up but the user never tapped stop — resume the take,
        // folding what's already transcribed into the new session's base
        dictationBaseRef.current = dictatedRef.current.trim()
          ? dictatedRef.current.replace(/\s+$/, "") + " "
          : "";
        startRecognition();
        return;
      }
      recogRef.current = null;
      setListening(false);
      inputRef.current?.focus();
    };
    recogRef.current = recog;
    recog.start();
  };

  const stopDictation = () => {
    dictatingRef.current = false;
    recogRef.current?.stop();
  };

  const startDictation = () => {
    dictatingRef.current = true;
    dictationBaseRef.current = prompt.trim()
      ? prompt.replace(/\s+$/, "") + " "
      : "";
    dictatedRef.current = prompt;
    setListening(true);
    setAnnounce("Listening. Speak your prompt.");
    startRecognition();
  };

  // WhatsApp-style push-to-talk: hold the mic to record, let go to stop.
  // A quick tap (released before the hold threshold) "locks" the mic on
  // instead — hands-free for long prompts — and the next tap stops it.
  const HOLD_MS = 400;
  const holdStartRef = useRef(0);

  const micPress = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // capture the pointer so the release fires here even if the finger
    // drifts off the button mid-hold
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    if (recogRef.current) {
      stopDictation(); // mic was locked on by a quick tap — this tap ends it
      holdStartRef.current = 0;
      return;
    }
    holdStartRef.current = e.timeStamp;
    startDictation();
  };

  const micRelease = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!recogRef.current || !holdStartRef.current) return;
    if (e.timeStamp - holdStartRef.current < HOLD_MS) return; // quick tap: lock on
    stopDictation();
  };

  // keyboard can't hold-to-talk; Enter/Space toggles (a keyboard-sourced
  // click has detail 0, pointer clicks were already handled above)
  const micKeyToggle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return;
    if (recogRef.current) stopDictation();
    else startDictation();
  };

  const generate = async (p?: string) => {
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
    stopDictation(); // pressing it while dictating ends the take
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
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(data.error || "generate failed");
      }
      // widened initializers: the assignments happen inside the readSSE
      // callback, which TS's control-flow analysis can't see
      let doneCard = null as MixCard | null;
      let streamError = null as string | null;
      await readSSE<GenerateStreamEvent>(response, (event, data) => {
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
            const cur = next[data.index]; // local so TS narrows the sparse slot
            if (cur) {
              next[data.index] = { ...cur, resolved: data.resolved };
            }
            return next;
          });
        } else if (event === "done") {
          doneCard = data?.card ?? null;
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
      if (e instanceof Error && e.name === "AbortError") {
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
  const refine = async (instruction?: string) => {
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
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(data.error || "adjust failed");
      }
      // widened initializers, same reason as in generate
      let doneCard = null as MixCard | null;
      let streamError = null as string | null;
      await readSSE<AdjustStreamEvent>(response, (event, data) => {
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
          doneCard = data?.card ?? null;
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
      if (e instanceof Error && e.name === "AbortError") {
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
  const swapTrack = (i: number, t: Track) =>
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
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw new Error(data.error || "save failed");
      }
      // widened initializers, same reason as in generate
      let url = null as string | null;
      let streamError = null as string | null;
      await readSSE<SaveStreamEvent>(response, (event, data) => {
        if (event === "creating") setSaveStage("CREATING PLAYLIST…");
        else if (event === "adding") setSaveStage(`ADDING ${data?.count} TRACKS…`);
        else if (event === "done") url = data?.playlistUrl ?? null;
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
    ? ACCENT_INK[card.accent] || ACCENT_INK.ember
    : ACCENT_INK.ember;

  const liveVerified = logTracks.filter((t) => t && t.resolved === true).length;
  const cardVerified = card ? card.tracks.filter((t) => t.resolved).length : 0;
  const cardUnverified = card ? card.tracks.length - cardVerified : 0;
  const cursor = (
    <span className="cursor" aria-hidden>
      ▮
    </span>
  );

  const spotifySearch = (t: Track) =>
    `https://open.spotify.com/search/${encodeURIComponent(t.artist + " " + t.title)}`;

  // reorder is a pure client-side edit; the save flow reads card.tracks in
  // order, so the pressed playlist follows whatever order is on the card
  const editable = Boolean(card) && !playlistUrl && !saving;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // the click that follows a drop must not open the track
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    if (over && active.id !== over.id) {
      setCard((c) => {
        if (!c) return c; // unreachable: a drag can only start on a rendered card
        const ids = c.tracks.map(sortableId);
        return {
          ...c,
          // dnd-kit's UniqueIdentifier is string | number; ours are always the
          // sortableId strings handed to SortableContext above
          tracks: arrayMove(
            c.tracks,
            ids.indexOf(active.id as string),
            ids.indexOf(over.id as string)
          ),
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
          <>
            <a href="/auth/login" className="btn-press">
              CONNECT SPOTIFY
            </a>
            <DeckHero />
          </>
        )}

        {loggedIn === true && (
          <>
            {/* input */}
            <div className="input-row">
              <div
                className={
                  "prompt-wrap" + (SpeechRecognitionImpl ? " has-mic" : "")
                }
              >
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
                  placeholder={PLACEHOLDERS[phIndex]}
                  rows={2}
                  className="prompt-input"
                  aria-label="Playlist prompt"
                />
                {SpeechRecognitionImpl && (
                  <button
                    type="button"
                    onPointerDown={micPress}
                    onPointerUp={micRelease}
                    onPointerCancel={micRelease}
                    onClick={micKeyToggle}
                    onContextMenu={(e) => e.preventDefault()}
                    className={"mic-btn" + (listening ? " mic-live" : "")}
                    aria-pressed={listening}
                    aria-label={
                      listening
                        ? "Stop voice input"
                        : "Hold to talk, or tap to keep the mic on"
                    }
                    title={
                      listening
                        ? "Stop voice input"
                        : "Hold to talk · tap to keep the mic on"
                    }
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <rect
                        x="9"
                        y="2"
                        width="6"
                        height="12"
                        rx="3"
                        fill="currentColor"
                        stroke="none"
                      />
                      <path d="M5 11a7 7 0 0 0 14 0" />
                      <line x1="12" y1="18" x2="12" y2="22" />
                    </svg>
                  </button>
                )}
              </div>
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

            {/* what the box does — reads as the input's help text */}
            {!card && !loading && (
              <div className="scope-line">
                describe a vibe, moment, or era — you get 8 real tracks with
                liner notes
              </div>
            )}

            {/* example chips: populate the prompt, stay editable */}
            {!card && !loading && (
              <div className="examples">
                <div className="section-note">or start from an example</div>
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
              </div>
            )}

            {/* "in the spirit of" seed picker — optional; with a playlist
                picked, the prompt may stay empty */}
            {!card && !loading && (
              <div className="seed-row">
                <label htmlFor="seed-select" className="section-note">
                  or make one in the spirit of your playlists
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

            {!card && !loading && <DeckHero />}
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
