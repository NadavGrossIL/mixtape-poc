// Shared helpers for the eval scripts. Plain Node, no deps of its own —
// everything heavy (the Anthropic SDK) is borrowed from server/node_modules.

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const RUNS_DIR = path.join(__dirname, "runs");

// Minimal .env parser — the eval scripts sit outside server/, so requiring
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
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawVal.replace(/^["']|["']$/g, "");
  }
}

// The Anthropic SDK lives in server/node_modules — require it by path.
function requireAnthropic() {
  return require(path.join(REPO_ROOT, "server", "node_modules", "@anthropic-ai/sdk"));
}

function newRunDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(RUNS_DIR, ts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Latest run dir, or an explicit one passed on the CLI.
function resolveRunDir(argv) {
  const explicit = argv.find((a) => !a.startsWith("--"));
  if (explicit) {
    const dir = path.isAbsolute(explicit) ? explicit : path.join(REPO_ROOT, explicit);
    if (!fs.existsSync(dir)) throw new Error(`Run dir not found: ${dir}`);
    return dir;
  }
  const entries = fs.existsSync(RUNS_DIR) ? fs.readdirSync(RUNS_DIR).sort() : [];
  if (!entries.length) throw new Error("No runs found — run generate.js first");
  return path.join(RUNS_DIR, entries[entries.length - 1]);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
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
