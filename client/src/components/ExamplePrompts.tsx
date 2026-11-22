// The example-prompt chips, right under the composer and ahead of the sample. A chip hands its prompt to
// `onPick`; the composer stays editable.

// Each example demonstrates a different prompt axis: speed/skill,
// mood+moment, discovery/language, era+audience.
// Three, not four: the 2am-drive prompt that used to lead is the sample card
// below, and the same sentence twice on one screen read as noise.
const EXAMPLES = [
  "hebrew indie that deserves a bigger audience",
  "90s hip-hop for a newborn's first road trip",
  "fastest rap verses ever recorded — Rap God energy",
];

export default function ExamplePrompts({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="examples">
      <div className="section-note">or start from one of these</div>
      <div className="chips">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            className="chip"
            onClick={() => onPick(ex)}
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}
