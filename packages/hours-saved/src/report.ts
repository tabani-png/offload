// Whole-report composition (schemas/stage2/hours-saved-report + hours-saved-evidence). Every output is a pure function
// of the input rows; recompute() re-derives a stored report and compares it byte for byte (ADR 0109 §11).

import { anomalies, buildRows, cellOf, DEFAULT_GROUP_FLOOR, isSuppressed, selectRows, suppress, type BaselineEntry } from "./aggregate.ts";
import { baseline } from "./core.ts";
import { compareCodeUnits, inputsDigest, jcs } from "./digest.ts";
import { assertPeriod, inPeriod } from "./time.ts";
import {
  COMPUTATION,
  type BaselineSample,
  type CellTree,
  type Grade,
  type HoursSavedEvidence,
  type HoursSavedReport,
  type Period,
  type ReviewEvent,
  type RunInput,
  type RunRow,
  type Scope,
  type TopWorkflow,
  type UserEstimate,
} from "./types.ts";

export interface WorkflowMeta {
  /** The workflow uuid. */
  readonly id: string;
  readonly name: string;
  readonly jobRoleId: string | null;
}

export interface ReportInput {
  readonly runs: readonly RunInput[];
  readonly reviews: readonly ReviewEvent[];
  readonly samples: readonly BaselineSample[];
  readonly estimates: readonly UserEstimate[];
  readonly workflows: readonly WorkflowMeta[];
  readonly scope: Scope;
  /** Child scopes shown under the total (e.g. departments of the company). */
  readonly children: readonly { readonly scope: Scope; readonly label: string }[];
  readonly period: Period;
  readonly timezone: string;
  /** Group floor, ≥ 5 (ADR 0103 §5). */
  readonly floor?: number;
}

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2 };

/** Baselines for every (workflowId, version) seen in samples, estimates or runs. */
export function baselinesFor(
  samples: readonly BaselineSample[],
  estimates: readonly UserEstimate[],
  runs: readonly RunInput[],
): BaselineEntry[] {
  const keys = new Map<string, { workflowId: string; version: number }>();
  const add = (workflowId: string, version: number): void => {
    keys.set(`${workflowId}@${version}`, { workflowId, version });
  };
  const samplesByKey = new Map<string, BaselineSample[]>();
  for (const s of samples) {
    add(s.workflowId, s.version);
    const k = `${s.workflowId}@${s.version}`;
    const list = samplesByKey.get(k);
    if (list === undefined) samplesByKey.set(k, [s]);
    else list.push(s);
  }
  const estimateByKey = new Map<string, UserEstimate>();
  for (const e of estimates) {
    add(e.workflowId, e.version);
    const k = `${e.workflowId}@${e.version}`;
    const prev = estimateByKey.get(k);
    // Latest estimate wins; ties broken by id so the choice is order independent.
    if (prev === undefined || e.setAt > prev.setAt || (e.setAt === prev.setAt && compareCodeUnits(e.id, prev.id) > 0)) {
      estimateByKey.set(k, e);
    }
  }
  for (const r of runs) add(r.run.workflowId, r.run.version);
  return [...keys.entries()]
    .sort((a, b) => compareCodeUnits(a[0], b[0]))
    .map(([k, v]) => ({ ...v, baseline: baseline(samplesByKey.get(k) ?? [], estimateByKey.get(k) ?? null) }));
}

/** Digest over every input row (runs keyed by runId, plus reviews, samples, estimates, workflow metadata). */
export function reportInputsDigest(input: Pick<ReportInput, "runs" | "reviews" | "samples" | "estimates" | "workflows">): string {
  const runRows = input.runs.map((r) => ({
    id: r.run.id,
    run: r.run,
    personId: r.personId,
    departmentId: r.departmentId,
    jobRoleId: r.jobRoleId,
    deviceOutcome: r.deviceOutcome ?? null,
  }));
  return inputsDigest([...runRows, ...input.reviews, ...input.samples, ...input.estimates, ...input.workflows]);
}

export function report(input: ReportInput): HoursSavedReport {
  assertPeriod(input.period);
  const floor = input.floor ?? DEFAULT_GROUP_FLOOR;
  const rows = buildRows(input.runs, input.reviews, baselinesFor(input.samples, input.estimates, input.runs));
  const scoped = selectRows(rows, input.scope, input.period, input.timezone);
  const tree: CellTree = {
    scope: input.scope,
    label: "total",
    value: cellOf(scoped),
    children: input.children.map((c) => ({
      scope: c.scope,
      label: c.label,
      value: cellOf(selectRows(scoped, c.scope, input.period, input.timezone)),
      children: [],
    })),
  };
  const shown = suppress(tree, floor);
  const groupView = input.scope.type !== "person";
  return {
    computation: COMPUTATION,
    inputsDigest: reportInputsDigest(input),
    scope: input.scope,
    period: { from: input.period.from, toExclusive: input.period.toExclusive, timezone: input.timezone },
    total: shown.value,
    children: shown.children.map((c) => ({ scope: c.scope, label: c.label, value: c.value })),
    topWorkflows: isSuppressed(shown.value) ? [] : topWorkflows(scoped, input.workflows, groupView ? floor : 0),
    anomalies: anomalies(scoped, input.timezone).slice(0, 100),
    final: false,
  };
}

/**
 * Top 10 workflows by seconds saved (ties by workflowId). Grade is the weakest grade among the versions that saved
 * time. In group views a workflow is listed only if at least `floor` distinct people ran it, so the list cannot
 * reveal one person's numbers.
 */
function topWorkflows(rows: readonly RunRow[], meta: readonly WorkflowMeta[], floor: number): TopWorkflow[] {
  const names = new Map(meta.map((m) => [m.id, m]));
  const agg = new Map<string, { seconds: number; grade: Grade | null; people: Set<string>; jobRoleId: string | null }>();
  for (const r of rows) {
    const e = agg.get(r.workflowId) ?? { seconds: 0, grade: null, people: new Set<string>(), jobRoleId: r.jobRoleId };
    e.people.add(r.personId);
    if (r.saved > 0 && r.grade !== null) {
      e.seconds += r.saved;
      if (e.grade === null || GRADE_RANK[r.grade] > GRADE_RANK[e.grade]) e.grade = r.grade;
    }
    agg.set(r.workflowId, e);
  }
  const out: TopWorkflow[] = [];
  for (const [workflowId, e] of agg) {
    if (e.grade === null || e.seconds === 0 || e.people.size < floor) continue;
    const m = names.get(workflowId);
    out.push({ workflowId, name: m?.name ?? workflowId, jobRoleId: m ? m.jobRoleId : e.jobRoleId, grade: e.grade, seconds: e.seconds });
  }
  out.sort((a, b) => b.seconds - a.seconds || compareCodeUnits(a.workflowId, b.workflowId));
  return out.slice(0, 10);
}

/** Exact recomputation check for the nightly job: true iff the stored report equals a fresh one (ignoring `final`). */
export function recompute(stored: HoursSavedReport, input: ReportInput): boolean {
  const fresh = report(input);
  return jcs({ ...stored, final: false }) === jcs(fresh);
}

/**
 * Evidence for one workflow version (ADR 0109 §7): its baseline with samples and every run in the period, sorted by
 * endedAt then runId. Paging is the API's job; `page.nextCursor` is null here.
 */
export function evidence(
  input: Pick<ReportInput, "runs" | "reviews" | "samples" | "estimates" | "period" | "timezone"> & {
    readonly workflowId: string;
    readonly version: number;
  },
): HoursSavedEvidence {
  assertPeriod(input.period);
  const entries = baselinesFor(
    input.samples.filter((s) => s.workflowId === input.workflowId && s.version === input.version),
    input.estimates.filter((e) => e.workflowId === input.workflowId && e.version === input.version),
    [],
  );
  const b = entries[0]?.baseline ?? baseline([], null);
  const runs = input.runs.filter(
    (r) => r.run.workflowId === input.workflowId && r.run.version === input.version && inPeriod(r.run.endedAt, input.period, input.timezone),
  );
  const rows = buildRows(runs, input.reviews, [{ workflowId: input.workflowId, version: input.version, baseline: b }]);
  rows.sort((x, y) => x.endedAt - y.endedAt || compareCodeUnits(x.id, y.id));
  return {
    computation: COMPUTATION,
    workflowId: input.workflowId,
    version: input.version,
    baseline: { source: b.source, n: b.n, medianSeconds: b.median, q1: b.q1, q3: b.q3, grade: b.grade, samples: b.samples },
    runs: rows.map((r) => ({
      runId: r.id,
      endedAt: r.endedAt,
      outcome: r.outcome,
      itemsSucceeded: r.itemsSucceeded,
      baselineSeconds: r.baselineSeconds,
      residualSeconds: r.residual,
      savedSeconds: r.saved,
      note: r.note,
    })),
    page: { nextCursor: null },
  };
}
