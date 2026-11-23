import { useReducer, useRef, useState } from "react";
import { type AdjustStreamEvent, type MixCard, type Track } from "../types";
import { StreamDroppedError, readSSE } from "../sse";
import {
  classifyRunFailure,
  noStreamErrors,
  noteStreamError,
  responseFailure,
  streamFailure,
} from "../runFailure";
import { refineIdle, refineRun } from "../refineRun";
import { track } from "../analytics";

// Second-chance refine: the refine box's text, the refine run (its stage,
// progress log and error; refineRun.ts) and its abort controller, plus the
// per-track ↻ swap, which is a canned instruction through the same run.
// RefinePanel is its UI and takes the whole return value. The card stays
// App's: the run reads this render's card and hands the merged one to
// `onCard`. `blocked` is the other runs' half of the guard (a mixtape
// being made or saved); generate and "make another one" call `reset`.
export type Refine = ReturnType<typeof useRefine>;

export default function useRefine({
  card,
  blocked,
  announce,
  onCard,
}: {
  card: MixCard | null;
  blocked: boolean;
  announce: (line: string) => void;
  onCard: (card: MixCard) => void;
}) {
  // second-chance refine — same real-SSE discipline as generate
  const [state, dispatch] = useReducer(refineRun, refineIdle);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // which row a ↻ replace is for, so that row (not just the whole card)
  // shows the work; null for a typed refine
  const [swapping, setSwapping] = useState<number | null>(null);

  // Send the current card + an adjustment instruction, stream the diff,
  // swap in the merged card. One pipeline serves both the refine box and
  // the per-track ↻ swap buttons.
  const refine = async (instruction?: string, kind: "typed" | "swap" = "typed") => {
    const theInstruction = (instruction ?? state.text).trim();
    if (!card || state.adjusting || blocked) return;
    if (!theInstruction) {
      inputRef.current?.focus();
      return;
    }
    dispatch({ type: "started" });
    announce("Changing the mixtape.");
    track("refine_requested", { kind });
    let changeCount = 0;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/adjust/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `kind` picks which daily allowance the server spends
        // (server/runCaps.ts): the ↻ replace button has its own
        body: JSON.stringify({
          card,
          adjustment: theInstruction,
          kind: kind === "swap" ? "replace" : "refine",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const data: { error?: string } = await response.json().catch(() => ({}));
        throw responseFailure(response.status, data, "adjust failed");
      }
      // widened initializer: the assignment happens inside the readSSE
      // callback, which TS's control-flow analysis can't see
      let doneCard = null as MixCard | null;
      const streamErrors = noStreamErrors();
      await readSSE<AdjustStreamEvent>(response, (event, data) => {
        if (event === "adjusting") {
          dispatch({ type: "stage", stage: "adjusting" });
        } else if (event === "change") {
          changeCount++;
          dispatch({
            type: "change",
            line: { index: data.index, artist: data.artist, title: data.title },
          });
        } else if (event === "adjusted") {
          dispatch({ type: "stage", stage: "resolving" });
          announce("Checking the new songs on Spotify.");
        } else if (event === "resolved") {
          dispatch({ type: "resolved", index: data.index, resolved: data.resolved });
        } else if (event === "done") {
          doneCard = data?.card ?? null;
        } else if (event === "error") {
          noteStreamError(streamErrors, data, "adjust failed");
        }
      });
      const streamError = streamFailure(streamErrors);
      if (streamError) throw streamError;
      if (!doneCard?.tracks?.length) throw new StreamDroppedError();
      announce(
        `Mixtape adjusted: ${changeCount} track${changeCount === 1 ? "" : "s"} changed.`
      );
      track("refine_done", { kind, changes: changeCount });
      onCard(doneCard);
      dispatch({ type: "succeeded" });
    } catch (e) {
      // worded and announced apart from generate's on purpose: a refine
      // announces only a cap
      const failure = classifyRunFailure(e, navigator.onLine);
      track(failure.kind === "aborted" ? "refine_stopped" : "refine_failed", { kind, reason: failure.kind });
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
          // same split as in generate
          dispatch({
            type: "failed",
            error: {
              message: "you look offline — check your connection and try it again.",
              detail: null,
              booked: false,
            },
          });
          break;
        case "dropped":
          dispatch({
            type: "failed",
            error: { message: "the connection dropped — try it again.", detail: null, booked: false },
          });
          break;
        case "plain":
          dispatch({
            type: "failed",
            error: { message: failure.error.message, detail: failure.error.detail, booked: false },
          });
          break;
        case "fault":
          console.error(e);
          dispatch({
            type: "failed",
            error: {
              message: "Couldn't make that change. Try rewording it.",
              detail: e instanceof Error ? e.message : String(e),
              booked: false,
            },
          });
          break;
      }
    } finally {
      abortRef.current = null;
      setSwapping(null);
      dispatch({ type: "finished" });
    }
  };

  // Per-track replace: a canned instruction through the same refine pipeline.
  const swap = (i: number, t: Track) => {
    if (!card || state.adjusting || blocked) return;
    setSwapping(i);
    return refine(
      `Replace track ${i + 1} (${t.artist} — ${t.title}) with a different track that fits the mixtape. Keep every other track exactly as it is.`,
      "swap"
    );
  };

  return {
    text: state.text,
    setText: (text: string) => dispatch({ type: "textChanged", text }),
    adjusting: state.adjusting,
    swapping,
    stage: state.stage,
    log: state.log,
    error: state.error,
    errorTick: state.errorTick,
    inputRef,
    refine,
    swap,
    stop: () => {
      abortRef.current?.abort();
    },
    reset: () => dispatch({ type: "reset" }),
  };
}
