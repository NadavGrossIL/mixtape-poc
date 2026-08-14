// Deep-linking into the installed Spotify app instead of the web player.
//
// Every link we render keeps its https://open.spotify.com href in the DOM —
// that preserves copy-link, middle-click and "open in new tab", and it is the
// only thing that works when the app isn't installed. On a plain left click we
// intercept and navigate to the equivalent spotify: URI, which the OS hands to
// the desktop/mobile app. If nothing claims the URI the page keeps focus, and
// we fall back to the web player a beat later.

const WEB_HOST = "open.spotify.com";

// Path shapes we know how to translate: /<entity>/<id>.
const ENTITIES = new Set([
  "track",
  "album",
  "artist",
  "playlist",
  "show",
  "episode",
  "user",
]);

// Long enough that a slow app launch doesn't race us, short enough that a dead
// click doesn't feel broken.
const FALLBACK_MS = 1500;

// https://open.spotify.com/track/abc123?si=… → spotify:track:abc123
// https://open.spotify.com/search/a%20b     → spotify:search:a%20b
// Returns null for anything we don't recognise, which means "just use the web".
export function toAppUri(webUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(webUrl, window.location.href);
  } catch {
    return null;
  }
  if (url.hostname !== WEB_HOST) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  // Spotify sometimes prefixes a locale segment: /intl-he/track/abc123
  if (parts[0] && parts[0].startsWith("intl-")) parts.shift();

  if (parts[0] === "search" && parts.length > 1) {
    // keep the segment percent-encoded — the app takes it as-is
    return `spotify:search:${parts.slice(1).join(":")}`;
  }
  if (parts.length >= 2 && ENTITIES.has(parts[0])) {
    return `spotify:${parts[0]}:${parts[1]}`;
  }
  return null;
}

function openWeb(webUrl: string) {
  window.open(webUrl, "_blank", "noopener,noreferrer");
}

// Call from a click handler that has already preventDefault()ed.
export function openInSpotify(webUrl: string) {
  const uri = toAppUri(webUrl);
  if (!uri) return openWeb(webUrl);

  let handedOff = false;
  const noteHandoff = () => {
    handedOff = true;
  };
  // The app coming to the front — or Chrome's "Open Spotify?" prompt taking
  // focus — pulls focus off the document. That's our signal to stay put.
  window.addEventListener("blur", noteHandoff);
  window.addEventListener("pagehide", noteHandoff);
  document.addEventListener("visibilitychange", noteHandoff);

  window.location.href = uri;

  window.setTimeout(() => {
    window.removeEventListener("blur", noteHandoff);
    window.removeEventListener("pagehide", noteHandoff);
    document.removeEventListener("visibilitychange", noteHandoff);
    if (handedOff || document.hidden || !document.hasFocus()) return;
    openWeb(webUrl);
  }, FALLBACK_MS);
}
