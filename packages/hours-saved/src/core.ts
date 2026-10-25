// ADR 0109 §1-4 and §10: baseline, grade, per-run saving, display. Integer seconds throughout.

import { compareCodeUnits, inputsDigest, jcs, sha256OfString } from "./digest.ts";
import {
  COMPUTATION,
  HoursSavedInputError,
  type Baseline,
  type BaselineInstance,
  type BaselineSample,
  type Grade,
  type ReviewEvent,
  type RunOutcome,
  type RunSaving,
  type Seconds,
  type UserEstimate,
} from "./types.ts";

export function assertSeconds(v: unknown, what: string): asserts v is Seconds {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new HoursSavedInputError(`${what} must be a whole non-negative number of seconds, got ${String(v)}`);
  }
}

function assertCount(v: unknown, what: string): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new HoursSavedInputError(`${what} must be a non-negative integer, got ${String(v)}`);
  }
}

/** n odd → middle; n even → floor of the mean of the two middle values. `sorted` ascending, non-empty. */
export function median(sorted: readonly Seconds[]): Seconds {
  const n = sorted.length;
  if (n === 0) throw new HoursSavedInputError("median of an empty multiset");
  if (n % 2 === 1) return sorted[(n - 1) / 2]!;
  return Math.floor((sorted[n / 2 - 1]! + sorted[n / 2]!) / 2);
}

/** Nearest rank: d[ceil(p·n) − 1] for p = num/den, in integers. */
export function nearestRank(sorted: readonly Seconds[], num: number, den: number): Seconds {
  const n = sorted.length;
  if (n === 0) throw new HoursSavedInputError("quantile of an empty multiset");
  const rank = Math.floor((num * n + den - 1) / den); // ceil(num·n / den)
  return sorted[Math.max(rank, 1) - 1]!;
}

/** ADR 0109 §2: A = observed, n ≥ 5 and 2·iqr ≤ median; B = observed otherwise; C = user estimate. */
export function gradeFor(source: Baseline["source"], n: number, iqr: Seconds, med: Seconds): Grade | null {
  if (source === "observed") return n >= 5 && 2 * iqr <= med ? "A" : "B";
  if (source === "user_estimate") return "C";
  return null;
}

/**
 * Baseline for one (workflowId, version): the union of the samples' instances deduplicated by instanceRef.
 * If two devices report the same instanceRef with different seconds, the smaller value is kept (conservative and
 * independent of input order). Observed wins over a user estimate; neither → source "default", grade null.
 */
export function baseline(samples: readonly BaselineSample[], estimate: UserEstimate | null = null): Baseline {
  let key: string | null = null;
  const byRef = new Map<string, BaselineInstance>();
  for (const s of samples) {
    const k = `${s.workflowId}@${s.version}`;
    if (key !== null && k !== key) throw new HoursSavedInputError(`baseline: samples mix ${key} and ${k}`);
    key = k;
    for (const inst of s.instances) {
      assertSeconds(inst.activeSeconds, "baseline_sample.activeSeconds");
      const prev = byRef.get(inst.instanceRef);
      if (
        prev === undefined ||
        inst.activeSeconds < prev.activeSeconds ||
        (inst.activeSeconds === prev.activeSeconds && compareCodeUnits(inst.day, prev.day) < 0)
      ) {
        byRef.set(inst.instanceRef, { instanceRef: inst.instanceRef, activeSeconds: inst.activeSeconds, day: inst.day });
      }
    }
  }
  if (estimate !== null) {
    assertSeconds(estimate.seconds, "user estimate seconds");
    const k = `${estimate.workflowId}@${estimate.version}`;
    if (key !== null && k !== key) throw new HoursSavedInputError(`baseline: estimate ${k} does not match ${key}`);
  }
  const instances = [...byRef.values()].sort((a, b) => compareCodeUnits(a.instanceRef, b.instanceRef));
  const digestRows: { id: string }[] = [...samples];
  if (estimate !== null) digestRows.push(estimate);
  const common = { computation: COMPUTATION, inputsDigest: inputsDigest(digestRows) };

  if (instances.length > 0) {
    const d = instances.map((i) => i.activeSeconds).sort((a, b) => a - b);
    const med = median(d);
    const q1 = nearestRank(d, 1, 4);
    const q3 = nearestRank(d, 3, 4);
    const iqr = q3 - q1;
    return { ...common, source: "observed", n: d.length, median: med, q1, q3, iqr, grade: gradeFor("observed", d.length, iqr, med), samples: instances };
  }
  if (estimate !== null) {
    const s = estimate.seconds;
    return { ...common, source: "user_estimate", n: 0, median: s, q1: s, q3: s, iqr: 0, grade: "C", samples: [] };
  }
  return { ...common, source: "default", n: 0, median: 0, q1: 0, q3: 0, iqr: 0, grade: null, samples: [] };
}

/** A run counts as policy committed when an overnight policy approved it (approverKind "policy"). */
export function isPolicyCommitted(run: RunOutcome, reviews: readonly ReviewEvent[]): boolean {
  return run.approverKind === "policy" || reviews.some((r) => r.decision === "policy_committed");
}

/**
 * ADR 0109 §3-4, operator refinement: saved = max(0, baseline × items sent − measured residual) for successful runs.
 * - outcome other than success → 0 (listed separately, note null).
 * - no review event → 0, residual null, note "not_reviewed_yet".
 * - policy committed (overnight, no human review) → residual = the digest seconds recorded for the run (0 if
 *   none), note "policy_committed".
 * Review events are filtered to this run and deduplicated by id; their review + edit + fix seconds are summed.
 */
export function savedForRun(run: RunOutcome, base: Baseline, reviews: readonly ReviewEvent[]): RunSaving {
  assertCount(run.items.sent, "run.items.sent");
  const mine = new Map<string, ReviewEvent>();
  for (const r of reviews) {
    if (r.runId !== run.runId) continue;
    assertSeconds(r.reviewSeconds, "review.reviewSeconds");
    assertSeconds(r.editSeconds, "review.editSeconds");
    assertSeconds(r.fixSeconds, "review.fixSeconds");
    const prev = mine.get(r.id);
    if (prev === undefined || compareCodeUnits(jcs(r), jcs(prev)) < 0) mine.set(r.id, r);
  }
  const events = [...mine.values()];
  const digest = sha256OfString(
    jcs({ baseline: base.inputsDigest, baselineSeconds: base.median, grade: base.grade, rows: inputsDigest([run, ...events]) }),
  );
  const items = run.items.sent;
  const result = (saved: Seconds, residual: Seconds | null, note: RunSaving["note"]): RunSaving => ({
    computation: COMPUTATION,
    inputsDigest: digest,
    saved,
    residual,
    note,
    baselineSeconds: base.median,
    itemsSucceeded: items,
  });

  const policy = isPolicyCommitted(run, events);
  const residual = events.reduce((acc, r) => acc + r.reviewSeconds + r.editSeconds + r.fixSeconds, 0);
  const measured: Seconds | null = events.length > 0 || policy ? residual : null;
  const note: RunSaving["note"] = policy ? "policy_committed" : measured === null ? "not_reviewed_yet" : null;

  if (run.outcome !== "success") return result(0, measured, note === "not_reviewed_yet" ? null : note);
  if (measured === null) return result(0, null, "not_reviewed_yet");
  return result(Math.max(0, base.median * items - measured), measured, note);
}

/** ADR 0109 §10: hours = round_half_even(seconds / 360) / 10, done in integers. */
export function displayHours(seconds: Seconds): number {
  assertSeconds(seconds, "displayHours");
  const q = Math.floor(seconds / 360);
  const r = seconds - q * 360;
  const tenths = 2 * r > 360 ? q + 1 : 2 * r < 360 ? q : q % 2 === 0 ? q : q + 1;
  return tenths / 10;
}
