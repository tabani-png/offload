// GET /v1/metrics/hours-saved and /evidence (ADR 0109). Every number comes from packages/hours-saved on the stored
// rows; this file only selects the rows in scope, applies access rules and pages the evidence list.
import type { Context } from "hono";
import { principalOf, reply, tenantTx, type App, type AppEnv, type Deps } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { HttpError, invalid, page, pageParams } from "../../schema/http.ts";
import {
  evidence, report, type HoursSavedReport, type Period, type ReportInput, type Scope,
} from "../../../../packages/hours-saved/src/index.ts";
import { aggregateRead, loadInputs, loadReviews, loadRuns, loadSamples, withAggregateRead } from "./load.ts";
import {
  bounds, checkGroupScope, childrenOf, monthOf, parsePeriod, parseScope, personRead, tenantSettings,
} from "./scope.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** hours-saved-evidence.schema.json caps the sample list. */
const MAX_SAMPLES = 500;

/** The hs-1 input for a group scope over a period: every run of the tenant in the period (scope selection is hs-1's). */
export async function groupInput(tx: Tx, scope: Scope, period: Period, tz: string, floor: number): Promise<ReportInput> {
  const rows = await loadInputs(tx, bounds(period, tz));
  return { ...rows, estimates: [], workflows: [], scope, children: await childrenOf(tx, scope), period, timezone: tz, floor };
}

/** A month's report is final when the nightly recompute matched it and nothing arrived since (ADR 0109 §11). */
async function isFinal(tx: Tx, scope: Scope, period: Period, digest: string): Promise<boolean> {
  const month = monthOf(period);
  if (month === null || scope.type === "person") return false;
  const [s] = await tx`select final, stale, inputs_digest from metric_snapshots
    where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
  return !!s && s.final === true && s.stale === false && s.inputs_digest === digest;
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
    const r = report(await groupInput(tx, scope, period, timezone, floor));
    return { ...r, final: await isFinal(tx, scope, period, r.inputsDigest) };
  });
}

/**
 * Evidence for one workflow version: its baseline (every sample, from every device: counted) and the runs in the
 * caller's scope (listed). Runs of people outside the scope are never listed. Below the group floor of people in scope
 * the answer is 422 group_floor, except a member's own runs (S).
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
    const reviews = await loadReviews(tx, runs.map((r) => r.run.runId));
    const samples = await withAggregateRead(tx, () => loadSamples(tx, [workflow]));
    const ev = evidence({ runs, reviews, samples, estimates: [], period, timezone, workflowId, version });
    const start = after === null ? 0 : ev.runs.findIndex((r) => r.endedAt > after.e || (r.endedAt === after.e && r.runId > after.r));
    const rest = start < 0 ? [] : ev.runs.slice(start, start + limit + 1);
    const pg = page(rest, limit, (l) => ({ e: l.endedAt, r: l.runId }));
    return {
      ...ev,
      baseline: { ...ev.baseline, samples: ev.baseline.samples.slice(0, MAX_SAMPLES) },
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
