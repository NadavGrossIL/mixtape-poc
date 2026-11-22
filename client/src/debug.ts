// The server-log console is a learning-project debugging aid, not product UI.
//
// `?debug` has to outlive the OAuth round trip: /callback redirects to
// CLIENT_URL ("/" in production) and drops the query string, so connecting
// Spotify — the very thing the owner must do before the logs and funnel will
// answer them — used to take the button away again. Remembered for the tab,
// not the browser: a stray ?debug in a shared link shouldn't leave a debug
// control on a stranger's screen for good.
const DEBUG_KEY = "mixtape_debug";

function debugRequested(): boolean {
  if (typeof window === "undefined") return false;
  const inUrl = new URLSearchParams(window.location.search).has("debug");
  try {
    if (inUrl) window.sessionStorage.setItem(DEBUG_KEY, "1");
    return inUrl || window.sessionStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return inUrl; // private mode or storage blocked — the URL still works
  }
}

// whether the log console (and the home screen's connect note) shows
export const SHOW_LOGS = import.meta.env.DEV || debugRequested();
