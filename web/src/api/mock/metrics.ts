// Mock metrics: hs-1 shaped reports computed from the fixture workflows. The arithmetic follows ADR 0109 (integer
// seconds, median/quartile rules, display rounding) so the screens can be checked against plain numbers. The real
// numbers come from packages/hours-saved via the control plane (S2-05); S2-11 swaps this module out.

import type {
  AdoptionReport, Grade, HoursSavedEvidence, HoursSavedReport, HoursValue, Scope, Suppressed, WorkingTimeReport,
} from "../types.ts";
import {
  DAY_MS, MONTHS, NOW, TIMEZONE, WORKFLOW_SPECS, departments, jobRoles, people, tenant, type WorkflowSpec,
} from "./fixtures.ts";
import { hex32, hex64, ulid, uuid } from "./ids.ts";
import { displayHours } from "../../lib/format.ts";

const FLOOR = (): number => tenant.groupFloor;
const suppressed = (reason: Suppressed["reason"] = "group_floor"): Suppressed => ({ suppressed: true, reason });

/** ADR 0109 §1 median: n even → floor of the mean of the two middle values. */
export function median(d: number[]): number {
  const s = [...d].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? s[(n - 1) / 2]! : Math.floor((s[n / 2 - 1]! + s[n / 2]!) / 2);
}

/** ADR 0109 §1 nearest-rank quantile: d[ceil(p·n) − 1]. */
export function nearestRank(d: number[], p: number): number {
  const s = [...d].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

/** ADR 0109 §2. */
export function gradeFor(source: "observed" | "user_estimate" | "default", samples: number[]): Grade | null {
  if (source === "user_estimate") return "C";
  if (source === "default") return null;
  const m = median(samples);
  const iqr = nearestRank(samples, 0.75) - nearestRank(samples, 0.25);
  return samples.length >= 5 && 2 * iqr <= m ? "A" : "B";
}

const counted = (s: WorkflowSpec) => s.state === "role" || s.state === "retired";

function monthIndexes(from: string, toExclusive: string): number[] {
  return MONTHS.map((m, i) => [`${m}-01`, i] as const).filter(([d]) => d >= from && d < toExclusive).map(([, i]) => i);
}

export function headcount(departmentId: string): number {
  return people.filter((p) => p.departmentId === departmentId && p.state !== "departed").length;
}

function holdersOf(jobRoleId: string): number {
  return jobRoles.find((j) => j.id === jobRoleId)?.holderPersonIds.length ?? 0;
}

/** Distinct people in a job role with data in the given months: its busiest workflow's users, at most its holders. */
function roleWithData(jobRoleId: string, months: number[]): number {
  const users = WORKFLOW_SPECS
    .filter((s) => counted(s) && s.jobRoleId === jobRoleId && months.some((m) => (s.monthly[m] ?? 0) > 0))
    .reduce((a, s) => Math.max(a, s.users), 0);
  return Math.min(holdersOf(jobRoleId), users);
}

function deptWithData(departmentId: string, months: number[]): number {
  const n = jobRoles.filter((j) => j.departmentId === departmentId).reduce((a, j) => a + roleWithData(j.id, months), 0);
  return Math.min(headcount(departmentId), n);
}

/**
 * What the group floor counts (ADR 0103 §5, ADR 0111 §5): distinct people with data in the period, not headcount. A
 * department of 14 where nobody ran a workflow in the period is under the floor.
 */
export function peopleWithData(scope: Scope, from: string, toExclusive: string): number {
  const months = monthIndexes(from, toExclusive);
  if (scope.type === "company") return departments.reduce((a, d) => a + deptWithData(d.id, months), 0);
  if (scope.type === "department") return deptWithData(scope.id ?? "", months);
  if (scope.type === "job_role") return roleWithData(scope.id ?? "", months);
  return 1;
}

function value(specs: WorkflowSpec[], months: number[], peopleCount: number, share = 1): HoursValue {
  const v: HoursValue = {
    seconds: 0, hours: 0, byGrade: { A: 0, B: 0, C: 0 }, bySource: { observed: 0, user_estimate: 0 },
    byRuntime: { mac: 0, cloud: 0 }, overnightSeconds: 0,
    runs: { success: 0, failed: 0, cancelled: 0, rejected: 0, capped: 0 }, people: peopleCount,
  };
  for (const s of specs) {
    for (const m of months) {
      const sec = Math.round((s.monthly[m] ?? 0) * share);
      if (sec === 0) continue;
      const grade = s.grade ?? "B";
      v.seconds += sec;
      v.byGrade[grade] += sec;
      if (grade === "C") v.bySource.user_estimate += sec;
      else v.bySource.observed += sec;
      const cloud = Math.round(sec * s.cloudShare);
      v.byRuntime.cloud += cloud;
      v.byRuntime.mac += sec - cloud;
      v.overnightSeconds += Math.round(sec * s.overnightShare);
      const ok = Math.max(1, Math.round(sec / s.secondsPerRun));
      v.runs.success += ok;
      const bad = Math.round(ok * s.failRate);
      v.runs.failed += Math.ceil(bad / 2);
      v.runs.rejected += Math.floor(bad / 2);
      v.runs.cancelled += m % 2 === 0 ? 1 : 0;
      v.runs.capped += s.cloudShare > 0.6 && m === months[months.length - 1] ? 1 : 0;
    }
  }
  v.hours = displayHours(v.seconds);
  return v;
}

/** Complementary suppression: one hidden cell among visible siblings could be derived from the total, so hide one more. */
function complementary<T extends { value: HoursValue | Suppressed; size: number }>(cells: T[]): T[] {
  const hidden = cells.filter((c) => "suppressed" in c.value);
  if (hidden.length !== 1 || cells.length < 2) return cells;
  const next = cells
    .filter((c) => !("suppressed" in c.value))
    .reduce<T | null>((min, c) => (min === null || c.size < min.size ? c : min), null);
  if (next) next.value = suppressed();
  return cells;
}

function periodOf(from: string, toExclusive: string) {
  return { from, toExclusive, timezone: TIMEZONE };
}

function isFinal(toExclusive: string): boolean {
  const currentMonthStart = `${MONTHS[MONTHS.length - 1]}-01`;
  return toExclusive <= currentMonthStart;
}

export function hoursSavedReport(scope: Scope, from: string, toExclusive: string): HoursSavedReport {
  const months = monthIndexes(from, toExclusive);
  const base = {
    computation: "hs-1" as const,
    inputsDigest: hex64(`hs1:${scope.type}:${scope.id}:${from}:${toExclusive}`),
    scope,
    period: periodOf(from, toExclusive),
    final: isFinal(toExclusive),
  };
  const top = (specs: WorkflowSpec[]) =>
    specs
      .map((s) => ({ s, seconds: months.reduce((a, m) => a + (s.monthly[m] ?? 0), 0) }))
      .filter((x) => x.seconds > 0 && x.s.grade !== null)
      // workflows ranked by hours saved (not people)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 5)
      .map(({ s, seconds }) => ({ workflowId: uuid(s.n), name: s.name, jobRoleId: s.jobRoleId, grade: s.grade as Grade, seconds }));
  const anomaliesFor = (specs: WorkflowSpec[]) => {
    const out: HoursSavedReport["anomalies"] = [];
    if (specs.some((s) => s.n === 306)) out.push({ code: "small_baseline", workflowId: uuid(306), detail: "The baseline for version 2 has 2 samples." });
    if (specs.some((s) => s.n === 302)) out.push({ code: "residual_zero_share", workflowId: uuid(302), detail: "Review time was 0 on more than 90% of runs in October." });
    return out;
  };

  if (scope.type === "company") {
    const specs = WORKFLOW_SPECS.filter(counted);
    const cells = complementary(departments.map((d) => {
      const n = deptWithData(d.id, months);
      const ds = specs.filter((s) => s.departmentId === d.id);
      const val: HoursValue | Suppressed = n < FLOOR() ? suppressed() : value(ds, months, n);
      return { scope: { type: "department" as const, id: d.id }, label: d.name, value: val, size: n };
    }));
    const visibleDepts = new Set(cells.filter((c) => !("suppressed" in c.value)).map((c) => c.scope.id));
    const total = value(specs, months, peopleWithData(scope, from, toExclusive));
    return {
      ...base, total,
      children: cells.map(({ scope: sc, label, value: v }) => ({ scope: sc, label, value: v })),
      topWorkflows: top(specs.filter((s) => s.departmentId !== null && visibleDepts.has(s.departmentId))),
      anomalies: anomaliesFor(specs.filter((s) => s.departmentId !== null && visibleDepts.has(s.departmentId))),
    };
  }

  if (scope.type === "department") {
    const n = deptWithData(scope.id ?? "", months);
    const specs = WORKFLOW_SPECS.filter((s) => counted(s) && s.departmentId === scope.id);
    if (n < FLOOR()) return { ...base, total: suppressed(), children: [], topWorkflows: [], anomalies: [] };
    const cells = complementary(jobRoles.filter((j) => j.departmentId === scope.id).map((j) => {
      const size = roleWithData(j.id, months);
      const js = specs.filter((s) => s.jobRoleId === j.id);
      const val: HoursValue | Suppressed = size < FLOOR() ? suppressed() : value(js, months, size);
      return { scope: { type: "job_role" as const, id: j.id }, label: j.name, value: val, size };
    }));
    const visibleRoles = new Set(cells.filter((c) => !("suppressed" in c.value)).map((c) => c.scope.id));
    return {
      ...base,
      total: value(specs, months, n),
      children: cells.map(({ scope: sc, label, value: v }) => ({ scope: sc, label, value: v })),
      topWorkflows: top(specs.filter((s) => s.jobRoleId !== null && visibleRoles.has(s.jobRoleId))),
      anomalies: anomaliesFor(specs),
    };
  }

  if (scope.type === "job_role") {
    const size = roleWithData(scope.id ?? "", months);
    const specs = WORKFLOW_SPECS.filter((s) => counted(s) && s.jobRoleId === scope.id);
    if (size < FLOOR()) return { ...base, total: suppressed(), children: [], topWorkflows: [], anomalies: [] };
    return { ...base, total: value(specs, months, size), children: [], topWorkflows: top(specs), anomalies: anomaliesFor(specs) };
  }

  // person: their job roles' workflows, at their share of each workflow's users.
  const person = people.find((p) => p.id === scope.id);
  const specs = WORKFLOW_SPECS.filter((s) => counted(s) && s.jobRoleId !== null && person?.jobRoleIds.includes(s.jobRoleId));
  const total: HoursValue = { ...value([], months, 1) };
  for (const s of specs) {
    const v = value([s], months, 1, 1 / Math.max(1, s.users));
    total.seconds += v.seconds;
    for (const g of ["A", "B", "C"] as const) total.byGrade[g] += v.byGrade[g];
    total.bySource.observed += v.bySource.observed;
    total.bySource.user_estimate += v.bySource.user_estimate;
    total.byRuntime.mac += v.byRuntime.mac;
    total.byRuntime.cloud += v.byRuntime.cloud;
    total.overnightSeconds += v.overnightSeconds;
    for (const k of ["success", "failed", "cancelled", "rejected", "capped"] as const) total.runs[k] += v.runs[k];
  }
  total.hours = displayHours(total.seconds);
  return {
    ...base, total, children: [],
    topWorkflows: specs.map((s) => ({ workflowId: uuid(s.n), name: s.name, jobRoleId: s.jobRoleId, grade: s.grade ?? "B", seconds: Math.round(months.reduce((a, m) => a + (s.monthly[m] ?? 0), 0) / Math.max(1, s.users)) })).slice(0, 10),
    anomalies: [],
  };
}

/**
 * People behind a workflow's evidence: the people using it, at most its job role's holders and its department's headcount. A
 * proposal belongs to one person. Evidence for a group under the floor is refused with group_floor (decided
 * 2026-10-25: the floor applies to evidence like every other aggregate; self-view is S2-11's concern).
 */
export function evidenceGroupSize(workflowId: string): number {
  const s = WORKFLOW_SPECS.find((x) => uuid(x.n) === workflowId);
  if (!s || s.jobRoleId === null || s.departmentId === null) return 1;
  return Math.min(s.users, holdersOf(s.jobRoleId), headcount(s.departmentId));
}

export function evidence(workflowId: string, version: number): HoursSavedEvidence | undefined {
  const s = WORKFLOW_SPECS.find((x) => uuid(x.n) === workflowId);
  if (!s || version < 1 || version > s.versions) return undefined;
  const source = s.grade === "C" ? "user_estimate" : s.grade === null ? "default" : "observed";
  const spread = s.grade === "A" ? [0.92, 0.97, 1, 1.03, 1.06, 0.95, 1.01, 0.99, 1.08, 0.94, 1.02, 1.04] : [0.55, 1, 1.6, 2.1];
  const samples = source === "observed"
    ? spread.map((f, i) => ({ instanceRef: hex32(`inst:${s.n}:${i}`), activeSeconds: Math.round(s.secondsPerRun * f), day: `2026-0${4 + (i % 3)}-${String(10 + i).padStart(2, "0")}` }))
    : [];
  const d = samples.map((x) => x.activeSeconds);
  const baselineSeconds = source === "observed" ? median(d) : source === "user_estimate" ? s.secondsPerRun : 0;
  const runs: HoursSavedEvidence["runs"] = [];
  for (let i = 0; i < 14; i++) {
    const items = 1 + ((i * 5 + s.n) % 6);
    const failed = i === 6;
    const notReviewed = i === 2 || i === 9;
    const policy = s.overnightShare > 0.4 && i % 4 === 1;
    const residual = failed || notReviewed ? null : policy ? 20 : 45 + ((i * 37 + s.n) % 240);
    const outcome = failed ? "failed" : "success";
    const saved = outcome === "success" && residual !== null ? Math.max(0, baselineSeconds * items - residual) : 0;
    runs.push({
      runId: ulid(50_000 + s.n * 100 + i), endedAt: NOW - (i + 1) * DAY_MS + (i % 3) * 3600_000, outcome,
      itemsSucceeded: failed ? 0 : items, baselineSeconds, residualSeconds: residual, savedSeconds: saved,
      note: notReviewed ? "not_reviewed_yet" : policy ? "policy_committed" : null,
    });
  }
  return {
    computation: "hs-1", workflowId, version,
    baseline: {
      source, n: samples.length, medianSeconds: baselineSeconds,
      q1: source === "observed" ? nearestRank(d, 0.25) : baselineSeconds,
      q3: source === "observed" ? nearestRank(d, 0.75) : baselineSeconds,
      grade: gradeFor(source, d), samples,
    },
    runs,
    page: { nextCursor: null },
  };
}

function scopeSize(scope: Scope): number {
  if (scope.type === "company") return people.length;
  if (scope.type === "department") return headcount(scope.id ?? "");
  if (scope.type === "job_role") return holdersOf(scope.id ?? "");
  return 1;
}

export function adoption(scope: Scope, from: string, toExclusive: string): AdoptionReport {
  const n = scopeSize(scope);
  const withData = peopleWithData(scope, from, toExclusive);
  const period = { from, toExclusive };
  if (scope.type !== "company" && withData < FLOOR()) return { scope, period, value: suppressed() };
  const specs = WORKFLOW_SPECS.filter((s) => s.state === "role" && (scope.type === "company"
    || (scope.type === "department" && s.departmentId === scope.id) || (scope.type === "job_role" && s.jobRoleId === scope.id)));
  const users = Math.min(n, withData);
  const fail = specs.length ? specs.reduce((a, s) => a + s.failRate, 0) / specs.length : 0;
  return {
    scope, period,
    value: {
      peopleWithActiveWorkflow: users, peopleTotal: n, workflowsActive: specs.length,
      runsPerWeek: Math.round(specs.reduce((a, s) => a + (s.monthly[5] ?? 0) / s.secondsPerRun, 0) / 3.6 * 10) / 10,
      successRate: Math.round((1 - fail) * 1000) / 1000, rejectionRate: Math.round(fail * 0.4 * 1000) / 1000,
      medianResidualSeconds: 95 + specs.length * 7,
    },
  };
}

export function workingTime(scope: Scope, from: string, toExclusive: string): WorkingTimeReport {
  const n = scope.type === "person" ? 1 : peopleWithData(scope, from, toExclusive);
  const period = { from, toExclusive };
  if (scope.type !== "person" && n < FLOOR()) return { scope, period, value: suppressed() };
  const seed = (scope.id ?? "company").charCodeAt(scope.id ? scope.id.length - 1 : 0) % 7;
  return { scope, period, value: { people: n, medianActiveMinutesPerDay: 372 + seed * 6, p25: 318 + seed * 4, p75: 421 + seed * 5 } };
}
