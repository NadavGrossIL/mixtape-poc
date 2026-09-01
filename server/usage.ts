// Who has been using the app — visible to the owner only (the routes that
// read this are locked to the owner's Spotify identity in index.ts).
//
// Persisted next to the tokens so a server restart doesn't forget; on the
// ephemeral deploy disk it resets with each redeploy, same as the tokens —
// good enough for "which of my friends actually use this".

import fs from "node:fs";
import path from "node:path";

const USAGE_PATH = path.join(import.meta.dirname, ".usage.json");

type UsageEvent = "login" | "generation" | "adjust" | "save";

interface UsageRecord {
  name: string | null;
  firstSeen: number;
  lastSeen: number;
  logins: number;
  generations: number;
  adjusts: number;
  saves: number;
}

function load(): Record<string, UsageRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function save(records: Record<string, UsageRecord>) {
  // temp-then-rename, like the token store — a corrupt file must read as
  // "no history", never crash the server
  const tmp = `${USAGE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  // Not redundant with the mode above: that applies on create only, so a
  // .tmp left by a crash under a wider umask is reused at its old mode.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, USAGE_PATH);
}

// Events are human-initiated (a login, a generation) — synchronous writes at
// this rate cost nothing and keep the module free of flush bookkeeping.
function record(userId: string, name: string | null | undefined, event: UsageEvent) {
  const records = load();
  const entry: UsageRecord = records[userId] || {
    name: null,
    firstSeen: Date.now(),
    lastSeen: 0,
    logins: 0,
    generations: 0,
    adjusts: 0,
    saves: 0,
  };
  if (name) entry.name = name;
  entry.lastSeen = Date.now();
  if (event === "login") entry.logins += 1;
  if (event === "generation") entry.generations += 1;
  if (event === "adjust") entry.adjusts += 1;
  if (event === "save") entry.saves += 1;
  records[userId] = entry;
  save(records);
}

// Most recently active first.
function list(): ({ id: string } & UsageRecord)[] {
  return Object.entries(load())
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export { record, list };
