// Pure metric + threshold logic, shared by aggregate.ts and reliability.ts.
// No I/O, no API calls — everything here is covered by evals/selftest.ts.
//
// pass@k / pass^k follow Anthropic's guidance for agent evals ("Demystifying
// evals for AI agents"): a single run tells you almost nothing about a
// non-deterministic agent, so run n trials and report both
//   pass@k — "does it EVER succeed in k attempts?"  (capability)
//   pass^k — "does it ALWAYS succeed in k attempts?" (reliability)
// They tell opposite stories as k grows, which is the point. The hollow-commit
// regression this harness exists to catch is a pass^k question: the model
// succeeded plenty of the time at 6/10, and that was still a broken product.

// Unbiased estimators from n observed trials with c successes, for any k <= n
// (the Codex-paper form). Computed as a running product rather than via
// factorials, so no intermediate overflows and no floating-point cliff.

// P(at least one success in k draws) = 1 - C(n-c, k)/C(n, k)
function passAtK(n: number, c: number, k: number): number | null {
  if (!validCounts(n, c, k)) return null;
  const failures = n - c;
  if (failures < k) return 1; // too few failures to fill k draws
  let allFail = 1;
  for (let i = 0; i < k; i++) allFail *= (failures - i) / (n - i);
  return round(1 - allFail);
}

// P(all k draws succeed) = C(c, k)/C(n, k)
function passHatK(n: number, c: number, k: number): number | null {
  if (!validCounts(n, c, k)) return null;
  if (c < k) return 0; // too few successes to fill k draws
  let allPass = 1;
  for (let i = 0; i < k; i++) allPass *= (c - i) / (n - i);
  return round(allPass);
}

function validCounts(n: number, c: number, k: number): boolean {
  return (
    Number.isInteger(n) &&
    Number.isInteger(c) &&
    Number.isInteger(k) &&
    n > 0 &&
    k > 0 &&
    k <= n &&
    c >= 0 &&
    c <= n
  );
}

function round(x: number): number {
  return Number(x.toFixed(4));
}

// --- Thresholds --------------------------------------------------------------

// A rule is {min} and/or {max} on a dotted path into a summary object. Absent
// config = report-only, which is the honest default: a threshold invented
// before a baseline run is a number with no evidence behind it.

type Rule = { min?: number; max?: number; note?: string };
type Check = {
  path: string;
  actual: number | null;
  rule: Rule;
  ok: boolean;
  reason: string | null;
};

function getPath(obj: any, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

// A null metric (empty denominator) is NOT a breach — it means the run had
// nothing to measure. Surfacing it as "skipped" beats failing a build on an
// absence, and beats silently passing.
function checkThresholds(summary: unknown, rules: Record<string, Rule>): Check[] {
  return Object.entries(rules || {})
    .filter(([path]) => !path.startsWith("$")) // $comment etc.
    .map(([path, rule]) => {
      const raw = getPath(summary, path);
      const actual = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      if (actual === null) {
        return { path, actual: null, rule, ok: true, reason: "no data — skipped" };
      }
      if (rule.min != null && actual < rule.min) {
        return { path, actual, rule, ok: false, reason: `below min ${rule.min}` };
      }
      if (rule.max != null && actual > rule.max) {
        return { path, actual, rule, ok: false, reason: `above max ${rule.max}` };
      }
      return { path, actual, rule, ok: true, reason: null };
    });
}

function renderChecks(checks: Check[]): string {
  if (!checks.length) {
    return "Thresholds : none configured — report-only.\n" +
      "             Set them from a baseline run, not from a guess (evals/thresholds.json).";
  }
  const lines = ["Thresholds :"];
  for (const c of checks) {
    const bound = [
      c.rule.min != null ? `min ${c.rule.min}` : null,
      c.rule.max != null ? `max ${c.rule.max}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const mark = c.reason === "no data — skipped" ? "–" : c.ok ? "✓" : "✗";
    const actual = c.actual === null ? "—" : String(c.actual);
    lines.push(
      `  ${mark} ${c.path.padEnd(34)} ${actual.padStart(8)}  (${bound})` +
        (c.ok ? "" : `  ${c.reason}`)
    );
  }
  const failed = checks.filter((c) => !c.ok).length;
  lines.push(failed ? `  ${failed} threshold(s) breached` : "  all thresholds met");
  return lines.join("\n");
}

export { passAtK, passHatK, checkThresholds, renderChecks, getPath };
export type { Rule, Check };
