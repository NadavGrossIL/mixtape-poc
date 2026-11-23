// Eval step 1: run every prompt through the real curator (and the Spotify
// resolver when tokens work) and persist the cards.
//
// Usage:
//   node evals/generate.ts                 # all prompts
//   node evals/generate.ts --limit 2       # pilot: first N prompts
//   node evals/generate.ts --only id1,id2  # specific prompt ids
//   node evals/generate.ts --prompts fit-prompts.json   # another case file
//   node evals/generate.ts --prompts jam-prompts.json   # jam mode cases (specs/0006)
//
// Writes evals/runs/<timestamp>/cards.json.

import path from "node:path";
import { loadServerEnv, newRunDir, readJson, writeJson, sleep } from "./util.ts";

loadServerEnv();

// Dynamic imports so server/.env is in process.env before the server modules
// evaluate (static ESM imports would hoist above loadServerEnv()).
// curator.ts holds the rules (MODEL, anthropicConfigured); the agent that runs
// them is the LangChain curator (server/lc/curator-lc.ts).
const base = await import("../server/curator.ts");
const curator = { ...base, generateCard: (await import("../server/lc/curator-lc.ts")).generateCard };
const spotify = await import("../server/spotify.ts");

const DELAY_MS = 1500;

function selectPrompts(argv: string[]): any[] {
  // --prompts picks another case file beside this one (fit-prompts.json: the
  // year-and-era set). A bare file name only — never a path out of evals/.
  const fileIdx = argv.indexOf("--prompts");
  const file = fileIdx !== -1 ? path.basename(argv[fileIdx + 1] || "") : "prompts.json";
  let prompts = readJson(path.join(import.meta.dirname, file));
  const onlyIdx = argv.indexOf("--only");
  if (onlyIdx !== -1) {
    const ids = new Set((argv[onlyIdx + 1] || "").split(","));
    prompts = prompts.filter((p: any) => ids.has(p.id));
  }
  const limitIdx = argv.indexOf("--limit");
  if (limitIdx !== -1) {
    prompts = prompts.slice(0, Number(argv[limitIdx + 1]) || prompts.length);
  }
  return prompts;
}

async function main() {
  if (!curator.anthropicConfigured()) {
    console.error("[generate] ANTHROPIC_API_KEY missing — check server/.env");
    process.exit(1);
  }

  const prompts = selectPrompts(process.argv.slice(2));
  if (!prompts.length) {
    console.error("[generate] no prompts selected");
    process.exit(1);
  }

  // Spotify resolution is a free co-metric — degrade gracefully without it.
  let spotifyOk = spotify.credentialsConfigured() && spotify.isLoggedIn();
  if (!spotifyOk) {
    console.warn("[generate] Spotify not configured/logged in — notes-only run");
  }

  const runDir = newRunDir();
  const cardsPath = path.join(runDir, "cards.json");
  console.log(`[generate] run dir: ${runDir}`);
  console.log(`[generate] ${prompts.length} prompts, model ${curator.MODEL}`);

  const results: any[] = [];
  for (const [i, p] of prompts.entries()) {
    console.log(`\n[generate] ${i + 1}/${prompts.length} (${p.id}): "${p.prompt}"`);
    let card;
    try {
      // a jam case (jam-prompts.json) carries mode: "jam"; every other case
      // calls exactly as before
      card = await curator.generateCard(p.prompt, p.mode ? { mode: p.mode } : undefined);
    } catch (err: any) {
      console.error(`[generate] ✗ curator failed for ${p.id}: ${err.message}`);
      results.push({ ...p, error: err.message });
      writeJson(cardsPath, results);
      await sleep(DELAY_MS);
      continue;
    }
    console.log(`[generate]   "${card.title}" — ${card.tracks.length} tracks`);

    let tracks = card.tracks.map((t: any) => ({ ...t, resolved: null }));
    if (spotifyOk) {
      try {
        tracks = await spotify.resolveTracks(card.tracks);
      } catch (err: any) {
        console.warn(`[generate] Spotify resolution failed (${err.message}) — continuing notes-only`);
        spotifyOk = false; // don't hammer a broken auth for the rest of the run
      }
    }

    // Persist the release_date the model was shown for each committed ref
    // (searchCatalog shows its first 4 chars as `year`). The search cache ages
    // past the run, so the run file itself must carry what the model saw —
    // evals/grounding.ts reads this to split judge-vs-metadata date
    // disagreements from real inventions.
    tracks = tracks.map((t: any) => ({
      ...t,
      shownReleaseDate: spotify.recallByRef(t.ref)?.album?.release_date ?? null,
    }));

    results.push({ ...p, card: { ...card, tracks } });
    writeJson(cardsPath, results); // incremental — a crash keeps prior cards
    if (i < prompts.length - 1) await sleep(DELAY_MS);
  }

  const ok = results.filter((r) => r.card).length;
  console.log(`\n[generate] done: ${ok}/${prompts.length} cards → ${cardsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
