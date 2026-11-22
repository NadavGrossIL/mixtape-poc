import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { isHandingOff } from "./spotifyLink";
import { shareOrCopy } from "./share";
import { loadRecent, recordRecent, type RecentMixtape } from "./recent";
import { parseLatestResponse, type LatestMixtape } from "./latest";
import LogConsole from "./LogConsole";
import {
  type AdjustLogLine,
  type AdjustStreamEvent,
  type GenerateStreamEvent,
  type LogTrack,
  type MixCard,
  type Playlist,
  type SaveStreamEvent,
  type Track,
} from "./types";
import { CapError, StreamDroppedError, readSSE } from "./sse";
import { saveRefusal } from "./failures";
import { parsePlaylistLink, seedPlaylistFor, visibleSeedPlaylists, type SeedPlaylists } from "./seed";
import { reorderTracks, trackListText, verifiedCount } from "./card";
import {
  classifyRunFailure,
  noStreamErrors,
  noteStreamError,
  responseFailure,
  streamFailure,
} from "./runFailure";
import SampleCard from "./components/SampleCard";
import SiteHeader from "./components/SiteHeader";
import Composer from "./components/Composer";
import RecentMixtapes from "./components/RecentMixtapes";
import LatestShelf from "./components/LatestShelf";
import ExamplePrompts from "./components/ExamplePrompts";
import HomeNotes from "./components/HomeNotes";
import GeneratingProgress, { type Stage } from "./components/GeneratingProgress";
import ErrorAlert from "./components/ErrorAlert";
import MixtapeCard from "./components/MixtapeCard";
import RefinePanel from "./components/RefinePanel";
import SaveDock from "./components/SaveDock";
import PressedPanel from "./components/PressedPanel";

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

// The server-log console is a learning-project debugging aid, not product UI.
//
// `?debug` has to outlive the OAuth round trip: /callback redirects to
// CLIENT_URL ("/" in production) and drops the query string, so connecting
// Spotify — the very thing the owner must do before the logs and funnel will
// answer them — used to take the button away again. Remembered for the tab,
// not the browser: a stray ?debug in a shared link shouldn't leave a debug
// control on a stranger's screen for good.
const DEBUG_KEY = "mixtape_debug";

function debugRequested(): boolean {
  if (typeof window === "undefined") return false;
  const inUrl = new URLSearchParams(window.location.search).has("debug");
  try {
    if (inUrl) window.sessionStorage.setItem(DEBUG_KEY, "1");
    return inUrl || window.sessionStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return inUrl; // private mode or storage blocked — the URL still works
  }
}

const SHOW_LOGS = import.meta.env.DEV || debugRequested();

// see the /api/view effect below — survives a hot-reload remount
let viewCounted = false;

// a getter, not a value: in some browsers reading `window.localStorage`
// itself throws (blocked storage); recent.ts catches that as well
const browserStorage = () => window.localStorage;

// Scroll something that just mounted into view and move focus onto it, so
// eye and screen reader land in the same place. Smooth unless the visitor
// asked for less motion; focus without a second, instant scroll.
function bringIntoView(scrollTo: HTMLElement, focusOn: HTMLElement = scrollTo) {
  const reduce =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scrollTo.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  focusOn.focus({ preventScroll: true });
}

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [card, setCard] = useState<MixCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server's own words for what went wrong, shown under the friendly
  // line — the log panel has the rest of the run.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [booked, setBooked] = useState(false); // the error is a cap, not a fault
  // bumps on every failure so the alert is scrolled into view even when the
  // same line lands twice in a row (a capped visitor pressing again)
  const [errorTick, setErrorTick] = useState(0);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null); // null = checking
  const [isOwner, setIsOwner] = useState(false); // shows the shelf's "hide"; the server enforces it
  const [saving, setSaving] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [savedToLibrary, setSavedToLibrary] = useState(false);
  const [copied, setCopied] = useState<"tracks" | "share" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBooked, setSaveBooked] = useState(false); // same cap-not-fault split as `booked`
  const [saveErrorTick, setSaveErrorTick] = useState(0); // same job as errorTick
  // "your mixtapes": this browser's presses, newest first (see recent.ts)
  const [recent, setRecent] = useState<RecentMixtape[]>(() => loadRecent(browserStorage));
  const [showAllRecent, setShowAllRecent] = useState(false);
  // "fresh off the press": everyone's newest presses (server/latest.ts)
  const [latest, setLatest] = useState<LatestMixtape[]>([]);
  // real progress, driven only by SSE events from the backend
  const [stage, setStage] = useState<Stage>(null);
  const [logTracks, setLogTracks] = useState<(LogTrack | undefined)[]>([]); // sparse until every "track" lands
  const [seedLog, setSeedLog] = useState<{ name: string } | null>(null); // while seeding this run
  // "in the spirit of" seed picker
  const [playlists, setPlaylists] = useState<SeedPlaylists>(null); // null=loading
  const [seedId, setSeedId] = useState("");
  const [seedOpen, setSeedOpen] = useState(false); // the inline picker panel
  const [seedFilter, setSeedFilter] = useState("");
  // a seed that arrived as a pasted link — visitors without a connected
  // Spotify have no shelf to pick from, so they paste a playlist link
  // instead; the server reads it with the host account and names it
  const [pastedSeed, setPastedSeed] = useState<Playlist | null>(null);
  const [seedPaste, setSeedPaste] = useState("");
  const [saveStage, setSaveStage] = useState<string | null>(null); // "creating" | "adding N"
  const [inputHint, setInputHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(""); // screen-reader milestones
  // second-chance refine — same real-SSE discipline as generate
  const [adjustText, setAdjustText] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustErrorDetail, setAdjustErrorDetail] = useState<string | null>(null);
  const [adjustBooked, setAdjustBooked] = useState(false); // same cap-not-fault split as `booked`
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
  const errorRef = useRef<HTMLDivElement | null>(null);
  const saveErrorRef = useRef<HTMLDivElement | null>(null);
  const pressedRef = useRef<HTMLDivElement | null>(null);
  const pressedOpenRef = useRef<HTMLAnchorElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const adjustAbortRef = useRef<AbortController | null>(null);

  // The error renders inside the composer, but a phone that scrolled down to
  // the progress log is still looking below it — the button just snapped
  // from STOP back to MAKE THE MIXTAPE and looked like it did nothing. Pull
  // the alert into view and focus it, so eye and screen reader both land on
  // it. An effect, not a rAF in the catch: it runs after the commit that
  // mounts the element, whichever way React schedules that.
  useEffect(() => {
    const el = errorRef.current;
    if (!errorTick || !el) return;
    bringIntoView(el);
  }, [errorTick]);

  // A save that worked unmounts the sticky save button and mounts the
  // OPEN IN SPOTIFY block in the page's flow, under the card — on a phone,
  // below the fold, so the button just vanished and nothing said it worked.
  // Bring the block up and put focus on its one action. playlistUrl only
  // ever turns non-null in saveToSpotify, so this is "a save just landed".
  useEffect(() => {
    if (playlistUrl && pressedRef.current && pressedOpenRef.current) {
      bringIntoView(pressedRef.current, pressedOpenRef.current);
    }
  }, [playlistUrl]);

  // A failed save renders its line under the save notes, which a phone
  // scrolled up to the sticky button can't see — same fix as errorTick.
  useEffect(() => {
    const el = saveErrorRef.current;
    if (!saveErrorTick || !el) return;
    bringIntoView(el);
  }, [saveErrorTick]);

  useEffect(() => {
    fetch("/auth/status")
      .then((r) => r.json())
      .then((d: { loggedIn?: boolean; owner?: boolean }) => {
        setLoggedIn(Boolean(d.loggedIn));
        setIsOwner(Boolean(d.owner));
      })
      .catch(() => setLoggedIn(false));
  }, []);

  // The shelf is a nice-to-have: any failure just leaves it off the page.
  // Re-read after this visitor's own press, so the list is current when
  // they come back to the composer.
  const loadLatest = () => {
    fetch("/api/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLatest(parseLatestResponse(d)))
      .catch(() => {});
  };
  useEffect(loadLatest, []);

  // owner only, and not undoable from here — so it asks first
  const hideLatest = (id: string, title: string) => {
    if (!window.confirm(`Hide “${title}” from the home page? The playlist itself stays.`)) return;
    fetch("/api/latest/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`hide failed: ${r.status}`);
        return r.json();
      })
      .then((d) => setLatest(parseLatestResponse(d)))
      .catch((e) => window.alert(`Couldn't hide it (${e.message}).`));
  };

  // A card is a draft until it's saved: it lives only in this tab. On
  // 2026-11-22 a refined card was lost to a reload 20 minutes later, its
  // maker sure they'd "created a playlist" — prod's request log had no save
  // at all. So leaving with an unsaved card asks first (the browser's own
  // "Leave site?" prompt; its wording can't be set).
  const unsavedCard = Boolean(card) && !playlistUrl;
  useEffect(() => {
    if (!unsavedCard) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (isHandingOff()) return; // a song opening in the Spotify app, not leaving
      e.preventDefault();
      e.returnValue = ""; // older Chrome/Safari need it set to show the prompt
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsavedCard]);

  // One page-view tick per load, counted server-side (server/metrics.ts).
  // The module-level guard, not the empty dep array, is what makes it once:
  // a dev hot-reload remounts the app without reloading the page.
  useEffect(() => {
    if (viewCounted) return;
    viewCounted = true;
    fetch("/api/view", { method: "POST", keepalive: true }).catch(() => {});
  }, []);

  // the seed picker's playlist list. 403 = the stored token predates the
  // playlist-read scopes — surfaced as a "reconnect Spotify" link. A named
  // function (not just an effect) so the error state can offer a retry.
  const loadPlaylists = () => {
    setPlaylists(null);
    fetch("/api/playlists")
      .then(async (r) => {
        if (r.status === 403) return setPlaylists("unauthorized");
        if (!r.ok) throw new Error("playlists failed");
        const d: { playlists?: Playlist[] } = await r.json();
        setPlaylists(Array.isArray(d.playlists) ? d.playlists : []);
      })
      .catch(() => setPlaylists("error"));
  };
  useEffect(() => {
    if (loggedIn === true) loadPlaylists();
  }, [loggedIn]);

  // Move focus to the result when it lands, so keyboard and
  // screen-reader users aren't stranded back at the prompt. Only when a card
  // arrives where there was none: a reorder, a swap or a refine is a new
  // card object too, and focusing the title on those jumped the page away
  // from the row the visitor was working on.
  const hadCardRef = useRef(false);
  useEffect(() => {
    if (card && !hadCardRef.current) cardTitleRef.current?.focus();
    hadCardRef.current = Boolean(card);
  }, [card]);

  const seedPlaylist = seedPlaylistFor(playlists, seedId, pastedSeed);

  // the picker's rows (seed.ts)
  const seedShown = visibleSeedPlaylists(playlists, seedFilter);

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
        "Type a vibe first — a mood, a moment, an era — or start from a playlist."
      );
      inputRef.current?.focus();
      return;
    }
    stopDictation(); // pressing it while dictating ends the take
    setLoading(true);
    setError(null);
    setErrorDetail(null);
    setBooked(false);
    setCard(null);
    setPlaylistUrl(null);
    setSavedToLibrary(false);
    setCopied(null);
    setSaveError(null);
    setAdjustError(null);
    setAdjustErrorDetail(null);
    setAdjustText("");
    setStage(null);
    setLogTracks([]);
    setSeedLog(null);
    setAnnounce("Making your mixtape.");
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
        throw responseFailure(response.status, data, "generate failed");
      }
      // widened initializer: the assignment happens inside the readSSE
      // callback, which TS's control-flow analysis can't see
      let doneCard = null as MixCard | null;
      const streamErrors = noStreamErrors();
      await readSSE<GenerateStreamEvent>(response, (event, data) => {
        if (event === "seeding") {
          setStage("seeding");
          setSeedLog({ name: data?.name || "your playlist" });
          // a pasted seed learns its real name from the server
          if (data?.name) {
            setPastedSeed((s) => (s ? { ...s, name: data.name! } : s));
          }
          setAnnounce("Reading your playlist.");
        } else if (event === "curating") {
          setStage("curating");
          setAnnounce("Picking the songs.");
        } else if (event === "track") {
          setLogTracks((ts) => {
            const next = [...ts];
            next[data.index] = { artist: data.artist, title: data.title };
            return next;
          });
        } else if (event === "curated") {
          setStage("resolving");
          setAnnounce("Checking each song on Spotify.");
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
          noteStreamError(streamErrors, data, "generate failed");
        }
      });
      const streamError = streamFailure(streamErrors);
      if (streamError) throw streamError;
      if (!doneCard?.tracks?.length) throw new StreamDroppedError();
      const verified = verifiedCount(doneCard.tracks);
      setAnnounce(
        `Mixtape ready: ${doneCard.tracks.length} tracks, ${verified} verified on Spotify.`
      );
      setCard(doneCard);
      // The card records the seed (card.seed, printed on the sleeve); the
      // armed seed must not silently ride along into the next generation.
      // A failed run keeps it, so "try the same prompt again" stays true.
      setSeedId("");
      // a pasted seed too: seedPlaylist falls back to it once seedId is empty
      setPastedSeed(null);
      setSeedOpen(false);
    } catch (e) {
      const failure = classifyRunFailure(e, navigator.onLine);
      switch (failure.kind) {
        case "aborted":
          setAnnounce("Stopped.");
          break;
        case "cap":
          setBooked(true);
          setError(failure.error.message);
          setErrorDetail(failure.error.detail);
          setAnnounce(failure.error.message);
          setErrorTick((t) => t + 1);
          break;
        case "offline":
          // the visitor's connection, not the curator: no "that's on us", and
          // no detail line — the browser's "Failed to fetch" helps nobody
          setError("you look offline — check your connection and try the same prompt again.");
          setErrorTick((t) => t + 1);
          break;
        case "dropped":
          setError("the connection dropped mid-run — try the same prompt again.");
          setErrorTick((t) => t + 1);
          break;
        case "plain":
          setError(failure.error.message);
          setErrorDetail(failure.error.detail);
          setAnnounce(failure.error.message);
          setErrorTick((t) => t + 1);
          break;
        case "fault":
          console.error(e);
          setError("The curator dropped the needle — that’s on us. Try the same prompt again.");
          setErrorDetail(e instanceof Error ? e.message : String(e));
          setErrorTick((t) => t + 1);
          break;
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
    setAdjustErrorDetail(null);
    setAdjustBooked(false);
    setAdjustStage(null);
    setAdjustLog([]);
    setAnnounce("Changing the mixtape.");
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
        throw responseFailure(response.status, data, "adjust failed");
      }
      // widened initializer, same reason as in generate
      let doneCard = null as MixCard | null;
      const streamErrors = noStreamErrors();
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
          setAnnounce("Checking the new songs on Spotify.");
        } else if (event === "resolved") {
          setAdjustLog((ls) =>
            ls.map((l) =>
              l.index === data.index ? { ...l, resolved: data.resolved } : l
            )
          );
        } else if (event === "done") {
          doneCard = data?.card ?? null;
        } else if (event === "error") {
          noteStreamError(streamErrors, data, "adjust failed");
        }
      });
      const streamError = streamFailure(streamErrors);
      if (streamError) throw streamError;
      if (!doneCard?.tracks?.length) throw new StreamDroppedError();
      setAnnounce(
        `Mixtape adjusted: ${changeCount} track${changeCount === 1 ? "" : "s"} changed.`
      );
      setCard(doneCard);
      setAdjustText("");
    } catch (e) {
      const failure = classifyRunFailure(e, navigator.onLine);
      switch (failure.kind) {
        case "aborted":
          setAnnounce("Stopped.");
          break;
        case "cap":
          setAdjustBooked(true);
          setAdjustError(failure.error.message);
          setAdjustErrorDetail(failure.error.detail);
          setAnnounce(failure.error.message);
          break;
        case "offline":
          // same split as in generate
          setAdjustError("you look offline — check your connection and try it again.");
          break;
        case "dropped":
          setAdjustError("the connection dropped — try it again.");
          break;
        case "plain":
          setAdjustError(failure.error.message);
          setAdjustErrorDetail(failure.error.detail);
          break;
        case "fault":
          console.error(e);
          setAdjustError("Couldn't make that change. Try rewording it.");
          setAdjustErrorDetail(e instanceof Error ? e.message : String(e));
          break;
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
      setSaveError("No verified songs to save.");
      setSaveBooked(false);
      setSaveErrorTick((t) => t + 1);
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
        // the vibe line becomes the playlist description; the prompt stays
        // off on purpose: it lands on a public profile, and a prompt can be
        // more personal than intended
        body: JSON.stringify({ title: card.title, vibe: card.vibe, uris }),
      });
      if (!response.ok) {
        const data: { error?: string } = await response.json().catch(() => ({}));
        const refusal = saveRefusal(response.status, data.error);
        if (refusal) throw new CapError(refusal);
        throw new Error(data.error || "save failed");
      }
      // widened initializers, same reason as in generate
      let url = null as string | null;
      let saved = false;
      let streamError = null as string | null;
      await readSSE<SaveStreamEvent>(response, (event, data) => {
        if (event === "creating") setSaveStage("CREATING PLAYLIST…");
        else if (event === "adding") setSaveStage(`ADDING ${data?.count} SONGS…`);
        else if (event === "done") {
          url = data?.playlistUrl ?? null;
          saved = Boolean(data?.saved);
        } else if (event === "error") streamError = data?.message || "save failed";
      });
      if (streamError) {
        const refusal = saveRefusal(null, streamError);
        if (refusal) throw new CapError(refusal);
        throw new Error(streamError);
      }
      if (!url) throw new Error("no playlist url");
      setAnnounce(
        saved
          ? "Saved. The playlist is in your Spotify library."
          : "Your playlist is ready. Open it in Spotify and tap plus to add it to your library."
      );
      setPlaylistUrl(url);
      setSavedToLibrary(saved);
      // remembered here so a guest who didn't tap + can find it again
      setRecent(
        recordRecent(browserStorage, recent, { title: card.title, url, pressedAt: Date.now() })
      );
      loadLatest();
    } catch (e) {
      // a cap (today's saves, Spotify's daily quota) is the server's own
      // line: "try again" is wrong advice until tomorrow. Anything else is a
      // fault, and its text is for the log, not the visitor (failures.ts).
      if (e instanceof CapError) {
        setSaveError(e.message);
        setSaveBooked(true);
        setAnnounce(e.message);
      } else {
        console.error(e);
        setSaveError("Couldn't save it to Spotify. Try again.");
        setSaveBooked(false);
      }
      setSaveErrorTick((t) => t + 1);
    } finally {
      setSaving(false);
      setSaveStage(null);
    }
  };


  // checked, not confirmed: a run with two songs Spotify couldn't find must
  // still end on "8 of 8", or the last thing on screen reads as stuck
  const liveChecked = logTracks.filter((t) => t && t.resolved !== undefined).length;
  // The waiting screen's step line. A run from a playlist has one more step
  // (reading it) than a run from a prompt; the armed seed is still set while
  // loading, so the total is known before the first event arrives.
  const stepTotal = seedPlaylist ? 3 : 2;
  const loadingStep =
    stage === "resolving"
      ? {
          n: stepTotal,
          label: `checking each one on Spotify · ${liveChecked} of ${logTracks.length}`,
        }
      : stage === "curating" || !seedPlaylist
        ? { n: stepTotal - 1, label: "picking the songs" }
        : {
            n: 1,
            label: `reading “${seedLog?.name || seedPlaylist.name || "your playlist"}”`,
          };

  // Clipboard feedback is the button's own label for a beat, not a toast.
  const copyText = async (text: string, what: "tracks") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setAnnounce("Song list copied.");
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
    } catch {
      setAnnounce("Couldn't copy — select it by hand.");
    }
  };

  // Native share sheet where there is one; otherwise the same clipboard path
  // "copy link" uses. The decision (and the "dismissed is not a copy" rule)
  // lives in share.ts so it is unit-tested; this is only the DOM edge.
  const shareMixtape = async () => {
    if (!playlistUrl || !card) return;
    const outcome = await shareOrCopy(
      { title: card.title, url: playlistUrl },
      {
        share: navigator.share ? navigator.share.bind(navigator) : undefined,
        copy: (t) => navigator.clipboard.writeText(t),
      },
    );
    if (outcome === "copied") {
      setCopied("share");
      setAnnounce("Link copied.");
      setTimeout(() => setCopied((c) => (c === "share" ? null : c)), 1800);
    } else if (outcome === "failed") {
      setAnnounce("Couldn't copy — select it by hand.");
    }
    // "shared" / "dismissed": the sheet was the feedback — nothing to report
  };

  // arm a pasted playlist link as the seed; the server names it while seeding
  const applyPastedSeed = () => {
    const id = parsePlaylistLink(seedPaste);
    if (!id) {
      setInputHint("That doesn't look like a Spotify playlist link — copy it from Share → Copy link in Spotify.");
      return;
    }
    setPastedSeed({ id, name: "", total: null, mine: false });
    setSeedPaste("");
    setSeedOpen(false);
    setInputHint(null);
    setAnnounce("Using your pasted playlist. The prompt is now optional.");
    inputRef.current?.focus();
  };

  // reorder is a pure client-side edit; the save flow reads card.tracks in
  // order, so the pressed playlist follows whatever order is on the card
  const editable = Boolean(card) && !playlistUrl && !saving;

  // the card with a dragged row dropped somewhere else (TrackList's ids)
  const reorderCard = (activeId: string, overId: string) =>
    setCard((c) => {
      if (!c) return c; // unreachable: a drag can only start on a rendered card
      return reorderTracks(c, activeId, overId);
    });

  return (
    <div className="app">
      {/* screen-reader milestones: one line per stage, never per token */}
      <div className="vh" role="status" aria-live="polite">
        {announce}
      </div>

      <SiteHeader compact={Boolean(card)} />

      <main className="main-col">
        {loggedIn === null && <div className="checking">checking the deck…</div>}

        {/* no login gate: anyone past the door can make a mixtape. A
            connected Spotify (the allowlisted few) only adds the shelf picker
            and the 0-tap save; everyone else keeps the playlist with one
            tap in Spotify. */}
        {loggedIn !== null && !card && (
          <>
            {/* the composer card — one bounded surface for everything that
                composes the request: docked seed token, prompt, seed trigger,
                submit. While a card is on the table this whole section
                unmounts: one live text input on screen, ever. */}
            <Composer
              prompt={prompt}
              onPromptChange={(value) => {
                setPrompt(value);
                if (inputHint) setInputHint(null);
              }}
              onSubmit={() => generate()}
              onStop={stopGenerating}
              loading={loading}
              seed={seedPlaylist}
              onClearSeed={() => {
                setSeedId("");
                setPastedSeed(null);
                inputRef.current?.focus();
              }}
              showSeedEntry={
                !loading &&
                !seedPlaylist &&
                !(Array.isArray(playlists) && playlists.length === 0)
              }
              seedOpen={seedOpen}
              onToggleSeed={() => setSeedOpen(!seedOpen)}
              inputRef={inputRef}
              micSupported={Boolean(SpeechRecognitionImpl)}
              listening={listening}
              micHandlers={{ press: micPress, release: micRelease, keyToggle: micKeyToggle }}
            />
            {inputHint && (
              <div className="input-hint" role="alert">
                {inputHint}
              </div>
            )}
            {/* failures and the daily cap live right under the button that
                caused them. They used to render after the whole empty state,
                which on a phone put them below the fold — the button snapped
                from STOP back to MAKE THE MIXTAPE and looked inert. tabIndex
                -1 so the effect above can focus it. */}
            {error && (
              <ErrorAlert message={error} detail={errorDetail} booked={booked} alertRef={errorRef} />
            )}

            {!loading && (
              <>
                {/* the seed picker, opened from the composer-bar trigger; a
                    chosen playlist collapses into the token docked on the
                    composer */}
                {seedOpen && !seedPlaylist && (
                  <div className="seed-panel">
                      <div className="seed-panel-head">
                        <span>{loggedIn ? "pick a playlist to base it on" : "paste a playlist to base it on"}</span>
                        <button
                          type="button"
                          className="seed-panel-close"
                          aria-label="Close the playlist picker"
                          onClick={() => {
                            setSeedOpen(false);
                            setSeedFilter("");
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      {!loggedIn ? (
                        <>
                          <form
                            className="seed-paste"
                            onSubmit={(e) => {
                              e.preventDefault();
                              applyPastedSeed();
                            }}
                          >
                            <input
                              className="seed-filter"
                              value={seedPaste}
                              onChange={(e) => setSeedPaste(e.target.value)}
                              placeholder="https://open.spotify.com/playlist/…"
                              aria-label="Spotify playlist link"
                              inputMode="url"
                              autoFocus
                            />
                            <button type="submit" className="seed-retry">
                              use it
                            </button>
                          </form>
                          <div className="seed-explainer">
                            in Spotify: the playlist’s ⋯ menu → Share → Copy link. Public
                            playlists only — we read its tracks, then make a new
                            mixtape in the same spirit
                          </div>
                        </>
                      ) : Array.isArray(playlists) ? (
                        <>
                          {playlists.length > 6 && (
                            <input
                              className="seed-filter"
                              value={seedFilter}
                              onChange={(e) => setSeedFilter(e.target.value)}
                              placeholder="find a playlist…"
                              aria-label="Filter your playlists"
                            />
                          )}
                          <div className="seed-list">
                            {seedShown.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className="seed-item"
                                onClick={() => {
                                  setSeedId(p.id);
                                  setSeedOpen(false);
                                  setSeedFilter("");
                                  setInputHint(null);
                                  setAnnounce(
                                    `Using ${p.name}. The prompt is now optional.`
                                  );
                                  inputRef.current?.focus();
                                }}
                              >
                                <span className="seed-item-name">{p.name}</span>
                                <span className="seed-item-meta">
                                  {p.total != null
                                    ? `${p.total} track${p.total === 1 ? "" : "s"}`
                                    : ""}
                                  {p.mine === false && p.owner
                                    ? `${p.total != null ? " · " : ""}by ${p.owner}`
                                    : ""}
                                </span>
                              </button>
                            ))}
                            {seedShown.length === 0 && (
                              <div className="seed-note">
                                nothing matches “{seedFilter.trim()}”
                              </div>
                            )}
                          </div>
                          <div className="seed-explainer">
                            we read its tracks, then make a new mixtape in the
                            same spirit — no songs copied over
                          </div>
                        </>
                      ) : playlists === "unauthorized" ? (
                        <a href="/auth/login" className="seed-reauth">
                          reconnect Spotify to browse your playlists
                        </a>
                      ) : playlists === "error" ? (
                        <div className="seed-error-row">
                          <span className="seed-note">
                            couldn’t load your playlists
                          </span>
                          <button
                            type="button"
                            className="seed-retry"
                            onClick={loadPlaylists}
                          >
                            retry
                          </button>
                        </div>
                      ) : (
                        <span className="seed-note">loading your playlists…</span>
                      )}
                    </div>
                )}

                {/* the prompt-optional contract while a seed is armed. The
                    unseeded caption ("takes about a minute — every track is
                    checked on Spotify") is gone: the header says what comes
                    back and the waiting screen says how long, so here it was
                    a third telling. */}
                {seedPlaylist && (
                  <div className="scope-line">
                    prompt optional — the mixtape follows that playlist’s
                    spirit; add words to steer it
                  </div>
                )}

                {/* this browser's presses, so a guest who didn't tap + in
                    Spotify can get back to one. Right under the composer,
                    above the example prompts: for a returning visitor their
                    own tapes outrank strangers' prompts. Newest three, the
                    rest behind one toggle, so it never outgrows the composer. */}
                <RecentMixtapes
                  recent={recent}
                  showAll={showAllRecent}
                  onToggle={() => setShowAllRecent((v) => !v)}
                />

                {/* proof before more ways in: on a phone this was under the
                    chips and two gaps, off the first screen entirely */}
                <SampleCard />

                {/* everyone's newest presses: real results a stranger can
                    open before typing anything. Under the sample (what you
                    get → what people got), minus this browser's own, which
                    "your mixtapes" already lists. Absent when empty. */}
                <LatestShelf
                  latest={latest}
                  ownUrls={recent.map((m) => m.url)}
                  isOwner={isOwner}
                  onHide={hideLatest}
                />

                {/* example chips: populate the prompt, stay editable */}
                <ExamplePrompts
                  onPick={(ex) => {
                    setPrompt(ex);
                    setInputHint(null);
                    inputRef.current?.focus();
                  }}
                />

                <HomeNotes showConnect={loggedIn === false && SHOW_LOGS} />
              </>
            )}
          </>
        )}

        {loading && (
          <GeneratingProgress
            stage={stage}
            logTracks={logTracks}
            step={loadingStep}
            stepTotal={stepTotal}
          />
        )}

        {/* the card */}
        {card && (
          <div className="card-wrap">
            <MixtapeCard
              card={card}
              editable={editable}
              adjusting={adjusting}
              saved={Boolean(playlistUrl)}
              titleRef={cardTitleRef}
              onReorder={reorderCard}
              onSwap={swapTrack}
            />

            {/* second chance: refine the card in place — only in the editable
                window, same gating as drag-to-reorder */}
            {editable && (
              <RefinePanel
                text={adjustText}
                onTextChange={setAdjustText}
                onRefine={() => refine()}
                onStop={stopAdjusting}
                adjusting={adjusting}
                stage={adjustStage}
                log={adjustLog}
                error={adjustError}
                errorDetail={adjustErrorDetail}
                booked={adjustBooked}
                inputRef={refineRef}
              />
            )}

            {/* save to spotify — primary action; everything else stays quiet */}
            {!playlistUrl && (
              <SaveDock
                saving={saving}
                stage={saveStage}
                verified={verifiedCount(card.tracks)}
                total={card.tracks.length}
                disabled={saving || adjusting}
                loggedIn={loggedIn}
                onSave={saveToSpotify}
              />
            )}
            {playlistUrl && (
              <PressedPanel
                playlistUrl={playlistUrl}
                savedToLibrary={savedToLibrary}
                copied={copied}
                onShare={shareMixtape}
                onCopyTracks={() => copyText(trackListText(card.tracks), "tracks")}
                panelRef={pressedRef}
                openRef={pressedOpenRef}
              />
            )}
            {saveError && (
              <ErrorAlert message={saveError} booked={saveBooked} alertRef={saveErrorRef} />
            )}

            <button
              onClick={() => {
                if (
                  unsavedCard &&
                  !window.confirm("This mixtape isn’t on Spotify yet. Start over and lose it?")
                ) {
                  return;
                }
                setCard(null);
                setPlaylistUrl(null);
                setSavedToLibrary(false);
                setCopied(null);
                setSaveError(null);
                setAdjustError(null);
                setAdjustErrorDetail(null);
                setAdjustText("");
                inputRef.current?.focus();
              }}
              // disabled while adjusting or saving: the in-flight refine or
              // press would land its result right back on the cleared state
              disabled={adjusting || saving}
              className="btn-ghost"
              style={{ marginTop: 20 }}
            >
              make another one
            </button>
          </div>
        )}
      </main>

      {/* the server's log tail — the answer to "check the server logs".
          A permanent "logs" pill reads as part of the product to a first-time
          visitor, so it only renders in dev or behind ?debug. */}
      {SHOW_LOGS && <LogConsole />}
    </div>
  );
}
