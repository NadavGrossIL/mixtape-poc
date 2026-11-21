// The front-page shelf lists only what a public playlist already shows, stays
// small, survives a restart, lets the owner hide an entry, and never turns a
// corrupt file into a crash or a non-Spotify href.

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeLatest, makeVouches, parseLatest, LATEST_KEEP } from "../latest.ts";
import { shelfFor, pressedAgo, parseLatestResponse } from "../../client/src/latest.ts";

const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mixtape-latest-"));
  dirs.push(dir);
  let t = 1000;
  const now = () => t++;
  return { dir, latest: makeLatest({ dir, now }), reopen: () => makeLatest({ dir, now }) };
}

// 22-char Spotify ids
const id = (n: number) => `p${String(n).padStart(21, "0")}`;

test("records newest first with a link rebuilt from the id", () => {
  const { latest } = fresh();
  latest.record({ id: id(1), title: "late drive", vibe: "for the long way home" });
  latest.record({ id: id(2), title: "sunday dishes", vibe: "" });
  const list = latest.list();
  assert.deepStrictEqual(
    list.map((m) => m.title),
    ["sunday dishes", "late drive"]
  );
  assert.strictEqual(list[1]!.url, `https://open.spotify.com/playlist/${id(1)}`);
  assert.strictEqual(list[0]!.vibe, "");
});

test("keeps only the newest LATEST_KEEP", () => {
  const { latest } = fresh();
  for (let i = 0; i < LATEST_KEEP + 5; i++) latest.record({ id: id(i), title: `t${i}`, vibe: "" });
  const list = latest.list();
  assert.strictEqual(list.length, LATEST_KEEP);
  assert.strictEqual(list[0]!.title, `t${LATEST_KEEP + 4}`);
});

test("survives a restart", () => {
  const { latest, reopen } = fresh();
  latest.record({ id: id(1), title: "a", vibe: "v" });
  assert.deepStrictEqual(reopen().list(), latest.list());
});

test("hide removes one entry and reports whether it did", () => {
  const { latest, reopen } = fresh();
  latest.record({ id: id(1), title: "keep", vibe: "" });
  latest.record({ id: id(2), title: "ugly", vibe: "" });
  assert.strictEqual(latest.hide(id(2)), true);
  assert.strictEqual(latest.hide(id(2)), false);
  assert.strictEqual(latest.hide("nonsense"), false);
  assert.deepStrictEqual(reopen().list().map((m) => m.title), ["keep"]);
});

test("a bad id is never recorded", () => {
  const { latest } = fresh();
  latest.record({ id: "javascript:alert(1)", title: "x", vibe: "" });
  latest.record({ id: "", title: "x", vibe: "" });
  assert.deepStrictEqual(latest.list(), []);
});

test("a corrupt or hostile file reads as an empty or cleaned shelf", () => {
  const { dir, reopen } = fresh();
  fs.writeFileSync(path.join(dir, ".latest.json"), "{not json");
  assert.deepStrictEqual(reopen().list(), []);
  assert.deepStrictEqual(parseLatest({ nope: 1 }), []);
  const cleaned = parseLatest([
    { id: id(1), title: "ok", vibe: 3, pressedAt: 5, url: "javascript:alert(1)" },
    { id: id(1), title: "dupe", pressedAt: 4 },
    { id: "short", title: "bad id", pressedAt: 6 },
    { id: id(2), title: "", pressedAt: 7 },
    { id: id(3), title: "no time" },
  ]);
  assert.deepStrictEqual(cleaned, [
    { id: id(1), title: "ok", vibe: "", url: `https://open.spotify.com/playlist/${id(1)}`, pressedAt: 5 },
  ]);
});

test("an unwritable directory keeps the shelf in memory", () => {
  const latest = makeLatest({ dir: path.join(os.tmpdir(), "mixtape-no-such-dir", "deeper") });
  latest.record({ id: id(1), title: "a", vibe: "" });
  assert.strictEqual(latest.list().length, 1);
});

// ── client side: client/src/latest.ts ──

test("the shelf leaves out this browser's own presses and caps at max", () => {
  const rows = [1, 2, 3, 4].map((n) => ({
    id: id(n),
    title: `t${n}`,
    vibe: "",
    url: `https://open.spotify.com/playlist/${id(n)}`,
    pressedAt: n,
  }));
  const shelf = shelfFor(rows, [`${rows[0]!.url}?si=abc`], 10, 2);
  assert.deepStrictEqual(shelf.map((m) => m.title), ["t2", "t3"]);
});

test("pressedAgo is coarse and never negative", () => {
  const now = 10 * 86_400_000;
  assert.strictEqual(pressedAgo(now + 5000, now), "just now");
  assert.strictEqual(pressedAgo(now - 30_000, now), "just now");
  assert.strictEqual(pressedAgo(now - 12 * 60_000, now), "12 min ago");
  assert.strictEqual(pressedAgo(now - 3 * 3_600_000, now), "3 h ago");
  assert.strictEqual(pressedAgo(now - 30 * 3_600_000, now), "yesterday");
  assert.strictEqual(pressedAgo(now - 3 * 86_400_000, now), "3 days ago");
});

test("only Spotify playlist links come out of the response", () => {
  const ok = { id: id(1), title: "a", vibe: "v", url: `https://open.spotify.com/playlist/${id(1)}`, pressedAt: 1 };
  assert.deepStrictEqual(
    parseLatestResponse({
      mixtapes: [ok, { ...ok, url: "javascript:alert(1)" }, { ...ok, title: 5 }, null],
    }),
    [ok]
  );
  assert.deepStrictEqual(parseLatestResponse(null), []);
  assert.deepStrictEqual(parseLatestResponse({ mixtapes: "x" }), []);
});

test("the shelf drops entries older than a week", () => {
  const day = 86_400_000;
  const now = 30 * day;
  const row = (n: number, age: number) => ({
    id: id(n),
    title: `t${n}`,
    vibe: "",
    url: `https://open.spotify.com/playlist/${id(n)}`,
    pressedAt: now - age,
  });
  assert.deepStrictEqual(
    shelfFor([row(1, day), row(2, 6 * day), row(3, 8 * day)], [], now).map((m) => m.title),
    ["t1", "t2"]
  );
});

test("vouches remember curated cards and forget the oldest past the cap", () => {
  const v = makeVouches(2);
  v.add("a");
  v.add("b");
  assert.ok(v.has("a") && v.has("b"));
  assert.ok(!v.has("forged"));
  v.add("a"); // refreshed: now b is oldest
  v.add("c");
  assert.ok(v.has("a") && v.has("c") && !v.has("b"));
});
