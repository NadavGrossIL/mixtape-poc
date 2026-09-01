// The counters are the only record of how the deployed app is doing, and
// they are written from every hot path — so the failure that matters is a
// corrupt or unwritable file taking a route down with it, not an off-by-one.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeMetrics } from "../metrics.ts";

const dirs: string[] = [];

// One disposable directory and one instance per test: the dir and the clock
// are arguments now, so nothing leaks between cases and no test has to wait
// for real midnight to see a day roll over.
function fresh(day = "2026-08-15") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixtape-metrics-"));
  dirs.push(dir);
  let stamp = day;
  return {
    dir,
    file: path.join(dir, ".metrics.json"),
    metrics: makeMetrics({ dir, today: () => stamp }),
    setDay(next: string) {
      stamp = next;
    },
    // what a restart sees: a second instance reading the file this one wrote
    reopen: () => makeMetrics({ dir, today: () => stamp }),
  };
}

test("counts land on today's row and survive a round-trip through the file", () => {
  const { file, metrics, reopen } = fresh("2026-08-15");
  metrics.count("views");
  metrics.count("views");
  metrics.count("pressed", 3);
  metrics.flush();

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(onDisk["2026-08-15"]!.views, 2);
  assert.strictEqual(onDisk["2026-08-15"]!.pressed, 3);
  assert.strictEqual(onDisk["2026-08-15"]!.errors, 0);

  // a fresh instance re-reads from disk, then keeps counting on top of it
  const restarted = reopen();
  restarted.count("views");
  assert.strictEqual(restarted.recent().totals.views, 3);
  // the stamp rides along so no caller recomputes a UTC date
  assert.strictEqual(restarted.recent().today, "2026-08-15");
});

test("a corrupt file reads as no history instead of throwing", () => {
  const { file, dir } = fresh();
  fs.writeFileSync(file, "{not json");
  const metrics = makeMetrics({ dir, today: () => "2026-08-15" });
  assert.deepStrictEqual(metrics.recent().days, []);
  metrics.count("views");
  assert.strictEqual(metrics.recent().totals.views, 1);
});

test("junk keys and impossible numbers are dropped, not carried forward", () => {
  const { file, dir } = fresh();
  fs.writeFileSync(
    file,
    JSON.stringify({
      "2026-08-01": { views: 5, errors: -2, prompts: "nine", bogus: 1 },
      "not-a-day": { views: 100 },
    })
  );
  const { days, totals } = makeMetrics({ dir, today: () => "2026-08-15" }).recent();
  assert.strictEqual(days.length, 1);
  assert.strictEqual(days[0]!.day, "2026-08-01");
  assert.strictEqual(totals.views, 5);
  assert.strictEqual(totals.errors, 0); // negative → 0
  assert.strictEqual(totals.prompts, 0); // non-number → 0
  assert.ok(!("bogus" in days[0]!));
});

test("history is trimmed to the retained window when a new day opens", () => {
  const { file, dir } = fresh();
  const seeded: Record<string, unknown> = {};
  for (let i = 1; i <= 70; i++) {
    seeded[`2025-${String(Math.ceil(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`] =
      { views: 1 };
  }
  fs.writeFileSync(file, JSON.stringify(seeded));
  const metrics = makeMetrics({ dir, today: () => "2026-08-15" });
  const before = metrics.recent(1000).days.length;
  assert.ok(before > 60, `expected a seeded backlog, got ${before}`);
  metrics.count("views"); // opens today's row → triggers the trim
  assert.strictEqual(metrics.recent(1000).days.length, 60);
  // the newest days are the ones kept
  assert.strictEqual(metrics.recent(1).days[0]!.day, "2026-08-15");
});

test("recent(limit) totals cover exactly the window it returns", () => {
  const { file, dir } = fresh();
  fs.writeFileSync(
    file,
    JSON.stringify({
      "2026-08-01": { views: 1 },
      "2026-08-02": { views: 10 },
      "2026-08-03": { views: 100 },
    })
  );
  const metrics = makeMetrics({ dir, today: () => "2026-08-15" });
  assert.strictEqual(metrics.recent(2).totals.views, 110);
  assert.strictEqual(metrics.recent(30).totals.views, 111);
  assert.deepStrictEqual(
    metrics.recent(2).days.map((d) => d.day),
    ["2026-08-03", "2026-08-02"]
  );
});

test("counters roll to a new row when the day stamp advances", () => {
  const { metrics, setDay } = fresh("2026-08-15");
  metrics.count("views", 4);
  metrics.count("pressed");
  setDay("2026-08-16");
  metrics.count("views");

  const { today, days, totals } = metrics.recent();
  assert.strictEqual(today, "2026-08-16");
  assert.deepStrictEqual(
    days.map((d) => d.day),
    ["2026-08-16", "2026-08-15"]
  );
  assert.strictEqual(days[0]!.views, 1);
  assert.strictEqual(days[0]!.pressed, 0);
  // yesterday is closed, not amended
  assert.strictEqual(days[1]!.views, 4);
  assert.strictEqual(days[1]!.pressed, 1);
  assert.strictEqual(totals.views, 5);
});

test("an unwritable data dir warns once and keeps counting in memory", () => {
  const { dir, metrics } = fresh();
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: any) => warnings.push(String(msg));
  fs.chmodSync(dir, 0o500); // read+execute, no write
  try {
    metrics.count("views");
    metrics.flush(); // must not throw
    metrics.count("views");
    metrics.flush();
    assert.strictEqual(metrics.recent().totals.views, 2);
    assert.strictEqual(warnings.length, 1, `expected one warning, got ${warnings.length}`);
  } finally {
    console.warn = warn;
    fs.chmodSync(dir, 0o700);
  }
});

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
