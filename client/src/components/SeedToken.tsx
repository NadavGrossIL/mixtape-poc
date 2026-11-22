import { type Playlist } from "../types";

// The armed seed playlist, docked to the prompt box as a removable token.
export default function SeedToken({ seed, onClear }: { seed: Playlist; onClear: () => void }) {
  return (
    <div className="seed-token">
      <span className="seed-token-mark" aria-hidden>
        ♫
      </span>
      <span className="seed-token-label">
        in the spirit of{" "}
        <span className="seed-token-name">
          {seed.name ? `“${seed.name}”` : "your pasted playlist"}
        </span>
        {seed.total != null
          ? ` · ${seed.total} tracks`
          : ""}
      </span>
      <button
        type="button"
        className="seed-token-clear"
        aria-label={`Remove ${seed.name || "the pasted playlist"}`}
        onClick={onClear}
      >
        ✕
      </button>
    </div>
  );
}
