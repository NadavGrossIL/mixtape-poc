// The daily caps are the only thing between a public URL and the bill —
// every limit must actually refuse, and a refusal must never count.

import test from "node:test";
import assert from "node:assert";
import { makeCaps } from "../caps.ts";

const DAY = "2026-08-25";
const limits = { perAccount: 3, perGuest: 2, perIp: 3, allGuests: 4 };

function spend(caps: ReturnType<typeof makeCaps>, user: string, ip: string, day = DAY) {
  const refusal = caps.refusal(user, ip, day);
  if (!refusal) caps.count(user, ip, day);
  return refusal;
}

test("a guest stops at the per-guest cap", () => {
  const caps = makeCaps(limits);
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), null);
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), null);
  assert.match(spend(caps, "anon:a", "1.1.1.1")!, /2\/day/);
});

test("new guest cookies from one IP share the IP cap", () => {
  const caps = makeCaps(limits);
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1"), null);
  assert.strictEqual(spend(caps, "anon:b", "1.1.1.1"), null);
  assert.strictEqual(spend(caps, "anon:c", "1.1.1.1"), null);
  assert.ok(spend(caps, "anon:d", "1.1.1.1")); // 4th cookie, same IP: refused
  assert.strictEqual(spend(caps, "anon:d", "2.2.2.2"), null); // other IP: fine
});

test("all guests together stop at the global cap, with the booked-out line", () => {
  const caps = makeCaps(limits);
  for (const [u, ip] of [["anon:a", "1.1.1.1"], ["anon:b", "2.2.2.2"], ["anon:c", "3.3.3.3"], ["anon:d", "4.4.4.4"]]) {
    assert.strictEqual(spend(caps, u!, ip!), null);
  }
  assert.match(spend(caps, "anon:e", "5.5.5.5")!, /fully booked/);
});

test("connected accounts have their own cap and never touch the guest pool", () => {
  const caps = makeCaps(limits);
  for (let i = 0; i < 3; i++) assert.strictEqual(spend(caps, "spotify-nadav", "1.1.1.1"), null);
  assert.match(spend(caps, "spotify-nadav", "1.1.1.1")!, /3\/day/);
  // the guest pool is untouched by those four calls
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(spend(caps, `anon:${i}`, `9.9.9.${i}`), null);
  }
});

test("a refusal does not count, and the day rolls over", () => {
  const caps = makeCaps(limits);
  spend(caps, "anon:a", "1.1.1.1");
  spend(caps, "anon:a", "1.1.1.1");
  for (let i = 0; i < 10; i++) caps.refusal("anon:a", "1.1.1.1", DAY); // hammering
  assert.strictEqual(spend(caps, "anon:b", "1.1.1.1"), null); // IP cap still has room: 2 used of 3
  assert.strictEqual(spend(caps, "anon:a", "1.1.1.1", "2026-08-26"), null); // tomorrow
});
