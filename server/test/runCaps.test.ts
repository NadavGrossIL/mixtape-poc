// A guest's day: each kind of run has its own allowance and is refused in
// its own words, one kind running out never blocks another, and the totals
// that bound the bill still hold whatever the kinds say.

import test from "node:test";
import assert from "node:assert";
import { guestTotal, makeRunCaps, type RunKind, type RunLimits } from "../runCaps.ts";

const DAY = "2026-11-23";
const limits: RunLimits = {
  guest: { mixtape: 2, refine: 2, replace: 5 },
  perAccount: 25,
  perIp: 20,
  allGuests: 50,
};

function spend(
  caps: ReturnType<typeof makeRunCaps>,
  user: string,
  kind: RunKind,
  ip = "1.1.1.1",
  day = DAY
) {
  const refusal = caps.refusal(user, ip, day, kind);
  if (!refusal) caps.count(user, ip, day, kind);
  return refusal;
}

test("a guest gets 2 mixtapes, 2 refines and 5 replaces, each on its own", () => {
  const caps = makeRunCaps(limits);
  for (const kind of ["mixtape", "refine", "replace"] as const) {
    for (let i = 0; i < limits.guest[kind]; i++) {
      assert.strictEqual(spend(caps, "anon:a", kind), null, `${kind} ${i + 1} refused`);
    }
    assert.ok(spend(caps, "anon:a", kind), `${kind} past the limit went through`);
  }
});

test("running out of replaces leaves refines working, and says so", () => {
  const caps = makeRunCaps(limits);
  for (let i = 0; i < 5; i++) spend(caps, "anon:a", "replace");
  assert.strictEqual(
    spend(caps, "anon:a", "replace"),
    "sorry, that’s your 5 replaces for today. you can still refine it, or save this mixtape."
  );
  assert.strictEqual(spend(caps, "anon:a", "refine"), null);
});

test("with both used up, the line only offers the save", () => {
  const caps = makeRunCaps(limits);
  for (let i = 0; i < 5; i++) spend(caps, "anon:a", "replace");
  for (let i = 0; i < 2; i++) spend(caps, "anon:a", "refine");
  assert.strictEqual(
    spend(caps, "anon:a", "refine"),
    "sorry, that’s your 2 refines for today. this mixtape is still yours to save."
  );
});

test("a refused refine with replaces left points at them", () => {
  const caps = makeRunCaps(limits);
  for (let i = 0; i < 2; i++) spend(caps, "anon:a", "refine");
  assert.strictEqual(
    spend(caps, "anon:a", "refine"),
    "sorry, that’s your 2 refines for today. you can still replace a song, or save this mixtape."
  );
});

test("the new-mixtape limit says come back tomorrow, in the singular when it is 1", () => {
  const caps = makeRunCaps(limits);
  spend(caps, "anon:a", "mixtape");
  spend(caps, "anon:a", "mixtape");
  assert.strictEqual(
    spend(caps, "anon:a", "mixtape"),
    "sorry, that’s your 2 new mixtapes for today. come back tomorrow for more."
  );
  const one = makeRunCaps({ ...limits, guest: { ...limits.guest, mixtape: 1 } });
  spend(one, "anon:b", "mixtape");
  assert.match(spend(one, "anon:b", "mixtape")!, /your 1 new mixtape for today/);
});

test("a refused run spends nothing", () => {
  // the third mixtape is refused, so it doesn't count against the network
  const tight = makeRunCaps({ ...limits, perIp: 3 });
  for (let i = 0; i < 3; i++) spend(tight, "anon:a", "mixtape");
  assert.strictEqual(spend(tight, "anon:b", "mixtape"), null);
});

test("fresh cookies from one network stop at the per-IP total", () => {
  const caps = makeRunCaps({ ...limits, perIp: 3 });
  for (let i = 0; i < 3; i++) assert.strictEqual(spend(caps, `anon:${i}`, "replace"), null);
  assert.strictEqual(
    spend(caps, "anon:fresh", "replace"),
    "that’s all for today from this network — come back tomorrow."
  );
  assert.strictEqual(spend(caps, "anon:fresh", "replace", "2.2.2.2"), null);
});

test("all guests together stop at the public ceiling", () => {
  const caps = makeRunCaps({ ...limits, allGuests: 2 });
  spend(caps, "anon:a", "mixtape", "1.1.1.1");
  spend(caps, "anon:b", "replace", "2.2.2.2");
  assert.match(spend(caps, "anon:c", "refine", "3.3.3.3")!, /all taken/);
});

test("a connected account has one total, whatever the kind", () => {
  const caps = makeRunCaps({ ...limits, perAccount: 3 });
  spend(caps, "user1", "mixtape");
  spend(caps, "user1", "mixtape");
  spend(caps, "user1", "mixtape"); // past the guest mixtape limit: accounts don't have one
  assert.match(spend(caps, "user1", "replace")!, /your 3 mixtapes and changes for today/);
});

test("a new day starts every allowance over", () => {
  const caps = makeRunCaps(limits);
  for (let i = 0; i < 2; i++) spend(caps, "anon:a", "mixtape");
  assert.ok(spend(caps, "anon:a", "mixtape"));
  assert.strictEqual(spend(caps, "anon:a", "mixtape", "1.1.1.1", "2026-11-24"), null);
});

test("the guest total adds every kind, for the press cap to derive from", () => {
  assert.strictEqual(guestTotal(limits), 9);
});
