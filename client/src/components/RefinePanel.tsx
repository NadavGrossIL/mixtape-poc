import StudioChatter from "./StudioChatter";
import LogLine from "./LogLine";
import ErrorAlert from "./ErrorAlert";
import { type Refine } from "../hooks/useRefine";

// The refine box under the card: the input and REFINE / STOP, the refine
// run's progress log, and its error. The only UI for useRefine, so it takes
// that hook's whole return value as one prop.

const cursor = (
  <span className="cursor" aria-hidden>
    ▮
  </span>
);

export default function RefinePanel({ refine }: { refine: Refine }) {
  const { stage, log, error, errorTick } = refine;
  return (
    <div className="refine-area">
      {/* frames refine as the optional branch, so the accent save
          button below reads as the finish line */}
      <div className="refine-caption">not quite right?</div>
      <div className="refine-row">
        <input
          ref={refine.inputRef}
          value={refine.text}
          onChange={(e) => refine.setText(e.target.value)}
          onKeyDown={(e) => {
            // same IME guard as the prompt box
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              refine.refine();
            }
          }}
          placeholder="tweak it — less 80s, more instrumental…"
          className="refine-input"
          disabled={refine.adjusting}
          aria-label="Refine the mixtape"
        />
        <button
          onClick={refine.adjusting ? refine.stop : () => refine.refine()}
          className="btn-ghost refine-btn"
        >
          {refine.adjusting ? "STOP" : "REFINE"}
        </button>
      </div>
      {refine.adjusting && (
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
        <ErrorAlert
          message={error.message}
          detail={error.detail}
          booked={error.booked}
          focusKey={errorTick}
        />
      )}
    </div>
  );
}
