// Eval step 3: aggregate a judged run into the metrics the harness exists to
// measure — per-outcome counts and rates (overall and split by Spotify
// resolution), evidence downgrades (see enforceVerdict in judge.ts), and
// error totals.
//
// Usage:
//   node evals/aggregate.ts                    # aggregate the latest run
//   node evals/aggregate.ts evals/runs/<ts>    # aggregate a specific run
//
// Prints a table and writes <run>/summary.json next to verdicts.json.

import fs from "node:fs";
import path from "node:path";
import { resolveRunDir, readJson, writeJson } from "./util.ts";
import { checkThresholds, renderChecks } from "./metrics.ts";

// A note's outcome is its classification, except for "specific-checkable"
// notes where the verification verdict takes over (prefixed, so "true" can't
// be mistaken for a boolean). Unknown values pass through literally — they
// get counted, not hidden.
const OUTCOME_ORDER = [
  "specific-true",
  "specific-invented",
  "specific-unverifiable",
  "specific-not-applicable",
  "specific-subjective",
  "generic",
  "missing",
];

const SPLITS = ["overall", "resolved", "unresolved", "unknown-resolution"];

function outcomeOf(note: any): string {
  if (note.classification === "specific-checkable") {
    return `specific-${note.verification}`;
  }
  return note.classification;
}

function splitOf(note: any): string {
  if (note.resolved) return "resolved";
  if (note.resolved === false) return "unresolved";
  return "unknown-resolution"; // null = notes-only run (no Spotify)
}

function rate(n: number, d: number): number | null {
  return d ? Number((n / d).toFixed(4)) : null;
}

function aggregateRun(runDir: string) {
  const verdictsPath = path.join(runDir, "verdicts.json");
  if (!fs.existsSync(verdictsPath)) {
    throw new Error(`No verdicts.json in ${runDir} — run judge.ts first`);
  }
  const verdicts = readJson(verdictsPath);
  const cardsPath = path.join(runDir, "cards.json");
  const cardEntries = fs.existsSync(cardsPath) ? readJson(cardsPath) : [];

  const judged = verdicts.filter((e: any) => e.notes);
  const judgeErrors = verdicts.filter((e: any) => !e.notes);

  const counts: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  for (const s of SPLITS) {
    counts[s] = {};
    totals[s] = 0;
  }
  const downgrades: { total: number; byReason: Record<string, number> } = {
    total: 0,
    byReason: {},
  };
  const bump = (obj: Record<string, number>, key: string) => {
    obj[key] = (obj[key] || 0) + 1;
  };

  for (const entry of judged) {
    for (const note of entry.notes) {
      const outcome = outcomeOf(note);
      for (const s of ["overall", splitOf(note)]) {
        bump(counts[s]!, outcome);
        totals[s]!++;
      }
      if (note.downgraded) {
        downgrades.total++;
        bump(downgrades.byReason, note.downgraded);
      }
    }
  }

  const rates: Record<string, Record<string, number | null>> = {};
  for (const s of SPLITS) {
    rates[s] = {};
    for (const [k, n] of Object.entries(counts[s]!)) rates[s]![k] = rate(n, totals[s]!);
  }

  // Checkable notes = every specific-* outcome except the subjective ones.
  const checkable = Object.entries(counts.overall!)
    .filter(([k]) => k.startsWith("specific-") && k !== "specific-subjective")
    .reduce((sum, [, n]) => sum + n, 0);
  const resolutionKnown = totals.resolved! + totals.unresolved!;

  return {
    runDir,
    generatedAt: new Date().toISOString(),
    cards: {
      prompts: cardEntries.length,
      generated: cardEntries.filter((c: any) => c.card).length,
      generateErrors: cardEntries.filter((c: any) => !c.card).length,
      judged: judged.length,
      judgeErrors: judgeErrors.length,
      judgeErrorIds: judgeErrors.map((e: any) => e.id),
    },
    notes: {
      total: totals.overall!,
      resolved: totals.resolved!,
      unresolved: totals.unresolved!,
      unknownResolution: totals["unknown-resolution"]!,
    },
    outcomes: counts,
    rates,
    headline: {
      checkableNotes: checkable,
      inventedRate: rate(counts.overall!["specific-invented"] || 0, checkable),
      verifiedTrueRate: rate(counts.overall!["specific-true"] || 0, checkable),
      unverifiableRate: rate(counts.overall!["specific-unverifiable"] || 0, checkable),
      genericRate: rate(counts.overall!.generic || 0, totals.overall!),
      resolutionRate: rate(totals.resolved!, resolutionKnown),
    },
    downgrades,
  };
}

// Why this run cannot be read as a measurement, or null if it can.
function noDataReason(s: any): string | null {
  if (!s.cards.prompts) return "no prompts in the run";
  if (!s.cards.judged) {
    return (
      `0 of ${s.cards.prompts} cards were judged ` +
      `(${s.cards.generateErrors} generate error(s), ${s.cards.judgeErrors} judge error(s))`
    );
  }
  if (!s.notes.total) return `${s.cards.judged} card(s) judged but 0 notes came back`;
  return null;
}

function pct(fraction: number | null | undefined): string {
  return fraction == null ? "—" : `${(fraction * 100).toFixed(1)}%`;
}

function renderSummary(s: any): string {
  const lines = [];
  const c = s.cards;
  lines.push(
    `Cards      : ${c.prompts} prompts | ${c.generated} generated (${c.generateErrors} errored) | ` +
      `${c.judged} judged (${c.judgeErrors} errored${c.judgeErrorIds.length ? `: ${c.judgeErrorIds.join(", ")}` : ""})`
  );
  lines.push(
    `Notes      : ${s.notes.total} total | ${s.notes.resolved} resolved | ${s.notes.unresolved} unresolved` +
      (s.notes.unknownResolution ? ` | ${s.notes.unknownResolution} unknown-resolution` : "")
  );
  lines.push("");

  // Known outcomes in a fixed order, anything unexpected appended after.
  const seen = Object.keys(s.outcomes.overall);
  const ordered = [
    ...OUTCOME_ORDER.filter((k) => seen.includes(k)),
    ...seen.filter((k) => !OUTCOME_ORDER.includes(k)).sort(),
  ];
  const cols = ["overall", "resolved", "unresolved"];
  if (s.notes.unknownResolution) cols.push("unknown-resolution");
  const denom: Record<string, number> = {
    overall: s.notes.total,
    resolved: s.notes.resolved,
    unresolved: s.notes.unresolved,
    "unknown-resolution": s.notes.unknownResolution,
  };

  const W0 = 26;
  const W = 20;
  lines.push("Outcome".padEnd(W0) + cols.map((col) => col.padStart(W)).join(""));
  lines.push("-".repeat(W0 + W * cols.length));
  for (const k of ordered) {
    const row = cols
      .map((col) => {
        const n = s.outcomes[col][k] || 0;
        return `${n}  (${pct(rate(n, denom[col]!))})`.padStart(W);
      })
      .join("");
    lines.push(k.padEnd(W0) + row);
  }
  lines.push("");

  const h = s.headline;
  lines.push(
    `Headline   : invented ${pct(h.inventedRate)} of checkable (${s.outcomes.overall["specific-invented"] || 0}/${h.checkableNotes}) | ` +
      `verified-true ${pct(h.verifiedTrueRate)} | unverifiable ${pct(h.unverifiableRate)}`
  );
  lines.push(
    `             generic ${pct(h.genericRate)} of all notes | resolution ${pct(h.resolutionRate)}`
  );
  const d = s.downgrades;
  lines.push(
    `Downgrades : ${d.total}` +
      (d.total
        ? ` (${Object.entries(d.byReason)
            .map(([k, n]) => `${k}: ${n}`)
            .join(", ")})`
        : "")
  );
  return lines.join("\n");
}

// Gates live in evals/thresholds.json, absent until a baseline run sets them.
// A missing or unparseable file means report-only — never a hard failure, so a
// config typo can't masquerade as a quality regression.
function loadThresholds(): Record<string, any> {
  try {
    return readJson(path.join(import.meta.dirname, "thresholds.json")).aggregate || {};
  } catch {
    return {};
  }
}

function main() {
  const runDir = resolveRunDir(process.argv.slice(2));
  console.log(`[aggregate] run dir: ${runDir}\n`);
  const summary = aggregateRun(runDir);
  console.log(renderSummary(summary));

  const checks = checkThresholds(summary, loadThresholds());
  console.log(`\n${renderChecks(checks)}`);

  const summaryPath = path.join(runDir, "summary.json");
  writeJson(summaryPath, { ...summary, checks });
  console.log(`\n[aggregate] wrote ${summaryPath}`);

  // Validity before quality. Every headline rate divides by a count of notes,
  // so a run where nothing was judged yields nulls everywhere — which the
  // threshold layer reports as "skipped", correctly per metric and disastrously
  // per run. That is exactly how the 2026-08-17 baseline exited 0 after
  // measuring nothing: 6 prompts in, 3 generate failures, 3 judge timeouts,
  // 0 notes, all rates null, four green stages. A run that measured nothing is
  // a failed run whatever the config says, so this is not a threshold.
  const reason = noDataReason(summary);
  if (reason) {
    console.error(`\n[aggregate] NO DATA: ${reason}`);
    console.error("[aggregate] nothing was measured — the rates above are absences, not results.");
    process.exit(1);
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

// Exported for evals/selftest.ts.
export { aggregateRun, renderSummary, noDataReason };
