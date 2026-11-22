// One Spotify search inside a LangChain run, with the app's own rules:
//   - a cached search costs no Spotify quota, but a run may make at most
//     MAX_CACHED_SEARCHES of them: each result is fed back into the model's
//     context and replayed every later round, so a prompt that talks the
//     model into repeating cached queries would otherwise grow one run's
//     Anthropic bill without bound (security pass 2026-11-22);
//   - a live search must fit the run's own cap (20) AND the request-wide
//     allowance shared with track resolution (searchBudget.ts);
//   - at most two searches leave at once (the model asks for nine in one go);
//   - a spent daily quota ends the run instead of inviting made-up tracks.
// These were the hand-written loop's rules, line for line. LangChain's ready-made
// toolCallLimitMiddleware could not do it: it counts every call, cached or
// not, and knows nothing about the allowance resolution spends from later.
//
// Everything it needs is passed in, so the test needs no Spotify and no model.

import { claimSearch, catalogResultContent } from "../curator.ts";
import type { SearchBudget } from "../searchBudget.ts";
import { errorMessage, isQuotaError } from "../errors.ts";

// Let at most `max` jobs run at once; the rest wait their turn, in order.
function makeLimiter(max: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function limit<T>(job: () => Promise<T>): Promise<T> {
    if (running >= max) await new Promise<void>((go) => waiting.push(go));
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

// Well above an honest run's repeats (the model re-asks a handful of queries
// at most) and far below the ~context-window cost an abusive loop reaches.
const MAX_CACHED_SEARCHES = 40;

function makeSearchStep({
  isCached,
  search,
  loop,
  request,
  concurrency,
  onFatal,
  maxCached = MAX_CACHED_SEARCHES,
}: {
  isCached: (query: string) => boolean;
  search: (query: string) => Promise<unknown>;
  loop: SearchBudget; // this run's own cap
  request: SearchBudget; // the request-wide allowance
  concurrency: number;
  // Called with the error when Spotify's daily quota is gone: the run must
  // stop. (LangChain turns anything a tool throws into a message for the
  // model, so throwing alone would not stop it.)
  onFatal: (err: unknown) => void;
  maxCached?: number; // this run's cap on cache hits
}): (query: string) => Promise<string> {
  const limit = makeLimiter(concurrency);
  let cachedHits = 0;
  return (query) =>
    limit(async () => {
      const cached = isCached(query);
      if (cached && ++cachedHits > maxCached) {
        return (
          `You have already searched this mixtape's queries ${maxCached} times. ` +
          `Commit now using only tracks that already came back in earlier ` +
          `search results — do not add a track you have not seen verified.`
        );
      }
      if (!claimSearch(cached, loop, request)) {
        // Note what this does NOT say: it never
        // invites the model to fall back on its own knowledge.
        return (
          `Search budget for this mixtape is used up (${request.spent()} searches). ` +
          `Commit now using only tracks that already came back in earlier ` +
          `search results — do not add a track you have not seen verified.`
        );
      }
      try {
        return catalogResultContent(await search(query));
      } catch (err) {
        if (isQuotaError(err)) {
          onFatal(err);
          throw err;
        }
        console.warn(`[curator-lc] search_spotify failed: ${errorMessage(err)}`);
        return "Spotify search is unavailable right now — rely on your own knowledge and prefer well-known recordings.";
      }
    });
}

export { makeLimiter, makeSearchStep, MAX_CACHED_SEARCHES };
