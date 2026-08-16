// In-app logbook: the server's own log tail, readable from the browser.
//
// Every route already logs the useful things ("[curator] turn 2: ...",
// "[generate/stream] failed: ..."), and every client-facing error says
// "check the server logs" — but deployed, those logs live behind a hosting
// dashboard the owner can't reach from a phone mid-run. So the lines are
// teed into a ring buffer here and served back over /api/logs, behind the
// same owner gate as everything else.
//
// stdout still gets every line unchanged: this is a mirror, not a
// replacement, so the host's own log view keeps working.

// Ring capacity. One generate run writes ~5 lines, so this holds roughly the
// last hundred runs — long enough to still find the failure after the fact.
const CAPACITY = 500;

type Level = "info" | "warn" | "error";

interface Entry {
  seq: number;
  t: number;
  level: Level;
  scope: string;
  msg: string;
}

const entries: Entry[] = [];
const listeners = new Set<(entry: Entry) => void>();
let seq = 0;

// "[curator] turn 1: 8 spotify searches" → scope "curator". Every log line in
// this server already carries that prefix, so the browser gets a filterable
// scope for free rather than one undifferentiated wall of text.
const SCOPE_RE = /^\[([a-z0-9/_-]+)\]\s*/i;

// console.* accepts anything; render it the way the terminal would, so the
// two views never disagree about what was logged.
function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a); // circular refs and the like
      }
    })
    .join(" ");
}

function record(level: Level, raw: string): void {
  // Some lines are padded with blank lines for readability in a terminal
  // (the startup config warnings are). In a row-per-entry panel that padding
  // is just a leading newline that hides the [scope] prefix.
  const text = raw.trim();
  const scoped = SCOPE_RE.exec(text);
  const entry: Entry = {
    seq: ++seq,
    t: Date.now(),
    level,
    scope: scoped ? scoped[1]!.toLowerCase() : "server",
    msg: scoped ? text.slice(scoped[0].length) : text,
  };
  entries.push(entry);
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
  for (const notify of listeners) {
    try {
      notify(entry);
    } catch {
      // a dead SSE listener must never take down the thing being logged
    }
  }
}

// Tee console.* into the ring. Called once at startup, before the config
// warnings, so a misconfigured key is visible in the browser too.
function patchConsole(): void {
  const routes: [("log" | "info" | "warn" | "error"), Level][] = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [method, level] of routes) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        record(level, format(args));
      } catch {
        // logging must never be the thing that throws
      }
    };
  }
}

// Everything newer than `after` (0 = the whole buffer). The client passes the
// last seq it holds so a reconnect doesn't duplicate or skip lines.
function since(after: number): Entry[] {
  return after > 0 ? entries.filter((e) => e.seq > after) : entries.slice();
}

function subscribe(fn: (entry: Entry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type { Entry, Level };
export { patchConsole, since, subscribe, CAPACITY };
