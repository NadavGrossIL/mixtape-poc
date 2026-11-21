// "Fresh off the press": the shelf of everyone's newest mixtapes on the home
// screen (server/latest.ts keeps them). Pure, no DOM — server/test runs it.

export type LatestMixtape = {
  id: string;
  title: string;
  vibe: string;
  url: string;
  pressedAt: number;
};

// rows on the shelf; the server keeps a few more so one hidden entry or this
// browser's own presses (already under "your mixtapes") don't empty it
export const LATEST_SHOWN = 5;

// What the shelf shows: the server's list minus anything this browser
// pressed — those are already one section up, and the same tape in two
// lists on one screen is noise.
export function shelfFor(
  latest: LatestMixtape[],
  ownUrls: string[],
  max: number = LATEST_SHOWN
): LatestMixtape[] {
  // by playlist id, not the raw string: a stored link may carry ?si= or a
  // locale prefix the server's rebuilt one doesn't
  const own = new Set(ownUrls.map(playlistIdOf));
  return latest.filter((m) => !own.has(m.id)).slice(0, max);
}

function playlistIdOf(url: string): string {
  return url.split("?")[0]!.split("/").filter(Boolean).pop() || url;
}

// "just now", "12 min ago", "3 h ago", "2 days ago". Coarse on purpose: the
// point is that real people are using it lately, not a timestamp.
export function pressedAgo(pressedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - pressedAt) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// The response is a network body; only well-formed rows with a Spotify
// https link come out, since `url` becomes an href.
export function parseLatestResponse(body: unknown): LatestMixtape[] {
  const list = (body as { mixtapes?: unknown } | null)?.mixtapes;
  if (!Array.isArray(list)) return [];
  const out: LatestMixtape[] = [];
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string" || typeof r.url !== "string") continue;
    if (!r.url.startsWith("https://open.spotify.com/playlist/")) continue;
    out.push({
      id: r.id,
      title: r.title,
      vibe: typeof r.vibe === "string" ? r.vibe : "",
      url: r.url,
      pressedAt: typeof r.pressedAt === "number" ? r.pressedAt : 0,
    });
  }
  return out;
}
