// A guest can find their presses again from this browser; storage that is
// empty, garbage or refusing never breaks the page; only Spotify links
// ever come back out as hrefs.

import test from "node:test";
import assert from "node:assert";
import {
  addRecent,
  loadRecent,
  parseRecent,
  RECENT_KEY,
  recordRecent,
  RECENT_MAX,
  saveRecent,
  type RecentMixtape,
  type StorageLike,
} from "../../client/src/recent.ts";

const A: RecentMixtape = {
  title: "late-night drive",
  url: "https://open.spotify.com/playlist/aaa",
  pressedAt: 1,
};
const B: RecentMixtape = {
  title: "sunday dishes",
  url: "https://open.spotify.com/playlist/bbb",
  pressedAt: 2,
};

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  const storage: StorageLike = {
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
  return { data, storage };
}

test("nothing stored means an empty list", () => {
  assert.deepStrictEqual(parseRecent(null), []);
  assert.deepStrictEqual(parseRecent(""), []);
});

test("garbage or a non-array in storage means an empty list", () => {
  assert.deepStrictEqual(parseRecent("{not json"), []);
  assert.deepStrictEqual(parseRecent('{"url":"https://open.spotify.com/playlist/x"}'), []);
});

test("only open.spotify.com https links survive a read", () => {
  const raw = JSON.stringify([
    { title: "x", url: "javascript:alert(1)", pressedAt: 1 },
    { title: "y", url: "http://open.spotify.com/playlist/y", pressedAt: 1 },
    { title: "z", url: "https://evil.example/playlist/z", pressedAt: 1 },
    { title: "w", url: 42, pressedAt: 1 },
    null,
    A,
  ]);
  assert.deepStrictEqual(parseRecent(raw), [A]);
});

test("a missing title or date is filled in, not dropped", () => {
  const raw = JSON.stringify([{ url: A.url }]);
  assert.deepStrictEqual(parseRecent(raw), [
    { title: "untitled mixtape", url: A.url, pressedAt: 0 },
  ]);
});

test("the newest press goes first", () => {
  assert.deepStrictEqual(addRecent([A], B), [B, A]);
});

test("pressing the same playlist again moves it to the top instead of repeating it", () => {
  const again = { ...A, pressedAt: 3 };
  assert.deepStrictEqual(addRecent([B, A], again), [again, B]);
});

test("the list keeps at most RECENT_MAX presses, dropping the oldest", () => {
  let list: RecentMixtape[] = [];
  for (let i = 0; i < RECENT_MAX + 3; i++) {
    list = addRecent(list, { title: `t${i}`, url: `https://open.spotify.com/playlist/${i}`, pressedAt: i });
  }
  assert.strictEqual(list.length, RECENT_MAX);
  assert.strictEqual(list[0]!.title, `t${RECENT_MAX + 2}`);
  assert.strictEqual(list.at(-1)!.title, "t3");
});

test("a saved list reads back the same", () => {
  const { storage, data } = fakeStorage();
  assert.strictEqual(saveRecent(() => storage, [B, A]), true);
  assert.ok(RECENT_KEY in data);
  assert.deepStrictEqual(loadRecent(() => storage), [B, A]);
});

test("storage that can't even be reached never throws (private mode)", () => {
  const unreachable = (): StorageLike => {
    throw new Error("SecurityError");
  };
  assert.deepStrictEqual(loadRecent(unreachable), []);
  assert.strictEqual(saveRecent(unreachable, [A]), false);
});

test("storage whose reads and writes throw never throws either", () => {
  const refusing: StorageLike = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepStrictEqual(loadRecent(() => refusing), []);
  assert.strictEqual(saveRecent(() => refusing, [A]), false);
});

test("a press in one tab doesn't erase another tab's press", () => {
  const { storage } = fakeStorage();
  // tab 1 and tab 2 both loaded an empty list; tab 1 presses A first
  recordRecent(() => storage, [], A);
  const tab2 = recordRecent(() => storage, [], B);
  assert.deepStrictEqual(tab2, [B, A]);
  assert.deepStrictEqual(loadRecent(() => storage), [B, A]);
});

test("with storage unreadable a press still keeps this visit's list", () => {
  const unreachable = (): StorageLike => {
    throw new Error("SecurityError");
  };
  assert.deepStrictEqual(recordRecent(unreachable, [A], B), [B, A]);
});
