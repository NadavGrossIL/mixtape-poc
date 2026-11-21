// Memory threads on the LangChain curator: a thread id comes back from the
// browser, so knowing one must never be enough to continue it, and the number
// kept must be bounded or the server's memory grows without end.

import test from "node:test";
import assert from "node:assert";
import { makeThreadBook } from "../lc/threads.ts";

test("only the visitor who made a thread owns it", () => {
  const book = makeThreadBook({ max: 10 });
  book.add("t1", "anon:alice");
  assert.equal(book.owns("t1", "anon:alice"), true);
  assert.equal(book.owns("t1", "anon:bob"), false, "knowing the id is not enough");
});

test("an unknown id, or something that is not an id, is owned by no one", () => {
  const book = makeThreadBook({ max: 10 });
  book.add("t1", "anon:alice");
  for (const id of ["t2", "", undefined, null, 7, { toString: () => "t1" }]) {
    assert.equal(book.owns(id, "anon:alice"), false, String(id));
  }
});

test("only the newest `max` threads are kept; the oldest is evicted", () => {
  const evicted: string[] = [];
  const book = makeThreadBook({ max: 2, onEvict: (id) => evicted.push(id) });
  book.add("t1", "a");
  book.add("t2", "a");
  book.add("t3", "a");
  assert.deepEqual(evicted, ["t1"]);
  assert.equal(book.owns("t1", "a"), false);
  assert.equal(book.size(), 2);
});

test("using a thread again makes it the newest", () => {
  const evicted: string[] = [];
  const book = makeThreadBook({ max: 2, onEvict: (id) => evicted.push(id) });
  book.add("t1", "a");
  book.add("t2", "a");
  book.add("t1", "a"); // adjusted again
  book.add("t3", "a");
  assert.deepEqual(evicted, ["t2"]);
  assert.equal(book.owns("t1", "a"), true);
});

test("a dropped thread is forgotten and its memory released once", () => {
  const evicted: string[] = [];
  const book = makeThreadBook({ max: 5, onEvict: (id) => evicted.push(id) });
  book.add("t1", "a");
  book.drop("t1");
  book.drop("t1");
  assert.equal(book.owns("t1", "a"), false);
  assert.deepEqual(evicted, ["t1"]);
});
