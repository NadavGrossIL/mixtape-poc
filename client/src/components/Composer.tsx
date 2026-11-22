import { type RefObject } from "react";
import SeedToken from "./SeedToken";
import MicButton, { type MicHandlers } from "./MicButton";
import { type Playlist } from "../types";

// The composer card: the armed-seed token, the prompt box with its mic, and
// the control row (seed trigger, MAKE THE MIXTAPE / STOP). Presentational:
// the prompt, the seed and the run all live in App and arrive as props.

// One static placeholder that names the three prompt axes and stops there:
// the example chips carry the "what can I type" teaching, so the box itself
// holds still — a fifth example here read as a twin of the 2am-drive chip.
// A second variant takes over when a seed playlist is armed — the prompt is
// optional in that mode and the placeholder is where that contract is stated.
const PLACEHOLDER = "a mood, a moment, an era…";
const SEEDED_PLACEHOLDER =
  "optional: add a twist — “more instrumental, nothing in english…”";

// Autofocus the prompt only where a blinking cursor is the cheapest "act
// here" signal and costs nothing: a pointer device. On a phone it would raise
// the keyboard over the example chips before the visitor has read them.
const AUTOFOCUS_PROMPT =
  typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;

interface ComposerProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  loading: boolean;
  seed: Playlist | null;
  onClearSeed: () => void;
  showSeedEntry: boolean;
  seedOpen: boolean;
  onToggleSeed: () => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  micSupported: boolean;
  listening: boolean;
  micHandlers: MicHandlers;
}

export default function Composer({
  prompt,
  onPromptChange,
  onSubmit,
  onStop,
  loading,
  seed,
  onClearSeed,
  showSeedEntry,
  seedOpen,
  onToggleSeed,
  inputRef,
  micSupported,
  listening,
  micHandlers,
}: ComposerProps) {
  return (
    <div className="composer">
      {/* armed seed: a removable token docked to the prompt box.
          The box visibly "contains something", which is also what
          makes an empty textarea read as legitimate. */}
      {seed && <SeedToken seed={seed} onClear={onClearSeed} />}
      <div
        className={
          "prompt-wrap" + (micSupported ? " has-mic" : "")
        }
      >
        <textarea
          ref={inputRef}
          autoFocus={AUTOFOCUS_PROMPT}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            // not while an IME is composing: that Enter confirms
            // the composition, and Safari reports it as a plain
            // Enter — it spent a generation on a half-typed prompt
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={seed ? SEEDED_PLACEHOLDER : PLACEHOLDER}
          rows={3}
          className="prompt-input"
          aria-label="Playlist prompt"
        />
        {micSupported && <MicButton listening={listening} handlers={micHandlers} />}
      </div>
      {/* the card's control row: attached-context trigger on the
          left, the one primary action on the right */}
      <div className="composer-bar">
        {showSeedEntry ? (
          <button
            type="button"
            className="seed-entry"
            aria-expanded={seedOpen}
            onClick={onToggleSeed}
          >
            + start from a playlist
          </button>
        ) : (
          <span aria-hidden />
        )}
        <button
          onClick={loading ? onStop : () => onSubmit()}
          className="btn-press"
        >
          {loading ? "STOP" : "MAKE THE MIXTAPE"}
        </button>
      </div>
    </div>
  );
}
