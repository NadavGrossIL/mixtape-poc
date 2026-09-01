// The server's log tail, in the page.
//
// Every failure path in this app used to end at "check the server logs" —
// advice the owner couldn't act on, because deployed those logs live behind
// a hosting dashboard and this thing is mostly used from a phone. So the
// server tees its console into a ring buffer and this panel tails it.
//
// It is deliberately always-connected: the point is that when something
// breaks you already have the run's history, rather than having to
// reproduce it with the panel open. The one exception is a stream the owner
// gate refuses — for anyone but the owner there is no history to wait for,
// so we stop reconnecting rather than retry a 401 forever.

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

// server/metrics.ts — aggregate counters, one row per day.
interface DayCounts {
  views: number;
  newVisitors: number;
  prompts: number;
  generated: number;
  adjusts: number;
  pressed: number;
  errors: number;
  capped: number;
}

interface MetricsDay extends DayCounts {
  day: string;
}

// `today` is the server's own day stamp, not ours: the client must never
// decide what "today" is, or a browser sitting on the wrong side of UTC
// midnight labels yesterday's row as today.
interface Metrics {
  today: string;
  days: MetricsDay[];
  totals: DayCounts;
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / (60 * 24))}d ago`;
};

// One line, in funnel order, so a drop between two numbers is the story.
// A day the server has no row for is a real zero, not missing data — hence
// the per-field fallback rather than a zeroed literal that would spell the
// metric names out a second time.
const funnel = (d: DayCounts | null | undefined) =>
  `${d?.views ?? 0} views (${d?.newVisitors ?? 0} new) · ` +
  `${d?.prompts ?? 0} prompts · ${d?.generated ?? 0} made · ` +
  `${d?.adjusts ?? 0} refines · ${d?.pressed ?? 0} pressed · ` +
  `${d?.errors ?? 0} errors` +
  ((d?.capped ?? 0) > 0 ? ` · ${d!.capped} capped` : "");

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
  // The stream's gate said no — a non-owner on /?debug. Terminal, not a blip:
  // it stops the reconnect loop and swaps "reconnecting…" for the real reason.
  const [denied, setDenied] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Cleared entries stay cleared: the badge counts problems newer than this.
  const [readSeq, setReadSeq] = useState(0);
  // Who has been using the app. The server only answers the owner — anyone
  // else gets a 401 and the strip simply doesn't render.
  const [users, setUsers] = useState<UsageRow[] | null>(null);
  // The funnel, same owner-only deal.
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const lastSeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Only follow the tail while the reader is already at the bottom —
  // yanking the view down mid-scroll is how log panels become unreadable.
  const pinnedRef = useRef(true);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let probe: AbortController | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/logs/stream?since=${lastSeqRef.current}`);
      source.addEventListener("open", () => setLive(true));
      source.addEventListener("log", (e) => {
        // A frame can arrive truncated — a proxy cutting a write in half is
        // enough. An uncaught throw in here loses the line *and* every state
        // update after it in this listener, so the panel silently stops
        // moving. Drop the bad frame and keep the stream instead.
        let entry: LogEntry;
        try {
          entry = JSON.parse((e as MessageEvent).data) as LogEntry;
        } catch {
          return;
        }
        lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq);
        setEntries((prev) => [...prev, entry].slice(-CAPACITY));
      });
      source.addEventListener("error", () => {
        // EventSource retries on its own, but without the `since` cursor —
        // which would replay the whole ring. Reconnect by hand instead.
        setLive(false);
        source?.close();
        if (closed) return;
        // …but not forever. EventSource hides the HTTP status on its error
        // event, so a non-owner's 401 looks exactly like a server restart and
        // we would hammer the gate every RETRY_MS for as long as the tab is
        // open. /api/logs is behind the same owner gate, is cheap and answers
        // in JSON, so ask it which one this is: 401/403 means stop for good
        // and say so, anything else (including a failed fetch, i.e. the
        // server really is down) is the transient case the hand-rolled
        // retry above exists for.
        const ctrl = new AbortController();
        probe = ctrl;
        const again = () => {
          if (!closed && !ctrl.signal.aborted) retry = setTimeout(connect, RETRY_MS);
        };
        fetch(`/api/logs?since=${lastSeqRef.current}`, { signal: ctrl.signal })
          .then((r) => {
            if (closed || ctrl.signal.aborted) return;
            if (r.status === 401 || r.status === 403) setDenied(true);
            else again();
          })
          .catch(again);
      });
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      probe?.abort();
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
    fetch("/api/metrics")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Metrics | null) => setMetrics(d && Array.isArray(d.days) ? d : null))
      .catch(() => setMetrics(null));
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
          {!live && (
            <span className="logs-down">
              {denied ? " owner only" : " reconnecting…"}
            </span>
          )}
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

      {metrics && metrics.days.length > 0 && (
        <div className="logs-funnel" aria-label="Usage funnel">
          <span className="logs-funnel-line">
            <b>today</b>{" "}
            {funnel(metrics.days.find((d) => d.day === metrics.today))}
          </span>
          <span className="logs-funnel-line">
            <b>30d</b> {funnel(metrics.totals)}
          </span>
        </div>
      )}

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
