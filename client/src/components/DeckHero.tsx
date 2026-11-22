// Leaves the notch, loops once, then runs level under the wordmark and stops
// under its last letter. Units are the deck's own (84 wide); the end x is the
// wordmark's right edge at the em sizes set in hero.css.
const TAPE_SPILL =
  "M42 44 C38 49 29 56 22 53.5 C17 51.5 21 47 26 49.5 " +
  "C33 53 44 55 62 55 C130 55 190 53 287 54";

// The header mark (landing and waiting screens), set beside the wordmark as
// one lockup: an idle deck standing on the wordmark's baseline, reels
// turning at different speeds (the take-up pack is smaller, so it spins
// faster), and its spilled tape drawn out as the wordmark's underline. Drawn
// for ~45px tall, so few, heavy strokes: no screws, no window, no label.
// Pure decoration, aria-hidden; all motion lives in CSS behind the
// reduced-motion gate.
//
// `compact` is the same drawing once a card is on the table: no tape and no
// motion, sized to the smaller wordmark. One cassette on every screen — it
// used to swap to a different, older icon the moment the card arrived.
export default function DeckHero({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      className={"deck" + (compact ? " deck-compact" : "")}
      // the box is the shell only, so flex baseline alignment puts the
      // shell's bottom edge on the wordmark's baseline; the tape overflows
      // it on purpose (overflow: visible in hero.css)
      viewBox="0 0 84 44"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.25" y="1.25" width="81.5" height="41.5" rx="5" />
      {/* supply reel: fat tape pack */}
      <circle cx="27" cy="20" r="10.5" strokeWidth="1.75" className="deck-accent" />
      <g className="deck-reel deck-reel-supply">
        <circle cx="27" cy="20" r="4.75" className="deck-hub" />
        <circle cx="29.3" cy="20" r="1.35" className="deck-hub-hole" />
      </g>
      {/* take-up reel: thin pack */}
      <circle cx="57" cy="20" r="7.5" strokeWidth="1.75" className="deck-accent" />
      <g className="deck-reel deck-reel-takeup">
        <circle cx="57" cy="20" r="4.75" className="deck-hub" />
        <circle cx="59.3" cy="20" r="1.35" className="deck-hub-hole" />
      </g>
      {/* tape running pack-top to pack-top */}
      <path d="M27 9.5 L57 12.5" strokeWidth="1.75" className="deck-accent" />
      {/* bottom notch */}
      <path d="M26 42.75l3.5-8h25l3.5 8" strokeWidth="2" />
      {!compact && (
        <>
          {/* spilled tape: solid run + a brighter dash sliding along it */}
          <path className="deck-tape" d={TAPE_SPILL} />
          {/* pathLength = the dash period in keyframes.css, so exactly one
              highlight travels the tape per cycle whatever its drawn length */}
          <path className="deck-tape-flow" d={TAPE_SPILL} pathLength={232} />
        </>
      )}
    </svg>
  );
}
