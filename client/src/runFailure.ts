// How a generate or refine run failed, kept out of the hooks so it is
// unit-tested under Node (server/test/runFailure.test.ts): the refused HTTP
// response, the stream's `error` events, and which kind of failure a caught
// error is. What each kind says to the visitor stays in the run's hook —
// useGeneration and useRefine word and announce them differently on purpose.

import { CapError, PlainError, QUOTA_COPY, StreamDroppedError, isQuotaEvent } from "./sse.ts";
import { isNetworkFailure } from "./failures.ts";

// A response that wasn't ok, as the error the run throws. `body` is its JSON,
// or {} when it had none; `fallback` is the route's own fault text.
export function responseFailure(status: number, body: { error?: string }, fallback: string): Error {
  if (status === 429) return new CapError(body.error);
  if (status === 400 && body.error) return new PlainError(body.error);
  return new Error(body.error || fallback);
}

// The stream's `error` events, gathered while the stream is read and judged
// once it ends. The quota flag sticks once any event carried it; the rest
// are the last event's.
export interface StreamErrors {
  quota: boolean;
  outage: string | null;
  detail: string | null;
  error: string | null;
}

export function noStreamErrors(): StreamErrors {
  return { quota: false, outage: null, detail: null, error: null };
}

export function noteStreamError(
  acc: StreamErrors,
  data: { message?: string; detail?: string; quota?: boolean; outage?: boolean } | null,
  fallback: string
): void {
  if (isQuotaEvent(data)) acc.quota = true;
  if (data?.outage && data.message) acc.outage = data.message;
  acc.detail = data?.detail ?? null;
  acc.error = data?.detail || data?.message || fallback;
}

// the error to throw once the stream has ended, or null when it sent none
export function streamFailure(acc: StreamErrors): Error | null {
  if (acc.quota) return new CapError(QUOTA_COPY, acc.detail);
  if (acc.outage) return new PlainError(acc.outage, acc.detail);
  if (acc.error) return new Error(acc.error);
  return null;
}

// Which kind of failure a run's catch is holding, checked in this order: a
// stop beats everything, and a cap is a cap even with the wifi gone. The cap
// and plain kinds carry the narrowed error, so the catch can read its
// message and detail without a cast.
export type RunFailure =
  | { kind: "aborted" }
  | { kind: "cap"; error: CapError }
  | { kind: "offline" }
  | { kind: "dropped" }
  | { kind: "plain"; error: PlainError }
  | { kind: "fault" };

export function classifyRunFailure(e: unknown, online: boolean | undefined): RunFailure {
  if (e instanceof Error && e.name === "AbortError") return { kind: "aborted" };
  if (e instanceof CapError) return { kind: "cap", error: e };
  if (isNetworkFailure(e, online)) return { kind: "offline" };
  if (e instanceof StreamDroppedError) return { kind: "dropped" };
  if (e instanceof PlainError) return { kind: "plain", error: e };
  return { kind: "fault" };
}
