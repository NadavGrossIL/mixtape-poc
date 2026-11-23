// The refine run's state — the refine box's text, whether a refine is in
// flight, its stage and progress log, and its error — as one reducer, kept
// out of the hook so it is unit-tested under Node
// (server/test/refineRun.test.ts). useRefine dispatches these actions at the
// points its setters used to run; what the visitor is told stays there.

import type { AdjustLogLine } from "./types.ts";

// the refine stream's stage, as its events report it
export type RefineStage = "adjusting" | "resolving" | null;

// What failed, shown under the refine box. `detail` is the server's own
// words, under the friendly line; `booked`: the error is a cap, not a
// fault.
export interface RefineError {
  message: string;
  detail: string | null;
  booked: boolean;
}

export interface RefineState {
  text: string;
  adjusting: boolean;
  stage: RefineStage;
  log: AdjustLogLine[];
  error: RefineError | null;
  // Bumped on every failure, so the alert scrolls into view even when the
  // same line lands twice in a row (a capped visitor tapping replace again);
  // ErrorAlert's focusKey. A replace is tapped up in the track list, and the
  // alert sits under the whole card — on a phone, off-screen. Never reset.
  errorTick: number;
}

export type RefineAction =
  | { type: "textChanged"; text: string }
  | { type: "started" }
  | { type: "stage"; stage: RefineStage }
  | { type: "change"; line: AdjustLogLine }
  | { type: "resolved"; index: number; resolved: boolean }
  | { type: "succeeded" }
  | { type: "failed"; error: RefineError }
  | { type: "finished" }
  | { type: "reset" };

export const refineIdle: RefineState = {
  text: "",
  adjusting: false,
  stage: null,
  log: [],
  error: null,
  errorTick: 0,
};

export function refineRun(state: RefineState, action: RefineAction): RefineState {
  switch (action.type) {
    case "textChanged":
      return { ...state, text: action.text };
    // the run's start; the text stays, so a failed refine can be retried
    case "started":
      return { ...state, adjusting: true, error: null, stage: null, log: [] };
    case "stage":
      // the same value twice is no change, as a useState setter would see it
      return state.stage === action.stage ? state : { ...state, stage: action.stage };
    case "change":
      return { ...state, log: [...state.log, action.line] };
    case "resolved":
      return {
        ...state,
        log: state.log.map((l) =>
          l.index === action.index ? { ...l, resolved: action.resolved } : l
        ),
      };
    // the merged card is App's; here only the box empties
    case "succeeded":
      return { ...state, text: "" };
    case "failed":
      return { ...state, error: action.error, errorTick: state.errorTick + 1 };
    // the run's `finally`: the log goes, the error stays on screen
    case "finished":
      return { ...state, adjusting: false, stage: null, log: [] };
    // A new run or "make another one": the old card's error and unsent
    // text go. It used to clear the error's text and detail but not its
    // booked flag; dropping the whole object also drops that flag, which
    // is harmless: every later failure sets it explicitly. Only ever
    // dispatched while no refine is in flight, so the rest is idle already.
    case "reset":
      return { ...state, text: "", error: null };
  }
}
