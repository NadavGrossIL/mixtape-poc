// Eval step 1: run every prompt through the real curator (and the Spotify
// resolver when tokens work) and persist the cards.
//
// Usage:
//   node evals/generate.js                 # all prompts
//   node evals/generate.js --limit 2       # pilot: first N prompts
//   node evals/generate.js --only id1,id2  # specific prompt ids
//
// Writes evals/runs/<timestamp>/cards.json.

const path = require("path");
const { loadServerEnv, newRunDir, readJson, writeJson, sleep } = require("./util");

loadServerEnv();

const curator = require(path.join(__dirname, "..", "server", "curator"));
const spotify = require(path.join(__dirname, "..", "server", "spotify"));

const DELAY_MS = 1500;

function selectPrompts(argv) {
  let prompts = readJson(path.join(__dirname, "prompts.json"));
  const onlyIdx = argv.indexOf("--only");
  if (onlyIdx !== -1) {
    const ids = new Set((argv[onlyIdx + 1] || "").split(","));
    prompts = prompts.filter((p) => ids.has(p.id));
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

  const results = [];
  for (const [i, p] of prompts.entries()) {
    console.log(`\n[generate] ${i + 1}/${prompts.length} (${p.id}): "${p.prompt}"`);
    let card;
    try {
      card = await curator.generateCard(p.prompt);
    } catch (err) {
      console.error(`[generate] ✗ curator failed for ${p.id}: ${err.message}`);
      results.push({ ...p, error: err.message });
      writeJson(cardsPath, results);
      await sleep(DELAY_MS);
      continue;
    }
    console.log(`[generate]   "${card.title}" — ${card.tracks.length} tracks`);

    let tracks = card.tracks.map((t) => ({ ...t, resolved: null }));
    if (spotifyOk) {
      try {
        tracks = await spotify.resolveTracks(card.tracks);
      } catch (err) {
        console.warn(`[generate] Spotify resolution failed (${err.message}) — continuing notes-only`);
        spotifyOk = false; // don't hammer a broken auth for the rest of the run
      }
    }

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
