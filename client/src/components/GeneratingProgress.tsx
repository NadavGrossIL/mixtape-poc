import StudioChatter from "./StudioChatter";
import LogLine from "./LogLine";
import { type LogTrack } from "../types";
import { type Stage } from "../generationRun";

// The waiting screen while a mixtape is made: the disc, then one log at one
// weight — the studio chatter (keyed to the stage, so a playlist run reads
// its own lines first) and each song as its event lands. There is no
// separate status line: a fixed "step 1 of 2 · picking the songs" sat
// stacked on the chatter saying the same thing, and step 2 (checking on
// Spotify) is near-instant because the curator already searched every song,
// so nobody ever saw it (removed 2026-11-22).

export default function GeneratingProgress({
  stage,
  logTracks,
}: {
  stage: Stage;
  logTracks: (LogTrack | undefined)[];
}) {
  return (
    <div className="loading">
      <div className="spinner-disc" aria-hidden />
      {/* the rotating chatter, then the songs as they land — every
          song line is a real backend event. aria-hidden: the live
          region narrates the milestones. */}
      <div className="progress-log" aria-hidden>
        <StudioChatter pool={stage ?? "reading"} inline />
        {logTracks.map(
          (t, i) => t && <LogLine key={i} index={i} track={t} />
        )}
      </div>
    </div>
  );
}
