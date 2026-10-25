// ADR 0109 §5-6 (totals and splits), §12 (anomalies) and ADR 0103 §5 (group floor with complementary suppression).

import { savedForRun, displayHours, assertSeconds } from "./core.ts";
import { compareCodeUnits } from "./digest.ts";
import { assertPeriod, inPeriod, localDay } from "./time.ts";
import {
  HoursSavedInputError,
  type Anomaly,
  type Baseline,
  type Cell,
  type CellTree,
  type Period,
  type ReviewEvent,
  type RunInput,
  type RunRow,
  type Scope,
  type Suppressed,
} from "./types.ts";

export const DEFAULT_GROUP_FLOOR = 5;

export interface BaselineEntry {
  readonly workflowId: string;
  readonly version: number;
  readonly baseline: Baseline;
}

const NO_BASELINE: Pick<Baseline, "median" | "grade" | "source" | "n"> = { median: 0, grade: null, source: "default", n: 0 };

/** Compute one RunRow per run. A run whose (workflowId, version) has no baseline entry uses "default" (contributes 0). */
export function buildRows(
  runs: readonly RunInput[],
  reviews: readonly ReviewEvent[],
  baselines: readonly BaselineEntry[],
): RunRow[] {
  const byKey = new Map<string, Baseline>();
  for (const e of baselines) {
    const k = `${e.workflowId}@${e.version}`;
    if (byKey.has(k)) throw new HoursSavedInputError(`duplicate baseline for ${k}`);
    byKey.set(k, e.baseline);
  }
  const reviewsByRun = new Map<string, ReviewEvent[]>();
  for (const r of reviews) {
    const list = reviewsByRun.get(r.runId);
    if (list === undefined) reviewsByRun.set(r.runId, [r]);
    else list.push(r);
  }
  const seen = new Set<string>();
  return runs.map((input) => {
    const run = input.run;
    if (seen.has(run.runId)) throw new HoursSavedInputError(`run ${run.runId} appears twice`);
    seen.add(run.runId);
    const base = byKey.get(`${run.workflowId}@${run.version}`);
    const s = savedForRun(run, base ?? defaultBaseline(), reviewsByRun.get(run.runId) ?? []);
    const b = base ?? NO_BASELINE;
    return {
      id: run.runId,
      workflowId: run.workflowId,
      version: run.version,
      personId: input.personId,
      departmentId: input.departmentId,
      jobRoleId: input.jobRoleId,
      runtime: run.runtime,
      outcome: run.outcome,
      deviceOutcome: input.deviceOutcome ?? null,
      endedAt: run.endedAt,
      overnight: run.overnight,
      source: b.source,
      grade: b.grade,
      baselineN: b.n,
      baselineSeconds: s.baselineSeconds,
      itemsSucceeded: s.itemsSucceeded,
      residual: s.residual,
      saved: s.saved,
      note: s.note,
    };
  });
}

function defaultBaseline(): Baseline {
  return { computation: "hs-1", inputsDigest: "", source: "default", n: 0, median: 0, q1: 0, q3: 0, iqr: 0, grade: null, samples: [] };
}

export function inScope(row: RunRow, scope: Scope): boolean {
  switch (scope.type) {
    case "company":
      return true;
    case "department":
      return row.departmentId !== null && row.departmentId === scope.id;
    case "job_role":
      return row.jobRoleId !== null && row.jobRoleId === scope.id;
    case "person":
      return row.personId === scope.id;
  }
}

/** Rows in scope with endedAt in the half-open period of local days in `tz`. */
export function selectRows(rows: readonly RunRow[], scope: Scope, period: Period, tz: string): RunRow[] {
  assertPeriod(period);
  return rows.filter((r) => inScope(r, scope) && inPeriod(r.endedAt, period, tz));
}

/** ADR 0109 §5-6. Splits (byGrade, bySource, byRuntime) each sum to `seconds`; people = distinct people with runs. */
export function total(rows: readonly RunRow[], scope: Scope, period: Period, tz: string): Cell {
  return cellOf(selectRows(rows, scope, period, tz));
}

export function cellOf(rows: readonly RunRow[]): Cell {
  let seconds = 0, A = 0, B = 0, C = 0, observed = 0, estimate = 0, mac = 0, cloud = 0, overnight = 0;
  const runs = { success: 0, failed: 0, cancelled: 0, rejected: 0, capped: 0 };
  const people = new Set<string>();
  for (const r of rows) {
    assertSeconds(r.saved, "row.saved");
    people.add(r.personId);
    runs[r.outcome] += 1;
    const s = r.saved;
    if (s === 0) continue;
    if (r.grade === null) throw new HoursSavedInputError(`row ${r.id} saves seconds without a baseline grade`);
    seconds += s;
    if (r.grade === "A") A += s;
    else if (r.grade === "B") B += s;
    else C += s;
    if (r.source === "observed") observed += s;
    else estimate += s;
    if (r.runtime === "mac") mac += s;
    else cloud += s;
    if (r.overnight) overnight += s;
  }
  return {
    seconds,
    hours: displayHours(seconds),
    byGrade: { A, B, C },
    bySource: { observed, user_estimate: estimate },
    byRuntime: { mac, cloud },
    overnightSeconds: overnight,
    runs,
    people: people.size,
  };
}

export const SUPPRESSED: Suppressed = Object.freeze({ suppressed: true, reason: "group_floor" }) as Suppressed;

export function isSuppressed(v: CellTree["value"]): v is Suppressed {
  return (v as Partial<Suppressed>).suppressed === true;
}

function suppressAll(node: CellTree): CellTree {
  return { scope: node.scope, label: node.label, value: SUPPRESSED, children: node.children.map(suppressAll) };
}

/**
 * ADR 0103 §5. A cell with fewer than `floor` people is suppressed. Within a parent, if exactly one child is suppressed,
 * the smallest other child (fewest people, then fewest seconds, then label, then scope id) is suppressed too. A
 * suppressed cell suppresses its whole subtree, so no descendant total can rebuild it. Suppressed cells carry no
 * numbers. Person-scoped roots (self-view, per_person_views) are not floored.
 */
export function suppress(tree: CellTree, floor: number = DEFAULT_GROUP_FLOOR): CellTree {
  if (!Number.isSafeInteger(floor) || floor < DEFAULT_GROUP_FLOOR) {
    throw new HoursSavedInputError(`group floor must be an integer ≥ ${DEFAULT_GROUP_FLOOR} (configurable upward only)`);
  }
  return suppressNode(tree, floor, tree.scope.type !== "person");
}

function underFloor(node: CellTree, floor: number): boolean {
  return isSuppressed(node.value) || node.value.people < floor;
}

function suppressNode(node: CellTree, floor: number, floored: boolean): CellTree {
  if (floored && underFloor(node, floor)) return suppressAll(node);
  const flags = node.children.map((c) => underFloor(c, floor));
  if (flags.filter(Boolean).length === 1) {
    let pick = -1;
    node.children.forEach((c, i) => {
      if (flags[i]) return;
      if (pick < 0 || smaller(c, node.children[pick]!)) pick = i;
    });
    if (pick >= 0) flags[pick] = true;
  }
  return {
    scope: node.scope,
    label: node.label,
    value: node.value,
    children: node.children.map((c, i) => (flags[i] ? suppressAll(c) : suppressNode(c, floor, true))),
  };
}

function smaller(a: CellTree, b: CellTree): boolean {
  const va = a.value as Cell, vb = b.value as Cell;
  if (va.people !== vb.people) return va.people < vb.people;
  if (va.seconds !== vb.seconds) return va.seconds < vb.seconds;
  const l = compareCodeUnits(a.label, b.label);
  if (l !== 0) return l < 0;
  return compareCodeUnits(a.scope.id ?? "", b.scope.id ?? "") < 0;
}

/**
 * ADR 0109 §12, flagged and never corrected. Over the rows given (normally one report period):
 * - residual_zero_share: a person-month (local month in `tz`) where more than 90% of successful, human-reviewed runs
 *   have residual 0 (policy-committed and not-reviewed runs are excluded). workflowId null, no person id in detail.
 * - small_baseline: a (workflow, version) used by these rows with baseline n < 3.
 * - outcome_disagreement: the device-reported outcome differs from the broker's for a run.
 * Sorted by code, workflowId, detail.
 */
export function anomalies(rows: readonly RunRow[], tz: string): Anomaly[] {
  const out: Anomaly[] = [];
  const zero = new Map<string, { month: string; n: number; z: number }>();
  const small = new Map<string, { workflowId: string; version: number; n: number; source: string }>();
  const disagree = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome === "success" && r.residual !== null && r.note !== "policy_committed") {
      const month = localDay(r.endedAt, tz).slice(0, 7);
      const k = `${r.personId}|${month}`;
      const e = zero.get(k) ?? { month, n: 0, z: 0 };
      e.n += 1;
      if (r.residual === 0) e.z += 1;
      zero.set(k, e);
    }
    if (r.baselineN < 3) {
      small.set(`${r.workflowId}@${r.version}`, { workflowId: r.workflowId, version: r.version, n: r.baselineN, source: r.source });
    }
    if (r.deviceOutcome !== null && r.deviceOutcome !== r.outcome) {
      disagree.set(r.workflowId, (disagree.get(r.workflowId) ?? 0) + 1);
    }
  }
  for (const e of zero.values()) {
    if (e.z * 10 > e.n * 9) {
      out.push({ code: "residual_zero_share", workflowId: null, detail: `one person in ${e.month}: residual 0 on ${e.z} of ${e.n} reviewed runs` });
    }
  }
  for (const e of small.values()) {
    out.push({ code: "small_baseline", workflowId: e.workflowId, detail: `version ${e.version}: baseline n = ${e.n} (${e.source}), under 3` });
  }
  for (const [workflowId, n] of disagree) {
    out.push({ code: "outcome_disagreement", workflowId, detail: `${n} run(s) where the device outcome differs from the broker's` });
  }
  return out.sort(
    (a, b) =>
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.workflowId ?? "", b.workflowId ?? "") ||
      compareCodeUnits(a.detail, b.detail),
  );
}
