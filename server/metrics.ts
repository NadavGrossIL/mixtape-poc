// Aggregate usage counters — the funnel, day by day.
//
// usage.ts answers "which of my friends actually use this" (per person, and
// owner-only for that reason). This answers the other question: how many
// people saw the page, how many typed a prompt, how many got a card, how
// many pressed it into Spotify, and how often it broke. Counts only — no
// ids, no prompts, no per-person rows — so it stays cheap to keep and dull
// to leak.
//
// One row per day, last 60 days. It lives in DATA_DIR when the host gives
// us a volume, else beside the code — which on Railway's ephemeral disk
// means the numbers reset with every redeploy, same as the tokens. That is
// the whole persistence story: point DATA_DIR at a volume if the history
// matters, otherwise read these as "since the last deploy".

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || import.meta.dirname;
const METRICS_PATH = path.join(DATA_DIR, ".metrics.json");

// Days kept. Two months is longer than anyone will look back on a POC and
// still a file measured in kilobytes.
const RETAIN_DAYS = 60;

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

// UTC, matching caps.ts's `today()` — one definition of "a day" across the
// app, or the cap resets and the graph would disagree about where the day
// broke.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Read-modify-write per event would be fine at generation rates but not at
// page-view rates, so the counters live in memory and the file is a
// snapshot of them. Loaded once, lazily, so importing this module in a test
// touches no disk until something is counted.
let state: Record<string, Day> | null = null;

function load(): Record<string, Day> {
  if (state) return state;
  try {
    const parsed = JSON.parse(fs.readFileSync(METRICS_PATH, "utf8"));
    state = parsed && typeof parsed === "object" ? sanitize(parsed) : {};
  } catch {
    state = {};
  }
  return state!;
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

// Writes are coalesced: a burst of page views is one write, and losing the
// last second of counters to a hard kill costs nothing worth a fsync.
let pending: NodeJS.Timeout | null = null;
const FLUSH_MS = 1000;

function flush(): void {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  if (!state) return;
  // temp-then-rename, like the token store and the usage ledger — a crash
  // mid-write must leave the old file, never a truncated one.
  try {
    const tmp = `${METRICS_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, METRICS_PATH);
  } catch (err: any) {
    // A read-only or missing DATA_DIR must not take the app down over
    // analytics. Say it once per boot and keep counting in memory.
    if (!warnedWriteFailure) {
      warnedWriteFailure = true;
      console.warn(`[metrics] can't write ${METRICS_PATH}: ${err.message} — counting in memory only`);
    }
  }
}

let warnedWriteFailure = false;

function schedule(): void {
  if (pending) return;
  pending = setTimeout(flush, FLUSH_MS);
  // never hold the process open for a counter file
  pending.unref?.();
}

// Trim in place when the day rolls over, so the file can't grow forever on
// a long-lived instance.
function evictOldDays(days: Record<string, Day>): void {
  const keys = Object.keys(days).sort();
  for (const day of keys.slice(0, Math.max(0, keys.length - RETAIN_DAYS))) {
    delete days[day];
  }
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
// the two numbers on screen can never disagree.
function recent(limit = 30): { days: ({ day: string } & Day)[]; totals: Day } {
  const rows = Object.entries(load())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, limit)
    .map(([day, row]) => ({ day, ...row }));
  const totals = emptyDay();
  for (const row of rows) for (const m of METRICS) totals[m] += row[m];
  return { days: rows, totals };
}

// Tests only: forget the in-memory state so the next call re-reads the file.
function _reset(): void {
  state = null;
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
}

// Clean exits (Ctrl-C in dev, a graceful stop) shouldn't drop the last
// second. A SIGKILL still can; that is the trade the debounce buys.
process.on("exit", flush);

export type { Metric, Day };
export { count, recent, flush, METRICS_PATH, METRICS, _reset };
