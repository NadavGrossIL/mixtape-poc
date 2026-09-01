// One request, one Spotify search allowance.
//
// The curator agent loop used to be the only thing counting searches, and it
// counted only its own: SEARCH_BUDGET bounded the loop, and then track
// resolution ran afterwards and searched again — up to 3 query strategies per
// track across 8 tracks — outside any budget at all. A worst-case request
// therefore spent ~44 searches against a documented assumption of 8-20
// (index.ts, above generationLimits), and the daily caps are sized off that
// assumption. Twelve worst-case guest generations would trip the process-wide
// quota breaker in spotify.ts and take the app down for everyone.
//
// So the budget is a request-scoped object passed to both halves rather than a
// counter owned by either. Cache hits never reach it — the caller checks
// isSearchCached() first — so it counts exactly what costs quota.

interface SearchBudget {
  // Claim one quota-costing search. False means the allowance is gone; the
  // caller degrades (commit with what it has, leave a track unresolved) rather
  // than spending.
  spend(): boolean;
  spent(): number;
  remaining(): number;
}

function makeSearchBudget(limit: number): SearchBudget {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  let used = 0;
  return {
    spend() {
      if (used >= max) return false;
      used++;
      return true;
    },
    spent: () => used,
    remaining: () => Math.max(0, max - used),
  };
}

export type { SearchBudget };
export { makeSearchBudget };
