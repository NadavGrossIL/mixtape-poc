// The generate run's state — whether a mixtape is being made, the stream's
// stage, the progress log, the seed being read, and the run's error — as
// one reducer, plus the waiting screen's step line worked out from it. Kept
// out of the hook so both are unit-tested under Node
// (server/test/generationRun.test.ts). useGeneration dispatches these
// actions at the points its setters used to run; what the visitor is told
// stays there.

import type { LogTrack } from "./types.ts";

// the generate stream's stage, as its events report it
export type Stage = "seeding" | "curating" | "resolving" | null;

// What failed, shown under the composer. `detail` is the server's own
// words for what went wrong, shown under the friendly line — the log panel
// has the rest of the run. `booked`: the error is a cap, not a fault.
export interface GenerationError {
  message: string;
  detail: string | null;
  booked: boolean;
}

export interface GenerationState {
  loading: boolean;
  // real progress, driven only by SSE events from the backend
  stage: Stage;
  logTracks: (LogTrack | undefined)[]; // sparse until every "track" lands
  error: GenerationError | null;
  // bumps on every failure so the alert is scrolled into view even when the
  // same line lands twice in a row (a capped visitor pressing again);
  // ErrorAlert's focusKey. Never reset.
  errorTick: number;
}

export type GenerationAction =
  | { type: "started" }
  | { type: "seeding" }
  | { type: "stage"; stage: "curating" | "resolving" }
  | { type: "track"; index: number; artist: string; title: string }
  | { type: "resolved"; index: number; resolved: boolean }
  | { type: "failed"; error: GenerationError }
  | { type: "finished" };

export const generationIdle: GenerationState = {
  loading: false,
  stage: null,
  logTracks: [],
  error: null,
  errorTick: 0,
};

export function generationRun(state: GenerationState, action: GenerationAction): GenerationState {
  switch (action.type) {
    case "started":
      return { ...state, loading: true, error: null, stage: null, logTracks: [] };
    case "seeding":
      return { ...state, stage: "seeding" };
    case "stage":
      // the same value twice is no change, as a useState setter would see it
      return state.stage === action.stage ? state : { ...state, stage: action.stage };
    case "track": {
      const next = [...state.logTracks];
      next[action.index] = { artist: action.artist, title: action.title };
      return { ...state, logTracks: next };
    }
    case "resolved": {
      const next = [...state.logTracks];
      const cur = next[action.index]; // local so TS narrows the sparse slot
      if (cur) {
        next[action.index] = { ...cur, resolved: action.resolved };
      }
      return { ...state, logTracks: next };
    }
    case "failed":
      return { ...state, error: action.error, errorTick: state.errorTick + 1 };
    // the run's `finally`. The stage and log stay as they ended: they only
    // show while loading, and the next start clears them.
    case "finished":
      return { ...state, loading: false };
  }
}
