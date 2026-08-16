// Reliability eval: how often does the curator commit a COMPLETE mixtape on
// its first try?
//
// Why this exists separately from generate/judge/aggregate: those measure
// whether the liner notes are true. This measures whether the agent obeys its
// own output contract — a different failure, and one the app deliberately
// hides. cardIncompleteReason hands a hollow commit back as a failed
// tool_result and the model fixes it on the next turn, so a regression here
// costs latency and tokens without ever surfacing a broken card. That is
// exactly the bug that shipped once already: with `tracks` as an array, a
// strict schema ignored minItems and the model closed the array after one
// exemplar track 6 times in 10. The fix (8 required keys — `required` IS
// compiled into the sampling grammar) took it to 0 in 10, but that number was
// measured by hand and never again. This script is that measurement, repeatable.
//
// Single runs prove nothing about a non-deterministic agent, so every prompt
// runs k trials and reports pass@k (ever clean) alongside pass^k (always
// clean). pass^k is the one that matters here: 6/10 was "usually fine" too.
//
// Usage:
//   node evals/reliability.ts                      # 3 prompts x 5 trials
//   node evals/reliability.ts --trials 10          # the original 10-run shape
//   node evals/reliability.ts --only app-fastest-rap --trials 10
//   node evals/reliability.ts --limit 6 --trials 3
//
// COSTS REAL TOKENS: prompts x trials live calls to the curator agent, each of
// which may make Spotify searches. Defaults are deliberately small.
//
// Writes evals/runs/<timestamp>/reliability.json + reliability-summary.json.

import path from "node:path";
import { loadServerEnv, newRunDir, readJson, writeJson, sleep, REPO_ROOT } from "./util.ts";
import { passAtK, passHatK, checkThresholds, renderChecks } from "./metrics.ts";

loadServerEnv();

// Dynamic import so server/.env is in process.env before the module evaluates
// (a static ESM import would hoist above loadServerEnv()).
const curator = await import("../server/curator.ts");

const DEFAULT_TRIALS = 5;
const DEFAULT_PROMPTS = 3;
const DELAY_MS = 1500;
const NO_REF = "none";

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] ?? null;
}

function selectPrompts(argv: string[]): any[] {
  let prompts = readJson(path.join(import.meta.dirname, "prompts.json"));
  const only = flag(argv, "only");
  if (only) {
    const ids = new Set(only.split(","));
    prompts = prompts.filter((p: any) => ids.has(p.id));
    return prompts;
  }
  const limit = Number(flag(argv, "limit")) || DEFAULT_PROMPTS;
  return prompts.slice(0, limit);
}

// One live call. Never throws — a failed trial is data, not a crash, and
// losing the trials already paid for would be the worst outcome here.
async function runTrial(prompt: string): Promise<any> {
  const commits: { attempt: number; gap: string | null }[] = [];
  const started = Date.now();
  try {
    const card = await curator.generateCard(prompt, {
      onCommit: (attempt, gap) => commits.push({ attempt, gap }),
    });
    const tracks = card.tracks || [];
    return {
      ok: true,
      commits,
      commitAttempts: commits.length,
      firstGap: commits[0]?.gap ?? null,
      cleanFirstCommit: commits.length > 0 && commits[0]!.gap === null,
      trackCount: tracks.length,
      refCount: tracks.filter((t: any) => t.ref && t.ref !== NO_REF).length,
      ms: Date.now() - started,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
      commits,
      commitAttempts: commits.length,
      firstGap: commits[0]?.gap ?? null,
      // A run that never produced a commit is not a clean first commit.
      cleanFirstCommit: commits.length > 0 && commits[0]!.gap === null,
      trackCount: 0,
      refCount: 0,
      ms: Date.now() - started,
    };
  }
}

// Pure over recorded trials — no I/O, so selftest.ts can pin the numbers.
function summarizeTrials(entries: any[], trials: number) {
  const perPrompt = entries.map((e: any) => {
    const n = e.trials.length;
    const clean = e.trials.filter((t: any) => t.cleanFirstCommit).length;
    const ok = e.trials.filter((t: any) => t.ok).length;
    return {
      id: e.id,
      category: e.category,
      trials: n,
      clean,
      succeeded: ok,
      cleanFirstCommitRate: n ? Number((clean / n).toFixed(4)) : null,
      passAtK: passAtK(n, clean, Math.min(trials, n)),
      passHatK: passHatK(n, clean, Math.min(trials, n)),
      gaps: e.trials.filter((t: any) => t.firstGap).map((t: any) => t.firstGap),
      errors: e.trials.filter((t: any) => !t.ok).map((t: any) => t.error),
    };
  });

  const all = entries.flatMap((e: any) => e.trials);
  const n = all.length;
  const clean = all.filter((t: any) => t.cleanFirstCommit).length;
  const ok = all.filter((t: any) => t.ok).length;
  const k = Math.min(trials, n || 1);
  const totalTracks = all.reduce((s: number, t: any) => s + t.trackCount, 0);
  const totalRefs = all.reduce((s: number, t: any) => s + t.refCount, 0);
  const attempts = all.reduce((s: number, t: any) => s + t.commitAttempts, 0);

  // Every distinct rejection reason, with counts — the "why" behind a breach.
  const gapCounts: Record<string, number> = {};
  for (const t of all) if (t.firstGap) gapCounts[t.firstGap] = (gapCounts[t.firstGap] || 0) + 1;

  return {
    model: curator.MODEL,
    trialsPerPrompt: trials,
    prompts: entries.length,
    overall: {
      trials: n,
      cleanFirstCommits: clean,
      cleanFirstCommitRate: n ? Number((clean / n).toFixed(4)) : null,
      successRate: n ? Number((ok / n).toFixed(4)) : null,
      passAtK: n ? passAtK(n, clean, k) : null,
      passHatK: n ? passHatK(n, clean, k) : null,
      k,
      meanCommitAttempts: n ? Number((attempts / n).toFixed(4)) : null,
      refRate: totalTracks ? Number((totalRefs / totalTracks).toFixed(4)) : null,
      meanMs: n ? Math.round(all.reduce((s: number, t: any) => s + t.ms, 0) / n) : null,
    },
    firstCommitGaps: gapCounts,
    perPrompt,
  };
}

function pct(f: number | null | undefined): string {
  return f == null ? "—" : `${(f * 100).toFixed(1)}%`;
}

function renderReliability(s: any): string {
  const o = s.overall;
  const lines = [
    `Model      : ${s.model}`,
    `Trials     : ${s.prompts} prompts x ${s.trialsPerPrompt} = ${o.trials} live runs ` +
      `(mean ${o.meanMs}ms)`,
    "",
    `First-commit clean : ${o.cleanFirstCommits}/${o.trials}  (${pct(o.cleanFirstCommitRate)})`,
    `  pass@${o.k}  (ever clean)   : ${pct(o.passAtK)}`,
    `  pass^${o.k}  (always clean) : ${pct(o.passHatK)}   <- the hollow-commit gate`,
    `Card returned      : ${pct(o.successRate)}`,
    `Commit attempts    : ${o.meanCommitAttempts} mean  (1.0 = never retried)`,
    `Tracks with a ref  : ${pct(o.refRate)}`,
    "",
  ];

  const gaps = Object.entries(s.firstCommitGaps);
  if (gaps.length) {
    lines.push("First-commit rejections:");
    for (const [reason, n] of gaps.sort((a, b) => (b[1] as number) - (a[1] as number))) {
      lines.push(`  ${String(n).padStart(3)}x  ${reason}`);
    }
  } else {
    lines.push("First-commit rejections: none — every commit was accepted first try.");
  }
  lines.push("");

  const W = 26;
  lines.push("Prompt".padEnd(W) + "clean".padStart(10) + "pass^k".padStart(10) + "  gaps");
  lines.push("-".repeat(W + 20 + 8));
  for (const p of s.perPrompt) {
    lines.push(
      p.id.slice(0, W - 1).padEnd(W) +
        `${p.clean}/${p.trials}`.padStart(10) +
        pct(p.passHatK).padStart(10) +
        (p.gaps.length ? `  ${p.gaps.length}` : "")
    );
  }
  return lines.join("\n");
}

function loadThresholds(): Record<string, any> {
  try {
    return readJson(path.join(import.meta.dirname, "thresholds.json")).reliability || {};
  } catch {
    return {};
  }
}

async function main() {
  if (!curator.anthropicConfigured()) {
    console.error("[reliability] ANTHROPIC_API_KEY missing — check server/.env");
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const trials = Number(flag(argv, "trials")) || DEFAULT_TRIALS;
  const prompts = selectPrompts(argv);
  if (!prompts.length) {
    console.error("[reliability] no prompts selected");
    process.exit(1);
  }

  const runDir = newRunDir();
  const outPath = path.join(runDir, "reliability.json");
  console.log(`[reliability] run dir: ${runDir}`);
  console.log(
    `[reliability] ${prompts.length} prompts x ${trials} trials = ` +
      `${prompts.length * trials} live curator runs, model ${curator.MODEL}`
  );

  const entries: any[] = [];
  for (const p of prompts) {
    const entry = { id: p.id, category: p.category, prompt: p.prompt, trials: [] as any[] };
    entries.push(entry);
    for (let t = 1; t <= trials; t++) {
      process.stdout.write(`[reliability] ${p.id} trial ${t}/${trials} ... `);
      const result = await runTrial(p.prompt);
      entry.trials.push(result);
      console.log(
        result.ok
          ? `${result.cleanFirstCommit ? "clean" : `RETRIED (${result.firstGap})`} ` +
              `${result.commitAttempts} attempt(s), ${result.refCount}/${result.trackCount} refs`
          : `ERROR ${result.error}`
      );
      writeJson(outPath, entries); // incremental — a crash keeps paid-for trials
      await sleep(DELAY_MS);
    }
  }

  const summary = summarizeTrials(entries, trials);
  console.log(`\n${renderReliability(summary)}\n`);

  const checks = checkThresholds(summary, loadThresholds());
  console.log(renderChecks(checks));

  const summaryPath = path.join(runDir, "reliability-summary.json");
  writeJson(summaryPath, { ...summary, checks });
  console.log(`\n[reliability] wrote ${path.relative(REPO_ROOT, summaryPath)}`);

  if (checks.some((c) => !c.ok)) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for evals/selftest.ts.
export { summarizeTrials, renderReliability };
