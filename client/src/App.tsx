import { useRef, useState } from "react";
import LogConsole from "./LogConsole";
import { type MixCard } from "./types";
import { reorderTracks, verifiedCount } from "./card";
import { loadingStep } from "./generationRun";
import SampleCard from "./components/SampleCard";
import SiteHeader from "./components/SiteHeader";
import Composer from "./components/Composer";
import RecentMixtapes from "./components/RecentMixtapes";
import LatestShelf from "./components/LatestShelf";
import ExamplePrompts from "./components/ExamplePrompts";
import HomeNotes from "./components/HomeNotes";
import GeneratingProgress from "./components/GeneratingProgress";
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
import useSave from "./hooks/useSave";
import useGeneration from "./hooks/useGeneration";
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
  const [inputHint, setInputHint] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(""); // screen-reader milestones

  const inputRef = useRef<HTMLTextAreaElement | null>(null);

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

  // pressing the card to Spotify; a press is remembered on this browser
  // ("your mixtapes") and the shelf is re-read
  const save = useSave({
    card,
    announce: setAnnounce,
    onSaved: ({ title, url }) => {
      recent.record({ title, url, pressedAt: Date.now() });
      latest.reload();
    },
  });

  // making a mixtape. Called before useRefine, whose guard needs
  // gen.loading; onStart reaches clearDraft (below), which needs refine.
  // That is safe: onStart only runs on a click, after this render has
  // declared both.
  const gen = useGeneration({
    prompt,
    seed: seed.armed,
    announce: setAnnounce,
    setHint: setInputHint,
    focusPrompt,
    onStart: () => {
      dictation.stop(); // pressing it while dictating ends the take
      clearDraft();
    },
    onCard: (doneCard) => {
      setCard(doneCard);
      // The card records the seed (card.seed, printed on the sleeve); the
      // armed seed must not silently ride along into the next generation.
      // A failed run keeps it, so "try the same prompt again" stays true.
      seed.clearAfterRun();
    },
    onSeedNamed: (name) => seed.nameFromServer(name),
  });

  // refine and swap; blocked while a mixtape is being made or saved
  const refine = useRefine({
    card,
    blocked: gen.loading || save.saving,
    announce: setAnnounce,
    onCard: setCard,
  });

  // a card on screen that no playlist was pressed from: leaving asks first
  // (useUnsavedCardGuard), and so does "make another one"
  const unsavedCard = Boolean(card) && !save.playlistUrl;
  useUnsavedCardGuard(unsavedCard);

  // The last card and everything hanging off it: its save and its refine.
  // A new run's start and "make another one" both clear it. Nulling the
  // card in the same batch as a run's start is what keeps `loading ⇒ !card`
  // (and a refine needs a card, so `adjusting ⇒ card`).
  const clearDraft = () => {
    setCard(null);
    save.reset();
    refine.reset();
  };

  // the composer's MAKE THE MIXTAPE; not while a refine is in flight (the
  // run's own "already loading" guard is in useGeneration)
  const onGenerate = (p?: string) => {
    if (refine.adjusting) return;
    gen.generate(p);
  };

  // "make another one": asks first if the card was never pressed
  const startOver = () => {
    if (
      unsavedCard &&
      !window.confirm("This mixtape isn’t on Spotify yet. Start over and lose it?")
    ) {
      return;
    }
    clearDraft();
    focusPrompt();
  };

  const step = loadingStep(gen.stage, gen.logTracks, gen.seedLog, seed.armed);

  // reorder is a pure client-side edit; the save flow reads card.tracks in
  // order, so the pressed playlist follows whatever order is on the card
  const editable = Boolean(card) && !save.playlistUrl && !save.saving;

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
              onSubmit={() => onGenerate()}
              onStop={gen.stop}
              loading={gen.loading}
              seed={seed.armed}
              onClearSeed={seed.clear}
              showSeedEntry={!gen.loading && seed.canOffer}
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
            {gen.error && (
              <ErrorAlert
                message={gen.error.message}
                detail={gen.error.detail}
                booked={gen.error.booked}
                focusKey={gen.errorTick}
              />
            )}

            {!gen.loading && (
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

        {gen.loading && (
          <GeneratingProgress
            stage={gen.stage}
            logTracks={gen.logTracks}
            step={step}
            stepTotal={step.total}
          />
        )}

        {/* the card */}
        {card && (
          <div className="card-wrap">
            <MixtapeCard
              card={card}
              editable={editable}
              adjusting={refine.adjusting}
              saved={Boolean(save.playlistUrl)}
              onReorder={reorderCard}
              onSwap={refine.swap}
            />

            {/* second chance: refine the card in place — only in the editable
                window, same gating as drag-to-reorder */}
            {editable && (
              <RefinePanel refine={refine} />
            )}

            {/* save to spotify — primary action; everything else stays quiet */}
            {!save.playlistUrl && (
              <SaveDock
                saving={save.saving}
                stage={save.stage}
                verified={verifiedCount(card.tracks)}
                total={card.tracks.length}
                disabled={save.saving || refine.adjusting}
                loggedIn={loggedIn}
                onSave={save.save}
              />
            )}
            {save.playlistUrl && (
              <PressedPanel
                playlistUrl={save.playlistUrl}
                savedToLibrary={save.savedToLibrary}
                card={card}
                announce={setAnnounce}
              />
            )}
            {save.error && (
              <ErrorAlert
                message={save.error.message}
                booked={save.error.booked}
                focusKey={save.errorTick}
              />
            )}

            <button
              onClick={startOver}
              // disabled while adjusting or saving: the in-flight refine or
              // press would land its result right back on the cleared state
              disabled={refine.adjusting || save.saving}
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
