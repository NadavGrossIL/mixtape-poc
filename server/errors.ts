// Reading a caught value without `catch (err: any)`. A catch can receive
// anything, and the facts the routes branch on are properties bolted onto
// errors rather than classes: `status` (Spotify and Anthropic HTTP errors),
// `quotaExceeded` (spotify.ts, when the daily-quota breaker opens). These read
// them structurally, so a plain object with the same fields counts too.

function prop(err: unknown, key: string): unknown {
  return typeof err === "object" && err !== null && key in err
    ? (err as Record<string, unknown>)[key]
    : undefined;
}

// The `message` field when there is a string one, else undefined.
function messageOf(err: unknown): string | undefined {
  const m = prop(err, "message");
  return typeof m === "string" ? m : undefined;
}

// What to put in a log line: the message, or the thrown value itself.
function errorMessage(err: unknown): string {
  return messageOf(err) ?? String(err);
}

function errorStatus(err: unknown): number | undefined {
  const s = prop(err, "status");
  return typeof s === "number" ? s : undefined;
}

function isQuotaError(err: unknown): boolean {
  return prop(err, "quotaExceeded") === true;
}

export { messageOf, errorMessage, errorStatus, isQuotaError };
