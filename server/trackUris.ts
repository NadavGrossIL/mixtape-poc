// What /api/playlist is allowed to hand Spotify, as a pure function.
//
// The route reads `uris` straight off the request body and they go into a
// JSON body against the host account's real library. `title` was already
// funnelled through sanitizePlaylistName() and a seed id through
// parsePlaylistRef(); `uris` was checked with Array.isArray() and nothing
// else, so anything array-shaped — other people's URIs, non-strings, a
// hundred thousand entries — was forwarded verbatim.
//
// A Spotify track URI has exactly one shape: `spotify:track:` plus a
// 22-character base-62 id. Anything else is not a thing we should be asking
// Spotify to add, so it is a 400 rather than something to sanitize into
// shape — the client only ever sends URIs it got from us.

// Spotify's own add-items maximum for one request. Beyond it the call fails
// anyway; the point of the cap here is that the array is bounded BEFORE it is
// serialized and sent.
const MAX_TRACK_URIS = 100;

const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;

// The URIs, or null when the input is not a usable list. Null covers every
// rejection — not an array, empty, too long, a non-string element, a
// malformed URI — because the caller's answer to all of them is the same 400.
function parseTrackUris(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length === 0 || input.length > MAX_TRACK_URIS) return null;
  for (const uri of input) {
    if (typeof uri !== "string" || !TRACK_URI.test(uri)) return null;
  }
  return input as string[];
}

export { parseTrackUris, MAX_TRACK_URIS };
