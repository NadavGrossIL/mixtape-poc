// The press cap guards the only paid route that skips the curator. Two things
// have to hold: it must actually refuse a flood, and it must never refuse a
// save that a legitimate generation already paid for.

import test from "node:test";
import assert from "node:assert";
import { makePressCaps, pressLimits, PRESS_HEADROOM, PRESS_REFUSAL } from "../pressCaps.ts";

const DAY = "2026-09-01";
const generate = { perAccount: 25, perGuest: 5, perIp: 10, allGuests: 12 };

function spend(caps: ReturnType<typeof makePressCaps>, user: string, ip: string, day = DAY) {
  const refusal = caps.refusal(user, ip, day);
  if (!refusal) caps.count(user, ip, day);
  return refusal;
}

test("press limits are never tighter than the generation limits they derive from", () => {
  for (const gen of [generate, { perAccount: 1, perGuest: 1, perIp: 1, allGuests: 1 }]) {
    const press = pressLimits(gen);
    for (const tier of ["perAccount", "perGuest", "perIp", "allGuests"] as const) {
      assert.ok(press[tier] > gen[tier], `${tier}: ${press[tier]} must exceed ${gen[tier]}`);
    }
  }
});

test("a guest can press every tape their generation cap let them make", () => {
  const caps = makePressCaps(generate);
  for (let i = 0; i < generate.perGuest; i++) {
    assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), null, `press ${i + 1} refused`);
  }
});

test("a flood from one cookie is refused once the headroom is gone", () => {
  const caps = makePressCaps(generate);
  for (let i = 0; i < generate.perGuest + PRESS_HEADROOM; i++) {
    assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), null);
  }
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), PRESS_REFUSAL);
});

test("fresh cookies from one IP cannot walk past the per-guest cap", () => {
  const caps = makePressCaps(generate);
  const ceiling = generate.perIp + PRESS_HEADROOM;
  for (let i = 0; i < ceiling; i++) {
    assert.strictEqual(spend(caps, `anon:${i}`, "1.1.1.1"), null);
  }
  assert.strictEqual(spend(caps, "anon:fresh", "1.1.1.1"), PRESS_REFUSAL);
  assert.strictEqual(spend(caps, "anon:fresh", "2.2.2.2"), null); // another IP is unaffected
});

test("all guests together stop at the global ceiling", () => {
  const caps = makePressCaps(generate);
  const ceiling = generate.allGuests + PRESS_HEADROOM;
  for (let i = 0; i < ceiling; i++) {
    assert.strictEqual(spend(caps, `anon:${i}`, `10.0.0.${i}`), null);
  }
  assert.strictEqual(spend(caps, "anon:late", "10.0.1.1"), PRESS_REFUSAL);
});

test("a refused press does not consume budget", () => {
  const caps = makePressCaps({ perAccount: 1, perGuest: 1, perIp: 9, allGuests: 9 });
  const ceiling = 1 + PRESS_HEADROOM;
  for (let i = 0; i < ceiling; i++) assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), null);
  for (let i = 0; i < 5; i++) assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), PRESS_REFUSAL);
  // the refusals above must not have eaten the IP or global budget
  assert.strictEqual(spend(caps, "anon:b", "1.1.1.1"), null);
});

test("the ledger rolls over at midnight", () => {
  const caps = makePressCaps(generate);
  for (let i = 0; i < generate.perGuest + PRESS_HEADROOM; i++) spend(caps, "anon:a", "1.1.1.1");
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), PRESS_REFUSAL);
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1", "2026-09-02"), null);
});
