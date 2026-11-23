// Daily caps on curator runs, per KIND of run — pure, so the numbers that
// bound the bill are testable without a server or a paid run.
//
// A guest used to get one shared allowance (GUEST_DAILY_CAP) that a new
// mixtape, a typed refine and a one-song replace all spent alike. On launch
// day (2026-11-23) a visitor made one mixtape, replaced two songs and was
// told "that's your 3 mixtapes for today" — then tapped replace three more
// times, because nothing on screen matched what they had done. Replacing a
// song is the cheapest thing to keep doing (one changed track, ~$0.05, no new
// search plan), so it gets the biggest allowance, and each kind is refused in
// its own words.
//
// Guests are capped four ways: per kind per guest cookie (the allowance a
// visitor feels), per IP and all guests together (what stops minting fresh
// cookies, and what actually bounds the Anthropic bill and Spotify's shared
// search quota — see the comment over `runLimits` in index.ts). Connected
// accounts keep one total per account; they are the allowlisted friends.
//
// Which kind a run is comes from the client (`kind` on /api/adjust/stream).
// It is trusted on purpose: a refine dressed as a replace costs the same, and
// the per-IP and all-guests totals bound the bill whatever the label says.
//
// In-memory, like caps.ts: it resets on redeploy, which at this scale is fine.

import { isAnon } from "./session.ts";

export type RunKind = "mixtape" | "refine" | "replace";

export const RUN_KINDS: readonly RunKind[] = ["mixtape", "refine", "replace"];

export interface RunLimits {
  // runs per guest per day, by kind
  guest: Record<RunKind, number>;
  perAccount: number;
  perIp: number;
  allGuests: number;
}

const ALL_GUESTS = "guests:all";

// what each kind is called in a refusal, singular and plural
const NOUN: Record<RunKind, [string, string]> = {
  mixtape: ["new mixtape", "new mixtapes"],
  refine: ["refine", "refines"],
  replace: ["replace", "replaces"],
};

const noun = (kind: RunKind, n: number) => NOUN[kind][n === 1 ? 0 : 1];

function makeRunCaps(limits: RunLimits) {
  const counts = new Map<string, { day: string; count: number }>();

  const used = (key: string, day: string) => {
    const entry = counts.get(key);
    return entry && entry.day === day ? entry.count : 0;
  };
  const bump = (key: string, day: string) => {
    counts.set(key, { day, count: used(key, day) + 1 });
  };
  const left = (user: string, kind: RunKind, day: string) =>
    limits.guest[kind] - used(`${user}:${kind}`, day);

  // The guest's own limit for one kind, said so it names what they did and
  // what they can still do. A refine or replace is refused with a card on
  // screen, so the line says it can still be saved — a save never spends a
  // run (pressCaps.ts keeps its own, roomier ledger).
  function guestLine(user: string, kind: RunKind, day: string): string {
    const limit = limits.guest[kind];
    const head = `sorry, that’s your ${limit} ${noun(kind, limit)} for today.`;
    if (kind === "mixtape") return `${head} come back tomorrow for more.`;
    const other: RunKind = kind === "refine" ? "replace" : "refine";
    const otherLeft = left(user, other, day);
    if (otherLeft > 0) {
      return `${head} you can still ${other === "replace" ? "replace a song" : "refine it"}, or save this mixtape.`;
    }
    return `${head} this mixtape is still yours to save.`;
  }

  return {
    // The refusal line, or null when the run may go ahead. Counting is a
    // separate call so a refused request never spends anything.
    refusal(user: string, ip: string, day: string, kind: RunKind): string | null {
      if (!isAnon(user)) {
        return used(user, day) < limits.perAccount
          ? null
          : `that’s your ${limits.perAccount} mixtapes and changes for today — come back tomorrow.`;
      }
      if (left(user, kind, day) <= 0) return guestLine(user, kind, day);
      if (used(`ip:${ip}`, day) >= limits.perIp) {
        // many guests behind one address (or one visitor minting cookies)
        return "that’s all for today from this network — come back tomorrow.";
      }
      if (used(ALL_GUESTS, day) >= limits.allGuests) {
        // the public ceiling: Spotify's daily search quota is shared by
        // everyone, so "sold out" is the honest state — say it like one
        return "today’s mixtapes are all taken — come back tomorrow.";
      }
      return null;
    },
    count(user: string, ip: string, day: string, kind: RunKind) {
      if (!isAnon(user)) {
        bump(user, day);
        return;
      }
      bump(`${user}:${kind}`, day);
      bump(`ip:${ip}`, day);
      bump(ALL_GUESTS, day);
    },
  };
}

// The most runs one guest can make in a day, every kind added up. The press
// cap is derived from this, so a guest's last save is never refused.
function guestTotal(limits: RunLimits): number {
  return RUN_KINDS.reduce((sum, kind) => sum + limits.guest[kind], 0);
}

export { makeRunCaps, guestTotal };
