// Aggregate usage counters — the funnel, day by day.
//
// usage.ts answers "which of my friends actually use this" (per person, and
// owner-only for that reason). This answers the other question: how many
// people saw the page, how many typed a prompt, how many got a card, how
// many pressed it into Spotify, and how often it broke. Counts only — no
// ids, no prompts, no per-person rows — so it stays cheap to keep and dull
// to leak.
//
// One row per day, last 60 days. A factory, not a singleton: the directory
// and the clock come in as arguments, so the module needs no server, no env
// and no wall clock to test (add-a-server-route.md §1 — caps.ts is the
// model). index.ts is the one place that decides where the file lives and
// when to flush on exit.
//
// Where the caller points `dir` is the whole persistence story: DATA_DIR
// when the host gives us a volume, else beside the code — which on
// Railway's ephemeral disk means the numbers reset with every redeploy,
// same as the tokens. Point DATA_DIR at a volume if the history matters,
// otherwise read these as "since the last deploy".

import fs from "node:fs";
import path from "node:path";
// The day stamp comes from caps.ts so there is exactly ONE definition of "a
// day" in the app. A second copy here would drift from the cap reset and the
// graph would disagree with the caps about where the day broke.
import { today as capsToday } from "./caps.ts";

// Days kept. Two months is longer than anyone will look back on a POC and
// still a file measured in kilobytes.
const RETAIN_DAYS = 60;

// Writes are coalesced: a burst of page views is one write, and losing the
// last second of counters to a hard kill costs nothing worth a fsync.
const FLUSH_MS = 1000;

// The funnel, in order, plus the two things that explain a drop in it.
type Metric =
  | "views" // a page load, from a browser that ran the app
  | "newVisitors" // ...that had never been here (no session cookie yet)
  | "prompts" // a generation accepted — someone typed and pressed
  | "generated" // ...that finished as a card
  | "adjusts" // a refine accepted
  | "pressed" // a playlist created on Spotify
  | "errors" // a route failed on someone
  | "capped"; // refused by a daily cap — a drop that isn't a bug

const METRICS: Metric[] = [
  "views",
  "newVisitors",
  "prompts",
  "generated",
  "adjusts",
  "pressed",
  "errors",
  "capped",
];

type Day = Record<Metric, number>;

function emptyDay(): Day {
  return Object.fromEntries(METRICS.map((m) => [m, 0])) as Day;
}

interface MetricsOptions {
  // directory the .metrics.json lives in
  dir: string;
  // day stamp; defaults to the app-wide one, injectable so a test can roll
  // the day over without waiting for midnight
  today?: () => string;
}

// Every instance owns its own file, counters and warn-once flag — two
// instances in one process (a test suite, say) can't scribble on each
// other's state.
function makeMetrics({ dir, today = capsToday }: MetricsOptions) {
  const metricsPath = path.join(dir, ".metrics.json");

  // Read-modify-write per event would be fine at generation rates but not at
  // page-view rates, so the counters live in memory and the file is a
  // snapshot of them. Loaded once, lazily, so constructing an instance
  // touches no disk until something is counted or read.
  let state: Record<string, Day> | null = null;
  let pending: NodeJS.Timeout | null = null;
  let warnedWriteFailure = false;

  function load(): Record<string, Day> {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
      state = parsed && typeof parsed === "object" ? sanitize(parsed) : {};
    } catch {
      state = {};
    }
    return state!;
  }

  function flush(): void {
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    if (!state) return;
    // temp-then-rename, like the token store and the usage ledger — a crash
    // mid-write must leave the old file, never a truncated one.
    try {
      const tmp = `${metricsPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      // Not redundant with the mode above: that applies on create only, so a
      // .tmp left by a crash under a wider umask is reused at its old mode.
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, metricsPath);
    } catch (err: any) {
      // A read-only or missing directory must not take the app down over
      // analytics. Say it once per instance and keep counting in memory.
      if (!warnedWriteFailure) {
        warnedWriteFailure = true;
        console.warn(`[metrics] can't write ${metricsPath}: ${err.message} — counting in memory only`);
      }
    }
  }

  function schedule(): void {
    if (pending) return;
    pending = setTimeout(flush, FLUSH_MS);
    // never hold the process open for a counter file
    pending.unref?.();
  }

  function count(metric: Metric, n = 1): void {
    const days = load();
    const day = today();
    if (!days[day]) {
      days[day] = emptyDay();
      evictOldDays(days);
    }
    days[day]![metric] += n;
    schedule();
  }

  // Newest day first. `limit` days back, totals over exactly that window so
  // the two numbers on screen can never disagree. `today` rides along
  // because it is the server's own day stamp: no caller has to recompute a
  // UTC date to know which row is today.
  function recent(limit = 30): { today: string; days: ({ day: string } & Day)[]; totals: Day } {
    const rows = Object.entries(load())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, limit)
      .map(([day, row]) => ({ day, ...row }));
    const totals = emptyDay();
    for (const row of rows) for (const m of METRICS) totals[m] += row[m];
    return { today: today(), days: rows, totals };
  }

  return { count, recent, flush };
}

// A hand-edited or half-written file must read as "no history", never as
// NaN arithmetic that then gets written back.
function sanitize(raw: Record<string, unknown>): Record<string, Day> {
  const out: Record<string, Day> = {};
  for (const [day, row] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !row || typeof row !== "object") continue;
    const clean = emptyDay();
    for (const m of METRICS) {
      const n = (row as Record<string, unknown>)[m];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) clean[m] = Math.floor(n);
    }
    out[day] = clean;
  }
  return out;
}

// Trim in place when the day rolls over, so the file can't grow forever on
// a long-lived instance.
function evictOldDays(days: Record<string, Day>): void {
  const keys = Object.keys(days).sort();
  for (const day of keys.slice(0, Math.max(0, keys.length - RETAIN_DAYS))) {
    delete days[day];
  }
}

export { makeMetrics, METRICS };
export type { Metric, Day };
