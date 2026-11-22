// One song line in a progress log ("→ 03 artist — title ✓"), shared by the
// generate and refine logs. `index` is the track's 0-based place on the card.
export default function LogLine({
  index,
  track,
}: {
  index: number;
  track: { artist: string; title: string; resolved?: boolean };
}) {
  return (
    <div className="log-track">
      <span className="log-arrow">→</span>{" "}
      <span className="log-num">
        {String(index + 1).padStart(2, "0")}
      </span>{" "}
      {track.artist} — {track.title}
      {track.resolved === true && <span className="log-check"> ✓</span>}
      {track.resolved === false && (
        <span className="log-unverified"> unverified</span>
      )}
    </div>
  );
}
