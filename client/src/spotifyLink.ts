// Deep-linking into the installed Spotify app instead of the web player.
//
// Every link we render keeps its https://open.spotify.com href in the DOM —
// that preserves copy-link, middle-click and "open in new tab", and it is the
// only thing that works when the app isn't installed. On a desktop left click
// we intercept and navigate to the equivalent spotify: URI, which the OS hands
// to the desktop app. If nothing claims the URI the page keeps focus, and we
// fall back to the web player a beat later.
//
// On phones we do NOT intercept. Most visitors arrive from LinkedIn's in-app
// webview, where a custom-scheme navigation can fail silently and a
// `window.open` fired 1.5 s after the tap is outside the gesture and gets
// popup-blocked — a dead tap on the most important button. Universal links
// don't open apps from a webview either. What does work everywhere is the
// plain `<a href="https://open.spotify.com/…" target="_blank">`: Spotify's own
// page turns into an "Open app" banner. So `openInSpotify` returns false on a
// touch/mobile browser and the caller lets the native anchor navigate.

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

// Touch/mobile detection: either signal is enough, since a mobile UA with a
// mouse-ish pointer (iPad + trackpad) still lives in the same webview world.
export function isTouchOrMobile(
  env: { ua?: string; coarse?: boolean } = {
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    coarse:
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)").matches
        : false,
  }
): boolean {
  if (env.coarse) return true;
  return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(env.ua ?? "");
}

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

// The web fallback is the one place an unvetted string reaches the browser as
// a navigation. `toAppUri` pins the hostname before it builds a URI, so it
// already returns null for `javascript:`/`data:` — but null is exactly what
// sends us here, so its soundness protects the app path and nothing else.
// Without this check, a card whose track URL is `javascript:…` (reachable by
// round-tripping your own crafted card through /api/adjust/stream, which
// echoes the card back) would execute on click. Anything that isn't plain
// http(s) does nothing at all: a broken tab is worse feedback than none.
function openWeb(webUrl: string) {
  let url: URL;
  try {
    url = new URL(webUrl, window.location.href);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  window.open(url.href, "_blank", "noopener,noreferrer");
}

// Call from a click handler BEFORE preventDefault(). Returns true when it took
// the click (desktop: the URI hand-off is running, the caller must
// preventDefault); false when the caller should let the native https anchor
// navigate (phones and webviews — see the header comment).
export function openInSpotify(webUrl: string): boolean {
  if (isTouchOrMobile()) return false;

  const uri = toAppUri(webUrl);
  if (!uri) {
    openWeb(webUrl);
    return true;
  }

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
  return true;
}
