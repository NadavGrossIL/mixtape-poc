// The description a pressed playlist carries on the host's public profile.
//
// It used to be the bare "Made with Mixtape." — every playlist looked the
// same in Spotify. Now it carries the card's vibe line: the one-line
// dedication the curator writes for the back of the sleeve, so the playlist
// reads like the card it came from.
//
// Never the prompt itself: the playlist sits on a public profile, and a
// prompt can be more personal than the person meant to publish. The vibe is
// a dedication, though, so a personal prompt can still put a name in it —
// that was accepted knowingly when this shipped (2026-11-21), and it is the
// same exposure the card's title already had.
//
// Like `title`, the vibe arrives in the request body, so this is the only
// thing between a client-controlled string and a public profile:
// - the "Made with Mixtape" prefix is load-bearing — spotify.ts's playlist
//   picker recognises the host's own mixtapes by it and hides them;
// - Spotify HTML-escapes `<` `>` into visible `&lt;` `&gt;`, so those go
//   (and `&` `'` are swapped for characters it leaves alone, see below),
//   along with control characters and the invisible ones that can reverse or
//   hide text (bidi overrides, zero-widths);
// - the cap is counted in characters, not UTF-16 units, so it never cuts an
//   emoji in half (a lone surrogate Spotify would reject or mangle); at its
//   maximum the whole description stays well inside Spotify's 300;
// - no vibe (an older client, Hermes) is the old description, unchanged.

export const DESCRIPTION_PREFIX = "Made with Mixtape";
// The curator is asked for ≤14 words (~100 characters); this is the ceiling
// for a client that sends something else.
export const VIBE_MAX = 150;

// The vibe line as it lands on the public profile, without the prefix — also
// what latest.ts shows on the front page, so the two can never disagree.
export function cleanVibe(vibe: unknown): string {
  const tidy = (typeof vibe === "string" ? vibe : "")
    .replace(/[\u0000-\u001f\u007f<>​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/[“”"]/g, "") // the card shows it in quotes; we add our own
    // Spotify stores `&` and `'` HTML-escaped and its share-preview tags
    // escape them again, so a shared link previewed as "Rock &amp; roll for
    // anyone who&#x27;s…" (seen live 2026-11-21); the page itself was fine.
    // Neither replacement below gets escaped.
    .replace(/'/g, "’")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(tidy).slice(0, VIBE_MAX).join("").trim();
}

export function playlistDescription(vibe: unknown): string {
  const line = cleanVibe(vibe);
  if (!line) return `${DESCRIPTION_PREFIX}.`;
  return `${DESCRIPTION_PREFIX} — “${line}”`;
}
