/**
 * Retention (ADR 0108 §7): per-person rows older than the tenant's per-person retention (default 90 days) and
 * working-time rows older than its working-time retention (default 30 days) are deleted; group aggregates, notices,
 * acknowledgements and the audit log are not touched here. Each pass is logged in `retention_runs` and audited.
 */
import type { Deps, Job } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { withTenant } from "../../db/tenant.ts";
import { DAY_MS, addDays, dayIn } from "./common.ts";

export interface RetentionTable {
  table: string;
  kind: "per_person" | "working_time";
}

/**
 * Per-person tables of the ingest slice (ADR 0101 §5, SPEC S2-05). A table that does not exist yet is skipped. The
 * time column is found by name: `day` (date), `*_at_ms` (epoch ms) or `*_at` (timestamptz).
 */
export const RETENTION_TABLES: readonly RetentionTable[] = [
  { table: "daily_aggregates", kind: "per_person" },
  { table: "person_daily_aggregates", kind: "per_person" },
  { table: "run_outcomes", kind: "per_person" },
  { table: "review_events", kind: "per_person" },
  { table: "baseline_samples", kind: "per_person" },
  { table: "working_time_aggregates", kind: "working_time" },
];

const TIME_COLUMNS = ["day", "ended_at_ms", "window_end_ms", "created_at_ms", "ended_at", "created_at"];

export interface RetentionResult {
  perPersonBefore: string;
  workingTimeBefore: string;
  deleted: Record<string, number>;
  skipped: string[];
}

async function timeColumn(tx: Tx, table: string): Promise<{ name: string; type: string } | null> {
  const cols = (await tx`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relname = ${table} and a.attnum > 0 and not a.attisdropped`) as Array<{ name: string; type: string }>;
  if (!cols.some((c) => c.name === "person_id")) return null;
  for (const want of TIME_COLUMNS) {
    const c = cols.find((x) => x.name === want);
    if (c) return c;
  }
  return null;
}

/** One retention pass for one tenant, as the app role with per-person reads opened for this transaction only. */
export async function runRetention(deps: Deps, tenantId: string, at = deps.clock.now()): Promise<RetentionResult> {
  return withTenant(deps.db, { tenantId, accessRole: "system" }, async (tx) => {
    await tx`select set_config('app.person_read', 'on', true)`;
    const [t] = await tx`select reporting_timezone, retention_per_person_days, retention_working_time_days from tenants`;
    const today = dayIn(t!.reporting_timezone as string, at);
    const days = { per_person: Number(t!.retention_per_person_days), working_time: Number(t!.retention_working_time_days) };
    const before = { per_person: addDays(today, -days.per_person), working_time: addDays(today, -days.working_time) };
    const deleted: Record<string, number> = {};
    const skipped: string[] = [];
    for (const r of RETENTION_TABLES) {
      const col = await timeColumn(tx, r.table);
      if (!col) {
        skipped.push(r.table);
        continue;
      }
      const cutoff =
        col.type === "date"
          ? before[r.kind]
          : col.name.endsWith("_ms")
            ? at - days[r.kind] * DAY_MS
            : new Date(at - days[r.kind] * DAY_MS).toISOString();
      const res = await tx.unsafe(`delete from ${JSON.stringify(r.table)} where ${JSON.stringify(col.name)} < $1`, [cutoff]);
      deleted[r.table] = res.count;
    }
    await tx`insert into retention_runs (tenant_id, ran_at_ms, per_person_before, working_time_before, deleted, skipped)
      values (current_setting('app.tenant_id')::uuid, ${at}, ${before.per_person}, ${before.working_time},
        ${deleted}::jsonb, ${skipped}::jsonb)`;
    await deps.ports.audit.write(tx, {
      actor: { type: "system", id: null, accessRole: null },
      action: "retention.run",
      resource: { type: "retention_run", id: null },
      detail: { perPersonBefore: before.per_person, workingTimeBefore: before.working_time, deleted, skipped },
    });
    return { perPersonBefore: before.per_person, workingTimeBefore: before.working_time, deleted, skipped };
  });
}

/**
 * Nightly at 03:17 UTC. The scheduler runs a job once per tenant (ModuleDef contract) but `Job.run(deps)` carries no
 * tenant, so the tenant comes as a second argument; without one the job refuses rather than guess.
 */
export const retentionJob: Job & { run(deps: Deps, tenantId?: string): Promise<void> } = {
  name: "compliance.retention",
  schedule: "17 3 * * *",
  async run(deps: Deps, tenantId?: string) {
    if (!tenantId) throw new Error("compliance.retention runs once per tenant: pass the tenant id");
    await runRetention(deps, tenantId);
  },
};
