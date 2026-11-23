// A jam card's link row: where to go to play each song. Search URLs on the
// sites musicians already trust, built from the curator's own artist and
// title (never Spotify's matchedName), so a refined row needs no new data.
//
// Search URLs, not song pages: a search can't 404 when a site renames a page,
// and it needs no API key, no call from our server and no rate limit. We
// host, fetch and embed nothing; the visitor's browser opens the link
// (specs/0006-jam-session-set.md). Pure: unit-tested from
// server/test/jamLinks.test.ts.

export type JamSite = "chords" | "playalong" | "tabs" | "lyrics";

export interface JamLink {
  site: JamSite; // also what the jam_link_opened event sends
  label: string;
  // the site the link opens, named on the chip's tooltip and accessible name
  // so a tap never lands somewhere the visitor wasn't told about
  siteName: string;
  url: string;
}

// Release suffixes that break a chord-site search. Everything from the first
// match on is dropped: a " - …" tail or a "(…)"/"[…]" that names a release
// variant ("- 2009 Remaster", "- Original Version", "(Remastered 2009)",
// "[Acoustic Version]"), or a "(feat. …)"/"(ft. …)" credit. Seen live from
// Spotify: Harvest - 2009 Remaster, The Sound of Silence - Acoustic Version.
// A dash or bracket that names no variant ("Part 1 - The Beginning",
// "Song [Intro]") is part of the title and stays.
const VARIANT = String.raw`\b(?:remaster\w*|version|live|mono|stereo|mix|edit)\b`;
const SUFFIX_RE = new RegExp(String.raw` - (?=.*${VARIANT})| [([](?:feat\.|ft\.|[^)\]]*${VARIANT})`, "i");

// also the title a jam card prints: a setlist says "Take Me Home, Country
// Roads", not "… - Original Version"
export function cleanTitle(title: string): string {
  const m = SUFFIX_RE.exec(title);
  const clean = (m ? title.slice(0, m.index) : title).trim();
  return clean || title;
}

export function jamLinks({ artist, title }: { artist: string; title: string }): JamLink[] {
  const q = encodeURIComponent(`${artist} ${cleanTitle(title)}`);
  return [
    { site: "chords", label: "Chords", siteName: "Ultimate Guitar", url: `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}` },
    { site: "playalong", label: "Play along", siteName: "Chordify", url: `https://chordify.net/search/${q}` },
    { site: "tabs", label: "Tabs", siteName: "Songsterr", url: `https://www.songsterr.com/?pattern=${q}` },
    { site: "lyrics", label: "Lyrics", siteName: "Genius", url: `https://genius.com/search?q=${q}` },
  ];
}
