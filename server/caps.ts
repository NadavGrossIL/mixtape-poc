// Daily generation caps — pure, so the numbers that bound the bill are
// testable without a server or a paid run.
//
// Generation spends two budgets SHARED by every user: the Anthropic key and
// Spotify's per-developer-account daily search quota (low hundreds of
// searches/day — one enthusiastic visitor could lock the whole app out for
// ~19h, and the quota breaker is process-wide, so that locks the allowlisted
// friends out too). In-memory is enough: it resets on redeploy, which at
// this scale is a feature, not a bug.
//
// Connected accounts get a per-account cap. Guests are cheap to mint, so a
// guest is capped three ways: per guest cookie, per IP, and all guests
// together — the last one is what actually bounds the bill.

import { isAnon } from "./session.ts";

interface CapLimits {
  perAccount: number;
  perGuest: number;
  perIp: number;
  allGuests: number;
}

const GUEST_TOTAL_KEY = "guests:all";

function makeCaps(limits: CapLimits) {
  const counts = new Map<string, { day: string; count: number }>();

  const under = (key: string, cap: number, day: string) => {
    const entry = counts.get(key);
    return !entry || entry.day !== day || entry.count < cap;
  };
  const bump = (key: string, day: string) => {
    const entry = counts.get(key);
    if (entry && entry.day === day) entry.count += 1;
    else counts.set(key, { day, count: 1 });
  };

  return {
    // The refusal line, or null when the caller may generate. Counting is a
    // separate call so a refused request never consumes budget.
    refusal(user: string, ip: string, day: string): string | null {
      if (!isAnon(user)) {
        return under(user, limits.perAccount, day)
          ? null
          : `that’s your ${limits.perAccount} tapes for today — come back tomorrow.`;
      }
      if (!under(user, limits.perGuest, day) || !under(`ip:${ip}`, limits.perIp, day)) {
        return `that’s your ${limits.perGuest} tapes for today — come back tomorrow.`;
      }
      if (!under(GUEST_TOTAL_KEY, limits.allGuests, day)) {
        // the public ceiling: Spotify's daily search quota is shared by
        // everyone, so "sold out" is the honest state — say it like one
        return "today’s tapes are all pressed — come back tomorrow.";
      }
      return null;
    },
    count(user: string, ip: string, day: string) {
      bump(user, day);
      if (isAnon(user)) {
        bump(`ip:${ip}`, day);
        bump(GUEST_TOTAL_KEY, day);
      }
    },
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export { makeCaps, today };
// pressCaps.ts derives its limits from these, so it needs the same shape.
// Exported rather than re-declared there: one form, one place to change it.
export type { CapLimits };
