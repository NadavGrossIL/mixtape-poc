// Two decisions the save and run catch blocks make about a failure, kept out
// of React so they are unit-tested under Node (server/test/failures.test.ts).

// ── saving ──
//
// /api/playlist has two answers where "try again" is the wrong advice,
// because nothing will change until tomorrow:
// - its daily press cap, a 429 whose JSON body is the visitor's line
//   (server/pressCaps.ts, PRESS_REFUSAL);
// - Spotify's app-wide daily quota, which arrives as the stream's `error`
//   event (or a 500 body without the stream) worded as below. The save route
//   sends no `quota` flag the way generate does, so the wording is the signal;
//   a prefix, so a reworded "— try again tomorrow" tail still matches.
// Every other save failure stays the generic line: the route's own fault
// text says "check the server logs", which a visitor must never see.
const SAVE_QUOTA_PREFIX = "Spotify's daily limit for this app is used up";

// what a body-less 429 says; the same words as PRESS_REFUSAL
export const SAVE_CAP_FALLBACK = "no more playlists can be saved today — come back tomorrow.";

// The server's line when this failure is a wait-until-tomorrow refusal,
// else null (a fault: show the generic retry line). `status` is null for a
// failure that arrived mid-stream, where the HTTP status was already 200.
export function saveRefusal(status: number | null, message: string | null | undefined): string | null {
  if (status === 429) return message || SAVE_CAP_FALLBACK;
  if (message && message.startsWith(SAVE_QUOTA_PREFIX)) return message;
  return null;
}

// ── the connection ──
//
// A fetch that never reached the server, or a stream whose connection died,
// rejects with a TypeError whose message is the browser's own ("Failed to
// fetch", "Load failed", "NetworkError when attempting to fetch resource.",
// "network error"). Shown under "the curator dropped the needle — that's on
// us" it blamed us and printed browser jargon for what is the visitor's wifi.
// Matched by message, not by TypeError alone: a bug in our own code (reading
// a property of null) is a TypeError too, and that one IS on us.
const NETWORK_MESSAGE =
  /failed to fetch|load failed|networkerror|network error|network connection was lost|error in body stream/i;

export function isNetworkFailure(e: unknown, online: boolean | undefined): boolean {
  if (online === false) return true;
  return e instanceof TypeError && NETWORK_MESSAGE.test(e.message);
}
