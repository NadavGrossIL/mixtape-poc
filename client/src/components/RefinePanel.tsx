import { type RefObject } from "react";
import StudioChatter from "./StudioChatter";
import LogLine from "./LogLine";
import ErrorAlert from "./ErrorAlert";
import { type AdjustLogLine } from "../types";

// The refine box under the card: the input and REFINE / STOP, the refine
// run's progress log, and its error. Presentational: the refine run lives
// in App and arrives as props.

const cursor = (
  <span className="cursor" aria-hidden>
    ▮
  </span>
);

export default function RefinePanel({
  text,
  onTextChange,
  onRefine,
  onStop,
  adjusting,
  stage,
  log,
  error,
  errorDetail,
  booked,
  inputRef,
}: {
  text: string;
  onTextChange: (value: string) => void;
  onRefine: () => void;
  onStop: () => void;
  adjusting: boolean;
  stage: "adjusting" | "resolving" | null;
  log: AdjustLogLine[];
  error: string | null;
  errorDetail: string | null;
  booked: boolean;
  inputRef: RefObject<HTMLInputElement>;
}) {
  return (
    <div className="refine-area">
      {/* frames refine as the optional branch, so the accent save
          button below reads as the finish line */}
      <div className="refine-caption">not quite right?</div>
      <div className="refine-row">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            // same IME guard as the prompt box
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onRefine();
            }
          }}
          placeholder="tweak it — less 80s, more instrumental…"
          className="refine-input"
          disabled={adjusting}
          aria-label="Refine the mixtape"
        />
        <button
          onClick={adjusting ? onStop : () => onRefine()}
          className="btn-ghost refine-btn"
        >
          {adjusting ? "STOP" : "REFINE"}
        </button>
      </div>
      {adjusting && (
        /* same console-log aesthetic as generate — every line is a
           real SSE event; the live region above narrates milestones */
        <div className="progress-log refine-log" aria-hidden>
          <StudioChatter
            pool={stage === "resolving" ? "resolving" : "rewinding"}
            inline
          />
          <div className="log-line">
            changing the songs…
            {stage === "resolving" ? (
              <span className="log-ok"> ok</span>
            ) : (
              cursor
            )}
          </div>
          {log.map((l, i) => (
            <LogLine key={i} index={l.index} track={l} />
          ))}
          {stage === "resolving" && (
            <div className="log-line">checking on Spotify…{cursor}</div>
          )}
        </div>
      )}
      {error && (
        <ErrorAlert message={error} detail={errorDetail} booked={booked} />
      )}
    </div>
  );
}
