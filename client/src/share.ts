// The share button's decision, kept out of the DOM so it can be unit-tested
// under Node (no DOM lib here): `share` and `copy` are the browser, injected.

export type ShareOutcome = "shared" | "dismissed" | "copied" | "failed";

export async function shareOrCopy(
  data: { title: string; url: string },
  deps: {
    share?: (d: { title: string; url: string }) => Promise<void>; // navigator.share, bound
    copy: (text: string) => Promise<void>; // clipboard write
  },
): Promise<ShareOutcome> {
  if (deps.share) {
    try {
      await deps.share(data);
      return "shared";
    } catch (e) {
      // The user closed the sheet: that is a choice, not a failure to fall back from.
      if ((e as { name?: unknown } | null)?.name === "AbortError") return "dismissed";
      // Anything else (payload refused, no user gesture): the user asked to
      // share, and a copied link is the nearest thing to that.
    }
  }
  try {
    await deps.copy(data.url);
    return "copied";
  } catch {
    // The clipboard can refuse (permissions, insecure context); the button
    // reports it rather than throwing into React's click handler.
    return "failed";
  }
}

// The link a share sends: this mixtape's own page on Mixtape (/m/<playlist
// id>, server/shares.ts), so the friend sees the card, not a bare Spotify
// URL. Anything that isn't a Spotify playlist link is passed through as is.
const PLAYLIST_URL_RE = /^https:\/\/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})(?:[?#/]|$)/;

export function shareUrlFor(spotifyUrl: string, origin: string): string {
  const m = PLAYLIST_URL_RE.exec(spotifyUrl);
  return m ? `${origin}/m/${m[1]}` : spotifyUrl;
}

// The playlist id when this page IS a share page, else null.
export function sharedIdFrom(pathname: string): string | null {
  const m = /^\/m\/([A-Za-z0-9]{22})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}
