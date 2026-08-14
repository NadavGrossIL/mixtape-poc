// Shared helpers for the eval scripts. Plain Node, no deps of its own —
// everything heavy (the Anthropic SDK) is borrowed from server/node_modules.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const RUNS_DIR = path.join(import.meta.dirname, "runs");

// Minimal .env parser — the eval scripts sit outside server/, so importing
// "dotenv" by name wouldn't resolve. server/.env is tiny; parse it directly.
function loadServerEnv() {
  const envPath = path.join(REPO_ROOT, "server", ".env");
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = rawVal!.replace(/^["']|["']$/g, "");
  }
}

// The Anthropic SDK lives in server/node_modules — require it by path
// (createRequire: ESM has no require of its own).
const require = createRequire(import.meta.url);
function requireAnthropic(): any {
  return require(path.join(REPO_ROOT, "server", "node_modules", "@anthropic-ai/sdk"));
}

function newRunDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(RUNS_DIR, ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Latest run dir, or an explicit one passed on the CLI.
function resolveRunDir(argv: string[]): string {
  const explicit = argv.find((a) => !a.startsWith("--"));
  if (explicit) {
    const dir = path.isAbsolute(explicit) ? explicit : path.join(REPO_ROOT, explicit);
    if (!fs.existsSync(dir)) throw new Error(`Run dir not found: ${dir}`);
    return dir;
  }
  const entries = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).sort() : [];
  if (!entries.length) throw new Error("No runs found — run generate.ts first");
  return path.join(RUNS_DIR, entries[entries.length - 1]!);
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export {
  REPO_ROOT,
  RUNS_DIR,
  loadServerEnv,
  requireAnthropic,
  newRunDir,
  resolveRunDir,
  readJson,
  writeJson,
  sleep,
};
