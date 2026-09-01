// Pressing needs its own daily cap, for a reason generation doesn't have.
//
// /api/playlist takes its title and uris straight from the request body, so
// it is the one paid route a caller can reach WITHOUT going through the
// curator. Uncapped, a public URL means unlimited public playlists on the
// host account under a name the caller chose — and every press spends the
// Spotify quota the generation caps exist to protect, which is process-wide
// (spotify.ts), so a flood takes the app down for everyone for hours.
//
// The limits are DERIVED from the generation limits rather than configured
// separately. A press always follows a generate or an adjust, both of which
// already spent a generation slot, so press limits that were tighter than
// generation limits would refuse someone their last legitimate save — a bug
// that can't happen if they're a strict superset by construction.

import { makeCaps } from "./caps.ts";

interface CapLimits {
  perAccount: number;
  perGuest: number;
  perIp: number;
  allGuests: number;
}

// Slack over the generation cap, for the presses that don't map 1:1 onto a
// generation: re-pressing a card after an adjustment, and a retried save.
const PRESS_HEADROOM = 3;

function pressLimits(generate: CapLimits): CapLimits {
  return {
    perAccount: generate.perAccount + PRESS_HEADROOM,
    perGuest: generate.perGuest + PRESS_HEADROOM,
    perIp: generate.perIp + PRESS_HEADROOM,
    allGuests: generate.allGuests + PRESS_HEADROOM,
  };
}

// caps.ts phrases its refusals for the generate flow ("that's your 5 tapes for
// today"), which is the wrong sentence in front of someone trying to KEEP a
// tape they already have. One honest line covers both tiers here: whether it's
// their own limit or the app's, the answer is the same and it isn't an error.
const PRESS_REFUSAL = "the deck has pressed all it can today — come back tomorrow.";

function makePressCaps(generate: CapLimits) {
  const caps = makeCaps(pressLimits(generate));
  return {
    refusal(user: string, ip: string, day: string): string | null {
      return caps.refusal(user, ip, day) ? PRESS_REFUSAL : null;
    },
    count(user: string, ip: string, day: string) {
      caps.count(user, ip, day);
    },
  };
}

export { makePressCaps, pressLimits, PRESS_HEADROOM, PRESS_REFUSAL };
export type { CapLimits };
