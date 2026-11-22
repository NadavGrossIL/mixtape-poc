import { useReducer, useRef } from "react";
import { type GenerateStreamEvent, type MixCard, type Playlist } from "../types";
import { StreamDroppedError, readSSE } from "../sse";
import { verifiedCount } from "../card";
import {
  classifyRunFailure,
  noStreamErrors,
  noteStreamError,
  responseFailure,
  streamFailure,
} from "../runFailure";
import { generationIdle, generationRun } from "../generationRun";

// Making a mixtape: the generate run (its stage, progress log, seed being
// read, error and failure tick; generationRun.ts) and its abort
// controller. The prompt, the hint, the armed seed and the card stay App's.
// The run reads this render's prompt and seed; `onStart` is called after
// the guards and before the request (App ends a dictation take and clears
// the last card, save and refine there), `onSeedNamed` when the `seeding`
// event names the playlist, and `onCard` with the finished card. A failed
// or stopped run calls neither of the last two, so the seed stays armed.
// The "not while refining" half of the guard is App's (onGenerate).
export default function useGeneration({
  prompt,
  seed,
  announce,
  setHint,
  focusPrompt,
  onStart,
  onCard,
  onSeedNamed,
}: {
  prompt: string;
  seed: Playlist | null;
  announce: (line: string) => void;
  setHint: (hint: string | null) => void;
  focusPrompt: () => void;
  onStart: () => void;
  onCard: (card: MixCard) => void;
  onSeedNamed: (name: string) => void;
}) {
  const [state, dispatch] = useReducer(generationRun, generationIdle);
  const abortRef = useRef<AbortController | null>(null);

  const generate = async (p?: string) => {
    const thePrompt = (p ?? prompt).trim();
    if (state.loading) return;
    // a seed playlist alone is a valid ask ("just like this one")
    if (!thePrompt && !seed) {
      setHint(
        "Type a vibe first — a mood, a moment, an era — or start from a playlist."
      );
      focusPrompt();
      return;
    }
    // everything from here to the fetch is synchronous, so App's resets
    // and the run's start land in one render
    onStart();
    dispatch({ type: "started" });
    announce("Making your mixtape.");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: thePrompt,
          ...(seed
            ? { seed: { id: seed.id, name: seed.name } }
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
          dispatch({ type: "seeding", name: data?.name || "your playlist" });
          // a pasted seed learns its real name from the server
          const name = data?.name;
          if (name) onSeedNamed(name);
          announce("Reading your playlist.");
        } else if (event === "curating") {
          dispatch({ type: "stage", stage: "curating" });
          announce("Picking the songs.");
        } else if (event === "track") {
          dispatch({ type: "track", index: data.index, artist: data.artist, title: data.title });
        } else if (event === "curated") {
          dispatch({ type: "stage", stage: "resolving" });
          announce("Checking each song on Spotify.");
        } else if (event === "resolved") {
          dispatch({ type: "resolved", index: data.index, resolved: data.resolved });
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
      announce(
        `Mixtape ready: ${doneCard.tracks.length} tracks, ${verified} verified on Spotify.`
      );
      onCard(doneCard);
    } catch (e) {
      // worded and announced apart from refine's on purpose: generate
      // announces a cap and a plain error
      const failure = classifyRunFailure(e, navigator.onLine);
      switch (failure.kind) {
        case "aborted":
          announce("Stopped.");
          break;
        case "cap":
          dispatch({
            type: "failed",
            error: { message: failure.error.message, detail: failure.error.detail, booked: true },
          });
          announce(failure.error.message);
          break;
        case "offline":
          // the visitor's connection, not the curator: no "that's on us", and
          // no detail line — the browser's "Failed to fetch" helps nobody
          dispatch({
            type: "failed",
            error: {
              message: "you look offline — check your connection and try the same prompt again.",
              detail: null,
              booked: false,
            },
          });
          break;
        case "dropped":
          dispatch({
            type: "failed",
            error: {
              message: "the connection dropped mid-run — try the same prompt again.",
              detail: null,
              booked: false,
            },
          });
          break;
        case "plain":
          dispatch({
            type: "failed",
            error: { message: failure.error.message, detail: failure.error.detail, booked: false },
          });
          announce(failure.error.message);
          break;
        case "fault":
          console.error(e);
          dispatch({
            type: "failed",
            error: {
              message: "The curator dropped the needle — that’s on us. Try the same prompt again.",
              detail: e instanceof Error ? e.message : String(e),
              booked: false,
            },
          });
          break;
      }
    } finally {
      abortRef.current = null;
      dispatch({ type: "finished" });
    }
  };

  return {
    loading: state.loading,
    stage: state.stage,
    logTracks: state.logTracks,
    seedLog: state.seedLog,
    error: state.error,
    errorTick: state.errorTick,
    generate,
    stop: () => {
      abortRef.current?.abort();
    },
  };
}
