// GET /v1/metrics/adoption and /v1/metrics/working-time. Group views are floored on people with data in the period
// (ADR 0111 §5); working time counts only people whose jurisdiction has working_time on (ADR 0108).
import type { Context } from "hono";
import { reply, tenantTx, type App, type AppEnv, type Deps } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import {
  SUPPRESSED, baselinesFor, buildRows, cellOf, inScope, median, nearestRank, selectRows, type Scope,
} from "../../../../packages/hours-saved/src/index.ts";
import { hiddenInTree, loadHierarchy, peopleCell, type Cells } from "./floor.ts";
import { aggregateRead, loadAttribution, loadInputs } from "./load.ts";
import { bounds, checkGroupScope, parsePeriod, parseScope, periodDays, personRead, tenantSettings } from "./scope.ts";

const COMPANY: Scope = { type: "company", id: null };
const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

/** Does a person (by attribution) fall in a group scope? The rule hs-1's inScope() applies to runs. */
function member(a: { departmentId: string | null; jobRoleId: string | null } | undefined, personId: string, scope: Scope): boolean {
  if (!a) return false;
  switch (scope.type) {
    case "company":
      return true;
    case "department":
      return a.departmentId !== null && a.departmentId === scope.id;
    case "job_role":
      return a.jobRoleId !== null && a.jobRoleId === scope.id;
    case "person":
      return personId === scope.id;
  }
}

async function adoption(c: Context<AppEnv>, deps: Deps) {
  const scope = parseScope(c.req.query("scope"), ["company", "department", "job_role"]);
  return tenantTx(c, deps, async (tx, p) => {
    const { timezone, floor } = await tenantSettings(tx);
    const period = parsePeriod(c, timezone, deps.clock.now());
    await checkGroupScope(c, tx, p, scope);
    await aggregateRead(tx);
    const inputs = await loadInputs(tx, bounds(period, timezone));
    const company = selectRows(buildRows(inputs.runs, inputs.reviews, baselinesFor(inputs.samples, [], inputs.runs)), COMPANY, period, timezone);
    const who = await loadAttribution(tx);
    const allDaily = (await tx`select d.person_id, d.active_workflows, w.workflow_id, w.runs
      from daily_aggregates d left join daily_aggregate_workflows w
        on w.tenant_id = d.tenant_id and w.device_id = d.device_id and w.object_id = d.object_id
      where d.day >= ${period.from}::date and d.day < ${period.toExclusive}::date`) as Array<{
      person_id: string; active_workflows: number; workflow_id: string | null; runs: number | null;
    }>;
    const of = (s: Scope, parent: Scope | null) => ({
      rows: company.filter((r) => inScope(r, s) && (parent === null || inScope(r, parent))),
      daily: allDaily.filter((d) => member(who.get(d.person_id), d.person_id, s) && (parent === null || member(who.get(d.person_id), d.person_id, parent))),
    });
    const peopleWithData = (x: ReturnType<typeof of>) => new Set([...x.rows.map((r) => r.personId), ...x.daily.map((d) => d.person_id)]);
    const { rows, daily: inDaily } = of(scope, null);
    const withData = peopleWithData({ rows, daily: inDaily });
    const value = await (async () => {
      if (withData.size < floor) return SUPPRESSED;
      // Floored where the scope sits in the company tree, so a hidden department is not company minus the others.
      const cells: Cells = {
        cell: (s, parent) => peopleCell(peopleWithData(of(s, parent)).size),
        rest: (parent, kids) => {
          const x = of(parent, null);
          const outside = (a: ReturnType<typeof who.get>, id: string) => !kids.some((k) => member(a, id, k));
          return peopleCell(peopleWithData({
            rows: x.rows.filter((r) => !kids.some((k) => inScope(r, k))),
            daily: x.daily.filter((d) => outside(who.get(d.person_id), d.person_id)),
          }).size);
        },
      };
      if (hiddenInTree(await loadHierarchy(tx), scope, cells, floor)) return SUPPRESSED;
      const active = new Set([...rows.map((r) => r.personId), ...inDaily.filter((d) => d.active_workflows > 0).map((d) => d.person_id)]);
      const workflows = new Set([...rows.map((r) => r.workflowId), ...inDaily.filter((d) => (d.runs ?? 0) > 0).map((d) => d.workflow_id!)]);
      const head = await headcount(tx, scope, who);
      const runs = cellOf(rows).runs;
      const total = runs.success + runs.failed + runs.cancelled + runs.rejected + runs.capped;
      const residuals = rows.filter((r) => r.outcome === "success" && r.residual !== null).map((r) => r.residual!).sort((a, b) => a - b);
      return {
        peopleWithActiveWorkflow: active.size,
        peopleTotal: head,
        workflowsActive: workflows.size,
        runsPerWeek: round((total * 7) / periodDays(period), 2),
        successRate: total === 0 ? 0 : round(runs.success / total, 4),
        rejectionRate: total === 0 ? 0 : round(runs.rejected / total, 4),
        medianResidualSeconds: residuals.length === 0 ? 0 : median(residuals),
      };
    })();
    return { scope, period: { from: period.from, toExclusive: period.toExclusive }, value };
  });
}

/** People (active or leaving) in a scope: headcount, shown next to the people-with-data numbers. */
async function headcount(tx: Tx, scope: Scope, who: Awaited<ReturnType<typeof loadAttribution>>): Promise<number> {
  if (scope.type === "job_role") {
    const [r] = await tx`select count(distinct h.person_id)::int as n from job_role_holders h
      join people p on p.tenant_id = h.tenant_id and p.id = h.person_id
      where h.job_role_id = ${scope.id} and p.state in ('active', 'leaving')`;
    return r!.n as number;
  }
  const rows = await tx`select id from people where state in ('active', 'leaving')`;
  return rows.filter((r: { id: string }) => member(who.get(r.id), r.id, scope)).length;
}

async function workingTime(c: Context<AppEnv>, deps: Deps) {
  const scope = parseScope(c.req.query("scope"), ["company", "department", "person"]);
  return tenantTx(c, deps, async (tx, p) => {
    const { timezone, floor } = await tenantSettings(tx);
    const period = parsePeriod(c, timezone, deps.clock.now());
    if (scope.type === "person") {
      await personRead(c, deps, tx, p, scope.id!, { endpoint: "working_time", from: period.from, to: period.toExclusive });
    } else {
      await checkGroupScope(c, tx, p, scope);
      await aggregateRead(tx);
    }
    // Group scopes read the whole tenant, so the cell can be floored in the company tree below. One value per
    // person-day whatever the devices: the latest report (createdAt, then the device's seq).
    const rows = (await tx`select distinct on (w.person_id, w.day) w.person_id, w.active_minutes, p.department_id, p.jurisdiction
      from working_time_aggregates w join people p on p.tenant_id = w.tenant_id and p.id = w.person_id
      where w.day >= ${period.from}::date and w.day < ${period.toExclusive}::date
        and (${scope.type === "person" ? scope.id : null}::uuid is null or w.person_id = ${scope.type === "person" ? scope.id : null}::uuid)
      order by w.person_id, w.day, w.created_at_ms desc, w.seq desc, w.device_id`) as Array<{
      person_id: string; active_minutes: number; department_id: string | null; jurisdiction: string;
    }>;
    // Per-person data counts only where working_time is on for that person's jurisdiction (ADR 0111 §5).
    const on = new Map<string, boolean>();
    const all: typeof rows = [];
    for (const r of rows) {
      if (!on.has(r.jurisdiction)) on.set(r.jurisdiction, (await deps.ports.features.enabledFor(tx, r.jurisdiction)).has("working_time"));
      if (on.get(r.jurisdiction)) all.push(r);
    }
    const inDept = (s: Scope) => all.filter((r) => s.type !== "department" || r.department_id === s.id);
    const kept = inDept(scope);
    const people = new Set(kept.map((r) => r.person_id)).size;
    const minutes = kept.map((r) => r.active_minutes).sort((a, b) => a - b);
    // Working-time scopes stop at departments, so a cell under the company is the department's own cell, and the
    // company's remainder is the people in no department.
    const peopleOf = (rs: typeof all) => peopleCell(new Set(rs.map((r) => r.person_id)).size);
    const cells: Cells = {
      cell: (s) => peopleOf(inDept(s)),
      rest: (parent, kids) => peopleOf(inDept(parent).filter((r) => !kids.some((k) => k.type === "department" && r.department_id === k.id))),
    };
    const hidden = async () => hiddenInTree(await loadHierarchy(tx), scope, cells, floor);
    const value =
      scope.type !== "person" && (people < floor || (await hidden()))
        ? SUPPRESSED
        : minutes.length === 0
          ? { people, medianActiveMinutesPerDay: 0, p25: 0, p75: 0 }
          : { people, medianActiveMinutesPerDay: median(minutes), p25: nearestRank(minutes, 1, 4), p75: nearestRank(minutes, 3, 4) };
    return { scope, period: { from: period.from, toExclusive: period.toExclusive }, value };
  });
}

export function adoptionRoutes(app: App, deps: Deps): void {
  app.get("/v1/metrics/adoption", async (c) => reply(c, deps, 200, await adoption(c, deps), "offload/stage2/adoption-report.schema.json"));
  app.get("/v1/metrics/working-time", async (c) =>
    reply(c, deps, 200, await workingTime(c, deps), "offload/stage2/working-time-report.schema.json"));
}
