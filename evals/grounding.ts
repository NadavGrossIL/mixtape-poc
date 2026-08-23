// Eval diagnostic: were an invented note's year claims copied from the
// Spotify metadata the model was actually shown?
//
// The judge verifies against the web, the curator verifies against Spotify
// search rows ({ref, artist, title, album, year}), and those two sources
// disagree about what a track's "year" is whenever Spotify's album date is a
// reissue or compilation date. This step measures that disagreement
// deterministically, per invented note, by joining the track's ref to the
// exact search record the server fetched.
//
// Read the counts carefully: "grounded" means the model faithfully repeated
// the year it was shown — it does NOT exonerate the note. In the 2026-08-18
// baseline 5 of 18 invented notes were year-grounded, but for 2 of those the
// judge's invented verdict was about a different claim in the same note (a
// label credit, an artist credit), so the ceiling on judge-vs-metadata date
// disagreement was 3 notes, not 5. This is a diagnostic split, never a gate:
// the headline inventedRate keeps the judge's world-truth definition.
//
// Usage:
//   node evals/grounding.ts                    # latest run
//   node evals/grounding.ts evals/runs/<ts>    # specific run
//
// Shown-year source, in order: the track's shownReleaseDate (persisted by
// generate.ts at generation time — the reliable path), else a best-effort
// lookup of the track's ref in server/.search-cache.json (correct for a fresh
// run, increasingly unreliable as the cache ages past the run).

import fs from "node:fs";
import path from "node:path";
import { resolveRunDir, readJson } from "./util.ts";
// The canonical year extractor lives with the product's grounding gate — one
// regex for both, so gate and diagnostic can never drift apart. curator.ts is
// side-effect-free at module scope (see selftest.ts), so this import is safe.
import { extractYears } from "../server/curator.ts";

// One invented note's grounding status against the year the model was shown
// (searchCatalog shows release_date.slice(0, 4)).
//   no-year-in-note  — nothing for this check to say; the invention is elsewhere
//   unknown          — no shown year on record for this ref
//   grounded         — every asserted year is exactly the shown year
//   within-tolerance — every asserted year is within ±1 of the shown year but
//                      not all exact: the product gate's reissue-jitter window,
//                      kept distinct so "mismatch must stay 0" still gates on
//                      exact disagreement, not on years the gate allows
//   partial          — some asserted years are within ±1, some aren't
//   mismatch         — no asserted year is even within ±1: really invented
//
// Deliberately NOT here: the gate's title/album-name-year exclusion ("1979" by
// Smashing Pumpkins). This diagnostic joins only ref -> release_date, has no
// row name to check against, and a name-year surfacing as mismatch is exactly
// the disagreement it exists to report.
function groundNote(
  note: unknown,
  shownReleaseDate: unknown
): { status: string; noteYears: string[]; shownYear: string | null } {
  const noteYears = extractYears(note);
  const shownYear = shownReleaseDate
    ? String(shownReleaseDate).slice(0, 4)
    : null;
  let status;
  if (noteYears.length === 0) status = "no-year-in-note";
  else if (!shownYear) status = "unknown";
  else {
    const exact = noteYears.filter((y) => y === shownYear).length;
    const near = noteYears.filter(
      (y) => Math.abs(Number(y) - Number(shownYear)) <= 1
    ).length;
    status =
      exact === noteYears.length
        ? "grounded"
        : near === noteYears.length
          ? "within-tolerance"
          : near > 0
            ? "partial"
            : "mismatch";
  }
  return { status, noteYears, shownYear };
}

// Join verdicts to cards to shown metadata, for invented notes only.
// refDates: ref -> release_date, the fallback when tracks carry no
// shownReleaseDate (runs that predate generate.ts persisting it).
function groundRun(
  verdicts: any[],
  cardEntries: any[],
  refDates: Map<string, string>
): { rows: any[]; counts: Record<string, number> } {
  const cardById = new Map(
    cardEntries.filter((e: any) => e.card).map((e: any) => [e.id, e])
  );
  const rows: any[] = [];
  const counts: Record<string, number> = {};
  for (const entry of verdicts) {
    if (!entry.notes) continue;
    for (const note of entry.notes) {
      if (note.verification !== "invented") continue;
      const track = (cardById.get(entry.id) as any)?.card?.tracks?.[note.index];
      const shown =
        track?.shownReleaseDate ??
        (track?.ref ? refDates.get(track.ref) : undefined) ??
        null;
      const g = groundNote(note.note, shown);
      counts[g.status] = (counts[g.status] || 0) + 1;
      rows.push({
        id: entry.id,
        index: note.index,
        artist: note.artist,
        title: note.title,
        ref: track?.ref ?? null,
        ...g,
      });
    }
  }
  return { rows, counts };
}

// ref -> release_date out of the raw cache file. Raw on purpose: the server's
// loader drops entries past their TTL, but for grounding an expired record of
// what the model was shown is still the record.
function refDatesFromCache(cachePath: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return out; // no cache — every fallback lookup reports "unknown"
  }
  for (const entry of Object.values<any>(raw?.entries || {})) {
    for (const item of entry?.items || []) {
      const ref = String(item?.uri || "").split(":").pop();
      const date = item?.album?.release_date;
      if (ref && date) out.set(ref, String(date));
    }
  }
  return out;
}

function main() {
  const runDir = resolveRunDir(process.argv.slice(2));
  console.log(`[grounding] run dir: ${runDir}\n`);
  const verdicts = readJson(path.join(runDir, "verdicts.json"));
  const cards = readJson(path.join(runDir, "cards.json"));
  const refDates = refDatesFromCache(
    path.join(import.meta.dirname, "..", "server", ".search-cache.json")
  );

  const { rows, counts } = groundRun(verdicts, cards, refDates);
  for (const r of rows) {
    console.log(
      `${r.status.padEnd(15)} ${r.id}#${r.index} ${r.artist} — ${r.title}` +
        (r.noteYears.length
          ? `  (note: ${r.noteYears.join("/")}, shown: ${r.shownYear ?? "?"})`
          : "")
    );
  }
  const total = rows.length;
  console.log(
    `\n[grounding] ${total} invented note(s): ` +
      (total
        ? Object.entries(counts)
            .map(([k, n]) => `${k} ${n}`)
            .join(" | ")
        : "nothing to ground")
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

// Exported for evals/selftest.ts — pure logic only.
export { extractYears, groundNote, groundRun };
