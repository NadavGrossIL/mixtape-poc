// The counters are the only record of how the deployed app is doing, and
// they are written from every hot path — so the failure that matters is a
// corrupt or unwritable file taking a route down with it, not an off-by-one.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR is read at import time; point it somewhere disposable first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixtape-metrics-"));
process.env.DATA_DIR = dir;
const metrics = await import("../metrics.ts");

const FILE = path.join(dir, ".metrics.json");
const today = new Date().toISOString().slice(0, 10);

function reload(): Record<string, Record<string, number>> {
  metrics.flush();
  metrics._reset();
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

test("counts land on today's row and survive a round-trip through the file", () => {
  fs.rmSync(FILE, { force: true });
  metrics._reset();
  metrics.count("views");
  metrics.count("views");
  metrics.count("pressed", 3);
  const onDisk = reload();
  assert.strictEqual(onDisk[today]!.views, 2);
  assert.strictEqual(onDisk[today]!.pressed, 3);
  assert.strictEqual(onDisk[today]!.errors, 0);
  // re-read from disk, then keep counting on top of the loaded row
  metrics.count("views");
  assert.strictEqual(metrics.recent().totals.views, 3);
});

test("a corrupt file reads as no history instead of throwing", () => {
  fs.writeFileSync(FILE, "{not json");
  metrics._reset();
  assert.deepStrictEqual(metrics.recent().days, []);
  metrics.count("views");
  assert.strictEqual(metrics.recent().totals.views, 1);
});

test("junk keys and impossible numbers are dropped, not carried forward", () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({
      "2026-08-01": { views: 5, errors: -2, prompts: "nine", bogus: 1 },
      "not-a-day": { views: 100 },
    })
  );
  metrics._reset();
  const { days, totals } = metrics.recent();
  assert.strictEqual(days.length, 1);
  assert.strictEqual(days[0]!.day, "2026-08-01");
  assert.strictEqual(totals.views, 5);
  assert.strictEqual(totals.errors, 0); // negative → 0
  assert.strictEqual(totals.prompts, 0); // non-number → 0
  assert.ok(!("bogus" in days[0]!));
});

test("history is trimmed to the retained window when a new day opens", () => {
  const seeded: Record<string, unknown> = {};
  for (let i = 1; i <= 70; i++) {
    seeded[`2025-${String(Math.ceil(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`] =
      { views: 1 };
  }
  fs.writeFileSync(FILE, JSON.stringify(seeded));
  metrics._reset();
  const before = metrics.recent(1000).days.length;
  assert.ok(before > 60, `expected a seeded backlog, got ${before}`);
  metrics.count("views"); // opens today's row → triggers the trim
  assert.strictEqual(metrics.recent(1000).days.length, 60);
  // the newest days are the ones kept
  assert.strictEqual(metrics.recent(1).days[0]!.day, today);
});

test("recent(limit) totals cover exactly the window it returns", () => {
  fs.writeFileSync(
    FILE,
    JSON.stringify({
      "2026-08-01": { views: 1 },
      "2026-08-02": { views: 10 },
      "2026-08-03": { views: 100 },
    })
  );
  metrics._reset();
  assert.strictEqual(metrics.recent(2).totals.views, 110);
  assert.strictEqual(metrics.recent(30).totals.views, 111);
  assert.deepStrictEqual(
    metrics.recent(2).days.map((d) => d.day),
    ["2026-08-03", "2026-08-02"]
  );
});

test("an unwritable data dir warns once and keeps counting in memory", () => {
  fs.rmSync(FILE, { force: true });
  metrics._reset();
  fs.chmodSync(dir, 0o500); // read+execute, no write
  try {
    metrics.count("views");
    metrics.flush(); // must not throw
    assert.strictEqual(metrics.recent().totals.views, 1);
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
