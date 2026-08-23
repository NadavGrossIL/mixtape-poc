// The server's log tail, in the page.
//
// Every failure path in this app used to end at "check the server logs" —
// advice the owner couldn't act on, because deployed those logs live behind
// a hosting dashboard and this thing is mostly used from a phone. So the
// server tees its console into a ring buffer and this panel tails it.
//
// It is deliberately always-connected: the point is that when something
// breaks you already have the run's history, rather than having to
// reproduce it with the panel open.

import { useEffect, useMemo, useRef, useState } from "react";

interface LogEntry {
  seq: number;
  t: number;
  level: "info" | "warn" | "error";
  scope: string;
  msg: string;
}

interface UsageRow {
  id: string;
  name: string | null;
  lastSeen: number;
  logins: number;
  generations: number;
  adjusts: number;
  saves: number;
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / (60 * 24))}d ago`;
};

// Matches the server ring's capacity — no reason to hold more than the
// server can ever replay on reconnect.
const CAPACITY = 500;
const RETRY_MS = 3000;

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

export default function LogConsole() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [live, setLive] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Cleared entries stay cleared: the badge counts problems newer than this.
  const [readSeq, setReadSeq] = useState(0);
  // Who has been using the app. The server only answers the owner — anyone
  // else gets a 401 and the strip simply doesn't render.
  const [users, setUsers] = useState<UsageRow[] | null>(null);

  const lastSeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Only follow the tail while the reader is already at the bottom —
  // yanking the view down mid-scroll is how log panels become unreadable.
  const pinnedRef = useRef(true);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/logs/stream?since=${lastSeqRef.current}`);
      source.addEventListener("open", () => setLive(true));
      source.addEventListener("log", (e) => {
        const entry = JSON.parse((e as MessageEvent).data) as LogEntry;
        lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq);
        setEntries((prev) => [...prev, entry].slice(-CAPACITY));
      });
      source.addEventListener("error", () => {
        // EventSource retries on its own, but without the `since` cursor —
        // which would replay the whole ring. Reconnect by hand instead.
        setLive(false);
        source?.close();
        if (!closed) retry = setTimeout(connect, RETRY_MS);
      });
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { users?: UsageRow[] } | null) =>
        setUsers(d && Array.isArray(d.users) ? d.users : null)
      )
      .catch(() => setUsers(null));
  }, [open]);

  const shown = useMemo(
    () => (problemsOnly ? entries.filter((e) => e.level !== "info") : entries),
    [entries, problemsOnly]
  );

  useEffect(() => {
    if (open && pinnedRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [shown, open]);

  // Mark everything seen while the panel is open, so the badge only ever
  // means "problems you haven't looked at".
  useEffect(() => {
    if (open && entries.length) setReadSeq(entries[entries.length - 1]!.seq);
  }, [open, entries]);

  const unseenProblems = entries.filter(
    (e) => e.level !== "info" && e.seq > readSeq
  ).length;

  const copyAll = () => {
    const text = shown
      .map((e) => `${clock(e.t)} ${e.level.padEnd(5)} [${e.scope}] ${e.msg}`)
      .join("\n");
    void navigator.clipboard?.writeText(text);
  };

  if (!open) {
    return (
      <button
        className="logs-tab"
        onClick={() => setOpen(true)}
        title="server log tail"
      >
        logs
        {unseenProblems > 0 && (
          <span className="logs-badge">{unseenProblems}</span>
        )}
      </button>
    );
  }

  return (
    <section className="logs-panel" aria-label="Server log">
      <header className="logs-head">
        <span className="logs-title">
          <span
            className={`logs-dot ${live ? "is-live" : "is-down"}`}
            aria-hidden="true"
          />
          server log
          {!live && <span className="logs-down"> reconnecting…</span>}
        </span>
        <div className="logs-actions">
          <button
            className={`logs-btn ${problemsOnly ? "is-on" : ""}`}
            onClick={() => setProblemsOnly((v) => !v)}
            aria-pressed={problemsOnly}
          >
            problems
          </button>
          <button className="logs-btn" onClick={copyAll}>
            copy
          </button>
          <button className="logs-btn" onClick={() => setEntries([])}>
            clear
          </button>
          <button
            className="logs-btn"
            onClick={() => setOpen(false)}
            aria-label="Close log panel"
          >
            ✕
          </button>
        </div>
      </header>

      {users && users.length > 0 && (
        <div className="logs-usage" aria-label="Who has been using the app">
          {users.map((u) => (
            <span key={u.id} className="logs-usage-row">
              <b>{u.name || u.id}</b> · {u.generations} made · {u.saves} saved ·{" "}
              {ago(u.lastSeen)}
            </span>
          ))}
        </div>
      )}

      <div
        className="logs-body"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.length === 0 ? (
          <p className="logs-empty">
            {problemsOnly ? "no warnings or errors." : "nothing logged yet."}
          </p>
        ) : (
          shown.map((e) => (
            <div key={e.seq} className={`logs-row is-${e.level}`}>
              <span className="logs-time">{clock(e.t)}</span>
              <span className="logs-scope">{e.scope}</span>
              <span className="logs-msg">{e.msg}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
