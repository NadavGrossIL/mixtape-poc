// The SIGTERM drain, as a pure function — so "wait for the open streams, but
// not forever" is testable without signals, sockets or a real clock (ADR
// 0003: thin handler in index.ts, pure module here, test the module).
//
// Why it exists: Railway sends SIGTERM on every redeploy. A curator run that
// is mid-stream at that moment has already been counted against the caller's
// daily cap (index.ts counts before it starts the paid work, on purpose), so
// cutting it costs the visitor a generation AND shows them a generic failure.
// The handler in index.ts stops accepting new connections, then waits here
// for the in-flight streams to finish — bounded, because a stream the client
// forgot about must not hold a redeploy hostage.
//
// This only helps once Railway is told to wait too: its
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS defaults to 0, meaning SIGKILL follows
// SIGTERM almost immediately and no amount of politeness here matters. Set it
// to >= 30 (README → Deploy) so the 25 s ceiling below fits inside it with
// room for the exit handlers (metrics and search-cache flush) to run.

interface DrainOptions {
  // How many streams are still open — read fresh on every poll.
  openStreams: () => number;
  // The ceiling. Past it we exit with streams still open rather than wait.
  maxWaitMs: number;
  // Poll interval; clamped so the last sleep never overshoots the ceiling.
  pollMs?: number;
  // Injected clock and sleeper, so a test can run 25 s in no time at all.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface DrainResult {
  // "drained": every stream finished. "timeout": the ceiling won, `left` of
  // them were still open when we gave up.
  reason: "drained" | "timeout";
  waitedMs: number;
  left: number;
}

const DEFAULT_POLL_MS = 250;

async function drain(opts: DrainOptions): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = Math.max(1, opts.pollMs ?? DEFAULT_POLL_MS);
  const start = now();
  for (;;) {
    const left = opts.openStreams();
    const elapsed = now() - start;
    if (left <= 0) return { reason: "drained", waitedMs: elapsed, left: 0 };
    if (elapsed >= opts.maxWaitMs) return { reason: "timeout", waitedMs: elapsed, left };
    await sleep(Math.min(pollMs, opts.maxWaitMs - elapsed));
  }
}

export type { DrainOptions, DrainResult };
export { drain, DEFAULT_POLL_MS };
