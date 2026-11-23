// jamLinks: the jam card's link row is four search URLs on the right hosts,
// in a fixed order, with artist and title only ever percent-encoded, and a
// release suffix stripped from the title so a chord-site search still hits.

import test from "node:test";
import assert from "node:assert";
import { jamLinks } from "../../client/src/jamLinks.ts";

const HOSTS = {
  chords: "www.ultimate-guitar.com",
  playalong: "chordify.net",
  tabs: "www.songsterr.com",
  lyrics: "genius.com",
};

// The search text a link carries, read back the way the site will.
function searchedFor(url: string): string {
  const u = new URL(url);
  if (u.host === HOSTS.chords) return u.searchParams.get("value")!;
  if (u.host === HOSTS.playalong) return decodeURIComponent(u.pathname.replace(/^\/search\//, ""));
  if (u.host === HOSTS.tabs) return u.searchParams.get("pattern")!;
  return u.searchParams.get("q")!;
}

test("four links, in order, each on its own site over https", () => {
  const links = jamLinks({ artist: "Bob Marley & The Wailers", title: "Three Little Birds" });
  assert.deepStrictEqual(
    links.map((l) => [l.site, l.label]),
    [
      ["chords", "Chords"],
      ["playalong", "Play along"],
      ["tabs", "Tabs"],
      ["lyrics", "Lyrics"],
    ]
  );
  for (const l of links) {
    const u = new URL(l.url);
    assert.equal(u.protocol, "https:");
    assert.equal(u.host, HOSTS[l.site]);
  }
});

test("the exact URL templates", () => {
  const [chords, playalong, tabs, lyrics] = jamLinks({ artist: "Bob Marley & The Wailers", title: "Three Little Birds" });
  const q = "Bob%20Marley%20%26%20The%20Wailers%20Three%20Little%20Birds";
  assert.equal(chords!.url, `https://www.ultimate-guitar.com/search.php?search_type=title&value=${q}`);
  assert.equal(playalong!.url, `https://chordify.net/search/${q}`);
  assert.equal(tabs!.url, `https://www.songsterr.com/?pattern=${q}`);
  assert.equal(lyrics!.url, `https://genius.com/search?q=${q}`);
});

test("artist and title appear only percent-encoded: & as %26, spaces as %20", () => {
  for (const l of jamLinks({ artist: "Bob Marley & The Wailers", title: "Three Little Birds" })) {
    assert.ok(l.url.includes("%26"), l.url);
    assert.ok(l.url.includes("%20"), l.url);
    assert.ok(!l.url.includes(" "), l.url);
    assert.ok(!l.url.includes("Bob Marley"), l.url);
    assert.ok(!l.url.includes("& The"), l.url);
    assert.equal(searchedFor(l.url), "Bob Marley & The Wailers Three Little Birds");
  }
});

test("release suffixes are stripped from the title", () => {
  const cases: [string, string][] = [
    ["Here Comes the Sun - Remastered 2019", "Here Comes the Sun"],
    ["Señorita (feat. X)", "Señorita"],
    ["Wonderwall - Live at Knebworth", "Wonderwall"],
    ["Let It Be - Mono", "Let It Be"],
    ["Hey Jude - Stereo Mix", "Hey Jude"],
    ["Stay (ft. Someone)", "Stay"],
    ["Jolene [Acoustic Version]", "Jolene"],
    ["Here Comes The Sun - REMASTER", "Here Comes The Sun"],
    // seen live from Spotify on 2026-11-23
    ["Harvest - 2009 Remaster", "Harvest"],
    ["The Sound of Silence - Acoustic Version", "The Sound of Silence"],
    ["Take Me Home, Country Roads - Original Version", "Take Me Home, Country Roads"],
    ["Wonderwall - Remastered", "Wonderwall"],
    ["Yesterday (Remastered 2009)", "Yesterday"],
  ];
  for (const [title, clean] of cases) {
    for (const l of jamLinks({ artist: "A", title })) assert.equal(searchedFor(l.url), `A ${clean}`, title);
  }
});

test("a bracket that is not a Version is kept", () => {
  for (const l of jamLinks({ artist: "A", title: "Song [Intro]" })) assert.equal(searchedFor(l.url), "A Song [Intro]");
});

test("a dash that names no release variant is part of the title", () => {
  for (const l of jamLinks({ artist: "A", title: "Part 1 - The Beginning" }))
    assert.equal(searchedFor(l.url), "A Part 1 - The Beginning");
});

test("a title that cleans to nothing falls back to the raw title", () => {
  for (const l of jamLinks({ artist: "A", title: " - Live" })) assert.equal(searchedFor(l.url), "A  - Live");
});

test("the artist is used as given", () => {
  for (const l of jamLinks({ artist: "Artist - Live", title: "Song" })) assert.equal(searchedFor(l.url), "Artist - Live Song");
});
