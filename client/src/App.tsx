import { useRef, useState } from "react";
import LogConsole from "./LogConsole";
import {
  type GenerateStreamEvent,
  type LogTrack,
  type MixCard,
  type SaveStreamEvent,
} from "./types";
import { CapError, StreamDroppedError, readSSE } from "./sse";
import { saveRefusal } from "./failures";
import { reorderTracks, verifiedCount } from "./card";
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
import SeedPanel from "./components/SeedPanel";
import useSession from "./hooks/useSession";
import useLatestShelf from "./hooks/useLatestShelf";
import useRecentMixtapes from "./hooks/useRecentMixtapes";
import usePageView from "./hooks/usePageView";
import useUnsavedCardGuard from "./hooks/useUnsavedCardGuard";
import useDictation from "./hooks/useDictation";
import useSeedPicker from "./hooks/useSeedPicker";
import useRefine from "./hooks/useRefine";

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

export default function App() {
  // first, in this order: their mount requests go auth, then latest, then view
  const { loggedIn, isOwner } = useSession();
  const latest = useLatestShelf();
  const recent = useRecentMixtapes();
  usePageView();

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
  const [saving, setSaving] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);
  const [savedToLibrary, setSavedToLibrary] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveBooked, setSaveBooked] = useState(false); // same cap-not-fault split as `booked`
  const [saveErrorTick, setSaveErrorTick] = useState(0); // same job as errorTick
  // real progress, driven only by SSE events from the backend
  const [stage, setStage] = useState<Stage>(null);
  const [logTracks, setLogTracks] = useState<(LogTrack | undefined)[]>([]); // sparse until every "track" lands
  const [seedLog, setSeedLog] = useState<{ name: string } | null>(null); // while seeding this run
  const [saveStage, setSaveStage] = useState<string | null>(null); // "creating" | "adding N"
  const [inputHint, setInputHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(""); // screen-reader milestones

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const focusPrompt = () => inputRef.current?.focus();

  const dictation = useDictation({
    prompt,
    setPrompt,
    setHint: setInputHint,
    announce: setAnnounce,
    focusPrompt,
  });

  const seed = useSeedPicker({
    loggedIn,
    announce: setAnnounce,
    setHint: setInputHint,
    focusPrompt,
  });

  // refine and swap; blocked while a mixtape is being made or saved
  const refine = useRefine({
    card,
    blocked: loading || saving,
    announce: setAnnounce,
    onCard: setCard,
  });

  // a card on screen that no playlist was pressed from: leaving asks first
  // (useUnsavedCardGuard), and so does "make another one"
  const unsavedCard = Boolean(card) && !playlistUrl;
  useUnsavedCardGuard(unsavedCard);

  const generate = async (p?: string) => {
    const thePrompt = (p ?? prompt).trim();
    if (loading || refine.adjusting) return;
    // a seed playlist alone is a valid ask ("just like this one")
    if (!thePrompt && !seed.armed) {
      setInputHint(
        "Type a vibe first — a mood, a moment, an era — or start from a playlist."
      );
      inputRef.current?.focus();
      return;
    }
    dictation.stop(); // pressing it while dictating ends the take
    setLoading(true);
    setError(null);
    setErrorDetail(null);
    setBooked(false);
    setCard(null);
    setPlaylistUrl(null);
    setSavedToLibrary(false);
    setSaveError(null);
    refine.reset();
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
          ...(seed.armed
            ? { seed: { id: seed.armed.id, name: seed.armed.name } }
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
          const name = data?.name;
          if (name) seed.nameFromServer(name);
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
      seed.clearAfterRun();
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
      recent.record({ title: card.title, url, pressedAt: Date.now() });
      latest.reload();
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
  const stepTotal = seed.armed ? 3 : 2;
  const loadingStep =
    stage === "resolving"
      ? {
          n: stepTotal,
          label: `checking each one on Spotify · ${liveChecked} of ${logTracks.length}`,
        }
      : stage === "curating" || !seed.armed
        ? { n: stepTotal - 1, label: "picking the songs" }
        : {
            n: 1,
            label: `reading “${seedLog?.name || seed.armed.name || "your playlist"}”`,
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
              seed={seed.armed}
              onClearSeed={seed.clear}
              showSeedEntry={!loading && seed.canOffer}
              seedOpen={seed.open}
              onToggleSeed={seed.toggle}
              inputRef={inputRef}
              micSupported={dictation.supported}
              listening={dictation.listening}
              micHandlers={dictation.micHandlers}
            />
            {inputHint && (
              <div className="input-hint" role="alert">
                {inputHint}
              </div>
            )}
            {/* failures and the daily cap live right under the button that
                caused them. They used to render after the whole empty state,
                which on a phone put them below the fold — the button snapped
                from STOP back to MAKE THE MIXTAPE and looked inert. With
                focusKey it scrolls itself into view and takes focus. */}
            {error && (
              <ErrorAlert message={error} detail={errorDetail} booked={booked} focusKey={errorTick} />
            )}

            {!loading && (
              <>
                {/* the seed picker, opened from the composer-bar trigger; a
                    chosen playlist collapses into the token docked on the
                    composer */}
                {seed.open && !seed.armed && (
                  <SeedPanel picker={seed} loggedIn={loggedIn} />
                )}

                {/* the prompt-optional contract while a seed is armed. The
                    unseeded caption ("takes about a minute — every track is
                    checked on Spotify") is gone: the header says what comes
                    back and the waiting screen says how long, so here it was
                    a third telling. */}
                {seed.armed && (
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
                  recent={recent.recent}
                  showAll={recent.showAll}
                  onToggle={recent.toggleShowAll}
                />

                {/* proof before more ways in: on a phone this was under the
                    chips and two gaps, off the first screen entirely */}
                <SampleCard />

                {/* everyone's newest presses: real results a stranger can
                    open before typing anything. Under the sample (what you
                    get → what people got), minus this browser's own, which
                    "your mixtapes" already lists. Absent when empty. */}
                <LatestShelf
                  latest={latest.latest}
                  ownUrls={recent.recent.map((m) => m.url)}
                  isOwner={isOwner}
                  onHide={latest.hide}
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
              adjusting={refine.adjusting}
              saved={Boolean(playlistUrl)}
              onReorder={reorderCard}
              onSwap={refine.swap}
            />

            {/* second chance: refine the card in place — only in the editable
                window, same gating as drag-to-reorder */}
            {editable && (
              <RefinePanel refine={refine} />
            )}

            {/* save to spotify — primary action; everything else stays quiet */}
            {!playlistUrl && (
              <SaveDock
                saving={saving}
                stage={saveStage}
                verified={verifiedCount(card.tracks)}
                total={card.tracks.length}
                disabled={saving || refine.adjusting}
                loggedIn={loggedIn}
                onSave={saveToSpotify}
              />
            )}
            {playlistUrl && (
              <PressedPanel
                playlistUrl={playlistUrl}
                savedToLibrary={savedToLibrary}
                card={card}
                announce={setAnnounce}
              />
            )}
            {saveError && (
              <ErrorAlert message={saveError} booked={saveBooked} focusKey={saveErrorTick} />
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
                setSaveError(null);
                refine.reset();
                inputRef.current?.focus();
              }}
              // disabled while adjusting or saving: the in-flight refine or
              // press would land its result right back on the cleared state
              disabled={refine.adjusting || saving}
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
