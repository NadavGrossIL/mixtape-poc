// The save run's state — whether a save is in flight, its stage label, the
// pressed playlist's URL and whether it landed in the visitor's library,
// and the save's error — as one reducer, kept out of the hook so it is
// unit-tested under Node (server/test/saveRun.test.ts). useSave dispatches
// these actions at the points its setters used to run.

// What failed, shown under the save notes. `booked`: the failure is a cap
// (today's saves, Spotify's daily quota), not a fault.
export interface SaveError {
  message: string;
  booked: boolean;
}

export interface SaveState {
  saving: boolean;
  stage: string | null; // "CREATING PLAYLIST…" | "ADDING N SONGS…"
  playlistUrl: string | null;
  savedToLibrary: boolean;
  error: SaveError | null;
  // bumps on every failure so the alert is scrolled into view even when
  // the same line lands twice in a row (a capped visitor pressing again,
  // a second "No verified songs"); ErrorAlert's focusKey. Never reset.
  errorTick: number;
}

export type SaveAction =
  | { type: "started" }
  | { type: "stage"; stage: string }
  | { type: "succeeded"; playlistUrl: string; savedToLibrary: boolean }
  | { type: "failed"; error: SaveError }
  | { type: "finished" }
  | { type: "reset" };

export const saveIdle: SaveState = {
  saving: false,
  stage: null,
  playlistUrl: null,
  savedToLibrary: false,
  error: null,
  errorTick: 0,
};

export function saveRun(state: SaveState, action: SaveAction): SaveState {
  switch (action.type) {
    case "started":
      return { ...state, saving: true, error: null, stage: null };
    case "stage":
      // the same label twice is no change, as a useState setter would see it
      return state.stage === action.stage ? state : { ...state, stage: action.stage };
    case "succeeded":
      return { ...state, playlistUrl: action.playlistUrl, savedToLibrary: action.savedToLibrary };
    // also the refusal before any request ("No verified songs to save."),
    // which is why it doesn't touch `saving`
    case "failed":
      return { ...state, error: action.error, errorTick: state.errorTick + 1 };
    // the run's `finally`
    case "finished":
      return { ...state, saving: false, stage: null };
    // A new run or "make another one": the pressed playlist and the save
    // error go. It used to clear the error's text but not its booked flag;
    // dropping the whole object also drops that flag, which is harmless:
    // every later failure sets it explicitly. The tick stays, so the next
    // failure still changes the alert's focusKey. Only ever dispatched
    // while no save is in flight, so `saving` and `stage` are idle already.
    case "reset":
      return { ...state, playlistUrl: null, savedToLibrary: false, error: null };
  }
}
