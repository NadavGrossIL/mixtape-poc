// Jam mode: which curator rules a run gets, and when a jam run is refused.
// Pure (ADR 0003); the two stream routes in index.ts only call it.
//
// The mode belongs to the card, not the request: generate reads it from the
// body (that is where a card is born), adjust reads it from the card and
// ignores any body field, so a jam card is never refined with the mixtape
// prompt or the reverse. The card comes back from the browser, so adjust
// checks the flag too: with JAM_MODE off a hand-edited `mode: "jam"` card
// would otherwise run the jam rules (specs/0006-jam-session-set.md).
//
// An error here is answered with 400 BEFORE the caps, the usage log and the
// funnel see the request: a refused mode is neither charged nor counted.

type Mode = "mix" | "jam";
type Refusal = { error: string };

const JAM_OFF = "Jam mode isn't available.";

// On only for exactly "1", like DEPLOYED: a typo must not switch it on.
function jamEnabled(env: string | undefined): boolean {
  return env === "1";
}

// ── who may use it: everyone, or only browsers that opened the invite link ──
//
// JAM_MODE=1 turns jam on for every visitor. JAM_INVITE=<secret> turns it on
// only for a browser that has opened `/?jam=<secret>` once: that visit sets a
// cookie holding a hash of the secret (never the secret itself, like the site
// gate's cookie in index.ts), and every later request carrying it may use jam.
// A short secret is guessable, so under MIN_INVITE characters it is ignored
// (jam stays off) rather than half-protecting anything.

const MIN_INVITE = 16;
const JAM_COOKIE = "mixtape_jam";

// The cookie value for an invite secret, or null when invites are off.
// Salted with a fixed label so it never equals the site gate's hash of the
// same string.
function jamInviteToken(invite: string | undefined, hash: (s: string) => string): string | null {
  if (!invite || invite.length < MIN_INVITE) return null;
  return hash(`mixtape-jam-invite:${invite}`);
}

// May this request use jam mode? `match` is a constant-time compare.
function jamAllowed(
  { everyone, token, cookie }: { everyone: boolean; token: string | null; cookie: string | null },
  match: (a: string, b: string) => boolean
): boolean {
  if (everyone) return true;
  return token !== null && cookie !== null && match(cookie, token);
}

function generateMode(bodyMode: unknown, enabled: boolean): Mode | Refusal {
  if (bodyMode === undefined || bodyMode === "mix") return "mix";
  if (bodyMode === "jam") return enabled ? "jam" : { error: JAM_OFF };
  return { error: "Unknown mode." };
}

function adjustMode(card: { mode?: Mode }, enabled: boolean): Mode | Refusal {
  const mode = card.mode ?? "mix";
  if (mode === "jam" && !enabled) return { error: JAM_OFF };
  return mode;
}

export type { Mode };
export { jamEnabled, jamInviteToken, jamAllowed, JAM_COOKIE, MIN_INVITE, generateMode, adjustMode };
