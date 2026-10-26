// GET /v1/metrics/hours-saved and /evidence (ADR 0109). Every number comes from packages/hours-saved on the stored
// rows; this file only selects the rows in scope, applies access rules and pages the evidence list.
import type { Context } from "hono";
import { principalOf, reply, tenantTx, type App, type AppEnv, type Deps } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { HttpError, invalid, page, pageParams } from "../../schema/http.ts";
import {
  SUPPRESSED, anomalies, baselinesFor, buildRows, cellOf, evidence, inScope, isSuppressed, report, reportInputsDigest, selectRows,
  type Anomaly, type HoursSavedReport, type Period, type ReportInput, type RunInput, type RunRow, type Scope,
} from "../../../../packages/hours-saved/src/index.ts";
import { COMPANY, childrenIn, floorNode, hiddenInTree, loadHierarchy, type Cells, type Hierarchy } from "./floor.ts";
import { aggregateRead, loadInputs, loadReviews, loadRuns, loadSamples, withAggregateRead } from "./load.ts";
import {
  bounds, checkGroupScope, monthOf, parsePeriod, parseScope, personRead, tenantSettings,
} from "./scope.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** hours-saved-evidence.schema.json caps the sample list. */
const MAX_SAMPLES = 500;
/** hours-saved-report.schema.json caps the children list; the floor is applied over all of them first. */
const MAX_CHILDREN = 500;
/** hours-saved-report.schema.json caps the anomaly list. */
const MAX_ANOMALIES = 100;

/**
 * The hs-1 input for a group scope over a period: every run of the tenant in the period (scope selection is hs-1's)
 * and every child of the scope (no page of them: the floor must see them all).
 */
export async function groupInput(tx: Tx, scope: Scope, period: Period, tz: string, floor: number, h?: Hierarchy): Promise<ReportInput> {
  const rows = await loadInputs(tx, bounds(period, tz));
  const children = childrenIn(h ?? (await loadHierarchy(tx)), scope);
  return { ...rows, estimates: [], workflows: [], scope, children, period, timezone: tz, floor };
}

/** The rows report() computes from, and the cells of any group scope over those rows or a subset of them. */
function hoursCells(input: ReportInput): { rows: RunRow[]; sel: (rs: readonly RunRow[], s: Scope) => RunRow[]; over: (base: readonly RunRow[]) => Cells } {
  const rows = buildRows(input.runs, input.reviews, baselinesFor(input.samples, input.estimates, input.runs));
  const sel = (rs: readonly RunRow[], s: Scope) => selectRows(rs, s, input.period, input.timezone);
  const over = (base: readonly RunRow[]): Cells => ({
    cell: (s, parent) => cellOf(sel(parent === null ? base : sel(base, parent), s)),
    rest: (parent, kids) => cellOf(sel(base, parent).filter((r) => !kids.some((k) => inScope(r, k)))),
  });
  return { rows, sel, over };
}

/**
 * Whether a workflow-keyed figure (a top workflow's seconds, a workflow anomaly) may be shown in a visible group scope
 * (PR #9 rounds 4-7). `behind` picks the runs behind the figure. The scope needs at least `floor` people behind it, and
 * the figure depends only on the scope's own subtree: a department lists it when its listed job roles (shown in its
 * report, each with floor people behind it) leave 0 or at least floor people unaccounted for. The company does the same
 * over everything listed below it: listed departments and, under an unlisted department, its listed job roles. So no
 * subtraction of listed figures isolates 1 to floor-1 people, and a department's list never moves with data of another
 * department (round 6); only the company's does, and the company contains them.
 */
function workflowLister(v: GroupView, floor: number): (scope: Scope, behind: (r: RunRow) => boolean) => boolean {
  const all = v.cells.over(v.cells.rows);
  const people = (rs: readonly RunRow[]) => new Set(rs.map((r) => r.personId)).size;
  let depts: Set<string> | null = null;
  const deptShown = (id: string) => {
    depts ??= new Set(floorNode(COMPANY, null, v.h.departments, all, floor).children.filter((c) => !isSuppressed(c.value)).map((c) => c.scope.id!));
    return depts.has(id);
  };
  const roles = new Map<string, Set<string>>();
  const rolesShown = (deptId: string) => {
    let set = roles.get(deptId);
    if (!set) {
      const dept: Scope = { type: "department", id: deptId };
      set = new Set(floorNode(dept, COMPANY, childrenIn(v.h, dept), all, floor).children
        .filter((c) => !isSuppressed(c.value) && all.cell(c.scope, null).people === (c.value as { people: number }).people)
        .map((c) => c.scope.id!));
      roles.set(deptId, set);
    }
    return set;
  };
  const listed = (scope: Scope, behind: (r: RunRow) => boolean): boolean => {
    const rows = v.cells.sel(v.cells.rows.filter(behind), scope);
    if (people(rows) < floor) return false;
    if (scope.type === "job_role" || scope.type === "person") return true;
    // Everyone a reader can subtract from this node: its listed children and, under an unlisted department, that
    // department's listed job roles (round 7: a role listed below an unlisted department is still subtractable).
    const covered = new Set<string>();
    const cover = (c: Scope) => {
      for (const r of v.cells.sel(rows, c)) covered.add(r.personId);
    };
    const roleListed = (deptId: string, role: Scope) => rolesShown(deptId).has(role.id!) && listed(role, behind);
    if (scope.type === "department") {
      for (const k of childrenIn(v.h, scope)) if (roleListed(scope.id!, k.scope)) cover(k.scope);
    } else {
      for (const d of v.h.departments) {
        if (!deptShown(d.scope.id!)) continue;
        if (listed(d.scope, behind)) cover(d.scope);
        else for (const k of childrenIn(v.h, d.scope)) if (roleListed(d.scope.id!, k.scope)) cover(k.scope);
      }
    }
    const left = people(rows.filter((r) => !covered.has(r.personId)));
    return left === 0 || left >= floor;
  };
  return listed;
}

/**
 * Anomalies a visible group may show. residual_zero_share is dropped: its detail is one person's counts ("residual 0 on
 * 4 of 4"), and no per-person number goes into a group view (round 5). A workflow-keyed one follows workflowLister over
 * the runs behind it (who ran the workflow; for outcome_disagreement, whose runs disagree). Filtered over the whole
 * list, then cut to the schema's 100 (hs-1's report cuts first, so hidden entries could push visible ones out).
 */
function groupAnomalies(scope: Scope, v: GroupView, tz: string, listed: ReturnType<typeof workflowLister>): Anomaly[] {
  const disagrees = (r: RunRow) => r.deviceOutcome !== null && r.deviceOutcome !== r.outcome;
  return anomalies(v.cells.sel(v.cells.rows, scope), tz)
    .filter((a) => a.workflowId !== null && listed(scope, (r) => r.workflowId === a.workflowId && (a.code !== "outcome_disagreement" || disagrees(r))))
    .slice(0, MAX_ANOMALIES);
}

/** Does a stored run fall in a department or job role? (hs-1's inScope on the input side.) */
function runIn(r: RunInput, scope: Scope): boolean {
  if (scope.type === "department") return r.departmentId !== null && r.departmentId === scope.id;
  if (scope.type === "job_role") return r.jobRoleId !== null && r.jobRoleId === scope.id;
  return true;
}

/**
 * The inputsDigest a reader may see (PR #9 round 5): a digest of the inputs behind the cell shown and nothing else, so
 * it is no change oracle over rows the reader cannot see. A hidden cell gets the digest of no inputs; the company gets
 * hs-1's digest of every run (all of them are in its total); a department or job role gets the digest of its own runs,
 * their review events and the baseline samples of their workflow versions (baselines are workflow reference data).
 */
function visibleDigest(scope: Scope, input: ReportInput, r: HoursSavedReport, hidden: boolean): string {
  const none = { estimates: [], workflows: [] };
  if (hidden) return reportInputsDigest({ ...none, runs: [], reviews: [], samples: [] });
  if (scope.type === "company") return r.inputsDigest;
  const runs = input.runs.filter((x) => runIn(x, scope));
  const ids = new Set(runs.map((x) => x.run.runId));
  const versions = new Set(runs.map((x) => `${x.run.workflowId}@${x.run.version}`));
  return reportInputsDigest({
    ...none,
    runs,
    reviews: input.reviews.filter((e) => ids.has(e.runId)),
    samples: input.samples.filter((x) => versions.has(`${x.workflowId}@${x.version}`)),
  });
}

/** A group scope's report, its cells and floor state, and the digest a reader may see. Shared with the nightly job. */
export interface GroupView {
  input: ReportInput;
  r: HoursSavedReport;
  h: Hierarchy;
  cells: ReturnType<typeof hoursCells>;
  hidden: boolean;
  digest: string;
}

export async function groupView(tx: Tx, scope: Scope, period: Period, tz: string, floor: number, h?: Hierarchy): Promise<GroupView> {
  const hier = h ?? (await loadHierarchy(tx));
  const input = await groupInput(tx, scope, period, tz, floor, hier);
  const r = report(input);
  const cells = hoursCells(input);
  // Under the floor itself, or hidden in the company tree (ADR 0103 §5 across reads, floor.ts).
  const hidden = isSuppressed(r.total) || hiddenInTree(hier, scope, cells.over(cells.rows), floor);
  return { input, r, h: hier, cells, hidden, digest: visibleDigest(scope, input, r, hidden) };
}

/**
 * A month's report is final when the nightly recompute matched it and nothing arrived since (ADR 0109 §11). For the
 * visible company "since" is any new data in the tenant (all of it is in its total). Below it, and for any suppressed
 * cell, only the inputs behind the cell shown count (visibleDigest, stored as scope_digest by the nightly job, migration
 * 0506): data elsewhere must not move the flag, or it tells the reader that a hidden group sent something.
 */
async function isFinal(tx: Tx, scope: Scope, period: Period, digest: string, visible: string, hidden: boolean): Promise<boolean> {
  const month = monthOf(period);
  if (month === null || scope.type === "person") return false;
  const [s] = await tx`select final, stale, inputs_digest, scope_digest from metric_snapshots
    where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
  if (!s || s.final !== true) return false;
  if (scope.type !== "company" || hidden) return s.scope_digest === visible;
  if (s.stale !== false || s.inputs_digest !== digest) return false;
  // New data the nightly job has not taken in yet (migration 0502).
  const [d] = await tx`select exists (select 1 from metric_dirty where taken_at is null) as pending`;
  return d!.pending === false;
}

async function hoursSaved(c: Context<AppEnv>, deps: Deps): Promise<HoursSavedReport> {
  const scope = parseScope(c.req.query("scope"), ["company", "department", "job_role", "person"]);
  return tenantTx(c, deps, async (tx, p) => {
    const { timezone, floor } = await tenantSettings(tx);
    const period = parsePeriod(c, timezone, deps.clock.now());
    if (scope.type === "person") {
      const id = scope.id!;
      await personRead(c, deps, tx, p, id, { endpoint: "hours_saved", from: period.from, to: period.toExclusive });
      const rows = await loadInputs(tx, { ...bounds(period, timezone), personId: id });
      const r = report({ ...rows, estimates: [], workflows: [], scope, children: [], period, timezone, floor });
      return { ...r, final: false };
    }
    await checkGroupScope(c, tx, p, scope);
    await aggregateRead(tx);
    const v = await groupView(tx, scope, period, timezone, floor);
    const { input, r, cells } = v;
    const all = cells.over(cells.rows);
    const final = await isFinal(tx, scope, period, r.inputsDigest, v.digest, v.hidden);
    const inputsDigest = v.digest;
    // Hidden: nothing but the suppression marker, and a digest of no inputs.
    if (v.hidden) {
      const children = r.children.slice(0, MAX_CHILDREN).map((c) => ({ ...c, value: SUPPRESSED }));
      return { ...r, inputsDigest, total: SUPPRESSED, children, topWorkflows: [], anomalies: [], final };
    }
    // Children floored over the complete set and the remainder (floor.ts), and only then cut to what the schema holds.
    const children =
      scope.type === "company" || scope.type === "department"
        ? floorNode(scope, scope.type === "company" ? null : COMPANY, input.children, all, floor).children.slice(0, MAX_CHILDREN)
        : [];
    const listed = workflowLister(v, floor);
    const topWorkflows = r.topWorkflows.filter((w) => listed(scope, (x) => x.workflowId === w.workflowId));
    return { ...r, inputsDigest, children, topWorkflows, anomalies: groupAnomalies(scope, v, timezone, listed), final };
  });
}

/**
 * Evidence for one workflow version: its baseline (every sample, from every device: counted; shown only from floor
 * senders) and the runs in the caller's scope (listed). Runs of people outside the scope are never listed. Below the
 * group floor of people in scope the answer is 422 group_floor, except a member's own runs (S).
 */
async function hoursEvidence(c: Context<AppEnv>, deps: Deps) {
  const workflowId = c.req.query("workflowId") ?? "";
  const version = Number(c.req.query("version"));
  if (!UUID.test(workflowId)) throw invalid("workflowId must be a uuid");
  if (!Number.isSafeInteger(version) || version < 1) throw invalid("version must be an integer >= 1");
  const { limit, cursor } = pageParams(c);
  const after = cursor === null ? null : cursorOf(cursor);
  const p0 = principalOf(c);
  const cell = c.get("scope");
  return tenantTx(c, deps, async (tx) => {
    const { timezone, floor } = await tenantSettings(tx);
    const period = parsePeriod(c, timezone, deps.clock.now());
    const workflow = { workflowId, version };
    if (cell !== "S") await aggregateRead(tx);
    const all = await loadRuns(tx, { ...bounds(period, timezone), workflow, ...(cell === "S" ? { personId: p0.personId } : {}) });
    const runs = cell === "Dp" ? all.filter((r) => r.departmentId !== null && p0.departmentScope.includes(r.departmentId)) : all;
    if (cell !== "S" && new Set(runs.map((r) => r.personId)).size < floor) {
      throw new HttpError(422, "group_floor", `fewer than ${floor} people ran this workflow in your scope in the period`);
    }
    // The baseline is the median of its samples, and every listed run carries it (baselineSeconds): with fewer than
    // `floor` people behind the samples it is someone's own timing (round 7). Then nothing is shown (no stats can be
    // dropped from the schema, and no number is made up), unless the reader is the only sender. A version with no
    // samples uses a default or estimate, which is no one's timing.
    const senders = (await withAggregateRead(tx, () => tx`select distinct person_id from baseline_samples
      where workflow_id = ${workflowId} and version = ${version}`)) as Array<{ person_id: string }>;
    const onlyMe = cell === "S" && senders.every((x) => x.person_id === p0.personId);
    if (senders.length > 0 && senders.length < floor && !onlyMe) {
      throw new HttpError(422, "group_floor", `fewer than ${floor} people sent baseline samples for this workflow version`);
    }
    const reviews = await loadReviews(tx, runs);
    const samples = await withAggregateRead(tx, () => loadSamples(tx, [workflow]));
    const ev = evidence({ runs, reviews, samples, estimates: [], period, timezone, workflowId, version });
    // Raw samples (each instance's seconds and day) only from floor senders; the reader's own, in member scope.
    const rawOk = senders.length >= floor || onlyMe;
    const start = after === null ? 0 : ev.runs.findIndex((r) => r.endedAt > after.e || (r.endedAt === after.e && r.runId > after.r));
    const rest = start < 0 ? [] : ev.runs.slice(start, start + limit + 1);
    const pg = page(rest, limit, (l) => ({ e: l.endedAt, r: l.runId }));
    return {
      ...ev,
      baseline: { ...ev.baseline, samples: rawOk ? ev.baseline.samples.slice(0, MAX_SAMPLES) : [] },
      runs: pg.items,
      page: pg.page,
    };
  });
}

function cursorOf(c: Record<string, unknown>): { e: number; r: string } {
  if (!Number.isSafeInteger(c.e) || typeof c.r !== "string") throw invalid("bad cursor");
  return { e: c.e as number, r: c.r };
}

export function hoursRoutes(app: App, deps: Deps): void {
  app.get("/v1/metrics/hours-saved", async (c) => reply(c, deps, 200, await hoursSaved(c, deps), "offload/stage2/hours-saved-report.schema.json"));
  app.get("/v1/metrics/hours-saved/evidence", async (c) =>
    reply(c, deps, 200, await hoursEvidence(c, deps), "offload/stage2/hours-saved-evidence.schema.json"));
}
