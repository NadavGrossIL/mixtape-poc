// Year fit: did each track on a card come from the year or era the listener
// asked for? Scores cards generated from evals/fit-prompts.json, whose cases
// carry the answer key (`era: { from, to }`, original release years).
//
// Why this and not another notes metric. The owner's point, 2026-11-22: the
// liner notes are a side feature; the playlist is the product. A blind pilot
// that day (19 saved cards, 152 tracks, three independent checkers) found the
// one playlist fault that is both real and checkable: tracks from the wrong
// year. All five clear cases were confirmed by every checker, and four of
// them were tracks where Spotify showed the curator a reissue or album date
// ("Disease", October 2024, dated 2025 by its album). Superlatives and
// one-hit wonders were tried and dropped: the checkers could not agree.
//
// How a track is decided — two cheap sources, then a checker for the doubt:
//   1. `spotifyYear`: the album date the curator was shown (shownReleaseDate).
//   2. `mbYear`: the earliest release MusicBrainz lists for that artist+title.
//   Both inside the asked range -> "fit", decided here, no model.
//   Anything else -> "check": one of them is outside the range, or
//   MusicBrainz has no entry. Neither source may fail a track alone: in
//   the pilot MusicBrainz dated "Bohemian Rhapsody" 1985 and "Shape of You"
//   2015, and missed 11 of 16 Hebrew tracks. A "check" track is settled by a
//   web-searching checker (or a person) and read back from fit-checks.json.
//
// A miss is then split by cause, because the fix differs:
//   misled  — Spotify showed a year INSIDE the range; the search tool's fault.
//   ignored — Spotify showed a year OUTSIDE the range and it was picked
//             anyway; the prompt's fault.
//
// First run on the LangChain curator, 2026-11-22 (runs/2026-11-22T08-43-36-477Z,
// 10 prompts, 8 of them traps): 74 fit, 4 miss, 2 unsure of 80 — 94.9%. All
// four misses were "misled": a song released as a single the year before the
// album Spotify dates it by ("Diet Pepsi", "Training Season"). The Beatles,
// Taylor Swift, 60s soul and early-90s hip-hop traps came back clean.
//
// Fix considered and dropped that day, do not redo it blind: showing the
// curator the year inside the track's ISRC. It flagged 3 of the 4 misses but
// also 4 correct tracks (it is the year the code was REGISTERED, often the
// year before release; some distributors' codes carry no real year at all —
// a 2025 song read as 2020). The owner chose to leave the fault as it is.
//
// No thresholds: one 10-prompt run is not a baseline to set a gate from
// (.claude/rules/evals.md — never invent one).
//
// Usage:
//   node evals/fit.ts                      # latest run: look up, classify, write fit.json
//   node evals/fit.ts evals/runs/<ts>      # a specific run
//   node evals/fit.ts --offline            # no MusicBrainz calls; reuse fit.json's lookups
//   node evals/fit.ts --checks <file>      # checker verdicts from elsewhere
//
// Reads cards.json (+ fit.json, fit-checks.json if present); writes fit.json.
// MusicBrainz gets artist and track names only, one request a second.

import fs from "node:fs";
import path from "node:path";
import { resolveRunDir, readJson, writeJson, sleep } from "./util.ts";

type Era = { from: number | null; to: number | null };

function inRange(year: number | null, era: Era): boolean | null {
  if (year === null || !Number.isFinite(year)) return null;
  if (era.from !== null && year < era.from) return false;
  if (era.to !== null && year > era.to) return false;
  return true;
}

// Code may PASS a track; it may never fail one. See the header.
function classifyTrack(spotifyYear: number | null, mbYear: number | null, era: Era) {
  const s = inRange(spotifyYear, era);
  const m = inRange(mbYear, era);
  if (s === true && m === true) return { status: "fit", why: "both sources inside the range" };
  const why =
    s === false && m === false ? "both sources outside the range"
    : s === false ? "Spotify's date is outside the range"
    : m === false ? "MusicBrainz's date is outside the range"
    : m === null && s === null ? "no date from either source"
    : m === null ? "not found in MusicBrainz"
    : "no Spotify date on record";
  return { status: "check", why };
}

function yearOf(date: unknown): number | null {
  const y = Number(String(date ?? "").slice(0, 4));
  return Number.isInteger(y) && y > 1000 ? y : null;
}

// --- MusicBrainz --------------------------------------------------------------

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// "Happy - From …", "X (feat. Y)", "X - Remastered 2009" -> the bare song.
const bareTitle = (t: unknown) =>
  String(t ?? "").replace(/\s+-\s+.*$/, "").replace(/\s*[([][^)\]]*[)\]]/g, "").trim();
const lucene = (s: string) => s.replace(/(["\\])/g, "\\$1");

// Earliest first-release year among recordings whose title matches exactly.
// Pure: takes the API's `recordings` array, so the selftest can feed it.
function earliestYear(recordings: any[], title: string): number | null {
  const want = norm(bareTitle(title));
  const years = (recordings ?? [])
    .filter((r) => (r.score ?? 0) >= 85 && norm(bareTitle(r.title)) === want)
    .map((r) => yearOf(r["first-release-date"]))
    .filter((y): y is number => y !== null);
  return years.length ? Math.min(...years) : null;
}

const USER_AGENT = "playlist-year-check/0.1";

async function lookupYear(artist: string, title: string): Promise<number | null> {
  // The full credit first ("Tyler, The Creator" holds a comma of its own),
  // then the lead artist alone ("Mark Ronson, Bruno Mars").
  const artists = [artist, artist.split(",")[0]!.trim()].filter((a, i, all) => a && all.indexOf(a) === i);
  for (const a of artists) {
    const q = `recording:"${lucene(bareTitle(title))}" AND artist:"${lucene(a)}"`;
    const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=100&query=${encodeURIComponent(q)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      await sleep(1100);
      if (res.status === 503 || res.status === 429) continue;
      if (!res.ok) break;
      const year = earliestYear((await res.json()).recordings, title);
      if (year !== null) return year;
      break;
    }
  }
  return null;
}

// --- one run ------------------------------------------------------------------

const key = (id: string, n: number) => `${id}#${n}`;

// rows: one per track with its lookups. checks: checker verdicts keyed id#n,
// each { verdict: "fit" | "miss" | "unsure", fact?, source? }.
function summarizeFit(rows: any[], checks: Record<string, any> = {}) {
  const final = rows.map((r) => {
    if (r.status === "fit") return { ...r, verdict: "fit", decidedBy: "code" };
    const c = checks[key(r.id, r.n)];
    if (!c) return { ...r, verdict: "pending", decidedBy: null };
    const cause =
      c.verdict !== "miss" ? null : inRange(r.spotifyYear, r.era) === true ? "misled" : "ignored";
    return { ...r, verdict: c.verdict, decidedBy: "checker", fact: c.fact ?? null, source: c.source ?? null, cause };
  });
  const tally = (list: any[]) => {
    const n = (v: string) => list.filter((r) => r.verdict === v).length;
    const decided = n("fit") + n("miss");
    return {
      tracks: list.length,
      fit: n("fit"), miss: n("miss"), unsure: n("unsure"), pending: n("pending"),
      byCode: list.filter((r) => r.decidedBy === "code").length,
      // Over tracks with a verdict either way; unsure and pending are not
      // counted for or against. Empty -> null: "no data", never 0%.
      fitRate: decided ? n("fit") / decided : null,
      misled: list.filter((r) => r.cause === "misled").length,
      ignored: list.filter((r) => r.cause === "ignored").length,
    };
  };
  return {
    all: tally(final),
    traps: tally(final.filter((r) => r.trap)),
    plain: tally(final.filter((r) => !r.trap)),
    rows: final,
  };
}

function renderFit(run: string, s: ReturnType<typeof summarizeFit>): string {
  const pct = (x: number | null) => (x === null ? "no data" : `${(x * 100).toFixed(1)}%`);
  const line = (label: string, t: ReturnType<typeof summarizeFit>["all"]) =>
    `${label.padEnd(14)} ${String(t.tracks).padStart(4)} tracks | fit ${t.fit} · miss ${t.miss} · unsure ${t.unsure} · pending ${t.pending} | fit rate ` +
    // The pending tracks are exactly the doubtful ones, so a rate over the
    // rest would read 100% for any run. Say nothing until they are settled.
    (t.pending ? "not yet (checks pending)" : pct(t.fitRate));
  const out = [
    `Year fit — ${run}`,
    line("all", s.all),
    line("trap prompts", s.traps),
    line("plain prompts", s.plain),
    `decided by code: ${s.all.byCode} of ${s.all.tracks}`,
  ];
  if (s.all.miss) out.push(`misses: ${s.all.misled} misled by Spotify's date · ${s.all.ignored} picked despite it`);
  const show = s.rows.filter((r) => r.verdict !== "fit");
  if (show.length) {
    out.push("");
    for (const r of show) {
      const range = `${r.era.from ?? "…"}–${r.era.to ?? "…"}`;
      out.push(
        `  [${r.verdict}${r.cause ? "/" + r.cause : ""}] ${r.id} #${r.n} ${r.artist} — ${r.title}` +
          ` (asked ${range}; Spotify ${r.spotifyYear ?? "—"}, MusicBrainz ${r.mbYear ?? "—"})` +
          (r.fact ? `\n      ${r.fact}` : "")
      );
    }
  }
  if (s.all.pending) out.push("", `${s.all.pending} track(s) still need a checker — the fit rate is provisional.`);
  return out.join("\n");
}

// --- CLI ----------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const checksIdx = argv.indexOf("--checks");
  const checksArg = checksIdx !== -1 ? argv[checksIdx + 1] : null;
  // The value after --checks is a file, not the run dir.
  const runDir = resolveRunDir(argv.filter((_, i) => checksIdx === -1 || i !== checksIdx + 1));

  const entries: any[] = readJson(path.join(runDir, "cards.json"));
  const scored = entries.filter((e) => e.card && e.era);
  if (!scored.length) {
    console.error(`[fit] no card in ${runDir} has an era — generate with --prompts fit-prompts.json`);
    process.exit(1);
  }

  const fitPath = path.join(runDir, "fit.json");
  const prior: Record<string, any> = {};
  if (fs.existsSync(fitPath)) for (const r of readJson(fitPath).rows ?? []) prior[key(r.id, r.n)] = r;

  const rows: any[] = [];
  for (const e of scored) {
    for (const [i, t] of e.card.tracks.entries()) {
      const n = i + 1;
      const spotifyYear = yearOf(t.shownReleaseDate);
      const had = prior[key(e.id, n)];
      let mbYear: number | null = had?.mbYear ?? null;
      if (!had && !offline) {
        mbYear = await lookupYear(String(t.artist ?? ""), String(t.title ?? ""));
        console.log(`[fit] ${e.id} #${n} ${t.artist} — ${t.title}: Spotify ${spotifyYear ?? "—"}, MusicBrainz ${mbYear ?? "—"}`);
      }
      rows.push({
        id: e.id, n, trap: Boolean(e.trap), era: e.era,
        artist: t.artist, title: t.title, spotifyYear, mbYear,
        ...classifyTrack(spotifyYear, mbYear, e.era),
      });
    }
  }

  const checksPath = checksArg ? path.resolve(checksArg) : path.join(runDir, "fit-checks.json");
  const checks: Record<string, any> = {};
  if (fs.existsSync(checksPath)) for (const c of readJson(checksPath)) checks[key(c.id, c.n)] = c;

  const summary = summarizeFit(rows, checks);
  writeJson(fitPath, summary);
  console.log("\n" + renderFit(path.basename(runDir), summary));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { inRange, classifyTrack, earliestYear, summarizeFit, renderFit, yearOf };
