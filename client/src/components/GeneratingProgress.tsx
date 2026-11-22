import StudioChatter from "./StudioChatter";
import LogLine from "./LogLine";
import { type LogTrack } from "../types";
import { type Stage } from "../generationRun";

// The waiting screen while a mixtape is made: the step line, the studio
// chatter, and each song as its event lands. The step comes from
// loadingStep (generationRun.ts).

export default function GeneratingProgress({
  stage,
  logTracks,
  step,
  stepTotal,
}: {
  stage: Stage;
  logTracks: (LogTrack | undefined)[];
  step: { n: number; label: string };
  stepTotal: number;
}) {
  return (
    <div className="loading">
      <div className="spinner-disc" aria-hidden />
      {/* the one plain statement of where the run is and how long the
          tunnel is. It replaced three lines that each said "working"
          in studio slang (the chatter, a caption, a log line); the
          stage now has exactly one place on screen. aria-hidden: the
          live region above narrates the same milestones. */}
      <div className="loading-step" aria-hidden>
        <div className="loading-step-now">
          step {step.n} of {stepTotal} · {step.label}
        </div>
        <div className="loading-step-note">usually about a minute</div>
      </div>
      {/* the rotating chatter, then the songs as they land — every
          song line is a real backend event */}
      <div className="progress-log" aria-hidden>
        <StudioChatter pool={stage ?? "reading"} inline />
        {logTracks.map(
          (t, i) => t && <LogLine key={i} index={i} track={t} />
        )}
      </div>
    </div>
  );
}
