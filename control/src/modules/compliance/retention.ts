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
  /** The row's age: a `date` column, or epoch ms. */
  time: { column: string; type: "date" | "ms" };
  /** A child table goes with its parent row: deleted where the parent (same device and `key`) is past retention. */
  parent?: string;
  /** The column joining child to parent besides tenant and device (default `object_id`). */
  key?: string;
}

/**
 * S2-05's per-person tables (migrations 0501, 0505), children before their parents (their foreign keys). Every one
 * must exist: a missing table fails the pass rather than leaving its rows unpruned. A run's ownership claim
 * (run_owners) references the owning copy of the run, so it goes with that copy.
 */
export const RETENTION_TABLES: readonly RetentionTable[] = [
  { table: "run_owners", kind: "per_person", time: { column: "ended_at_ms", type: "ms" }, parent: "run_outcomes", key: "run_id" },
  { table: "run_outcomes", kind: "per_person", time: { column: "ended_at_ms", type: "ms" } },
  { table: "review_events", kind: "per_person", time: { column: "created_at_ms", type: "ms" } },
  { table: "baseline_sample_instances", kind: "per_person", time: { column: "window_end", type: "date" }, parent: "baseline_samples" },
  { table: "baseline_samples", kind: "per_person", time: { column: "window_end", type: "date" } },
  { table: "daily_aggregate_workflows", kind: "per_person", time: { column: "day", type: "date" }, parent: "daily_aggregates" },
  { table: "daily_aggregates", kind: "per_person", time: { column: "day", type: "date" } },
  { table: "working_time_aggregates", kind: "working_time", time: { column: "day", type: "date" } },
];

/** The role the deletes run as (migration 0801): offload_app may SET ROLE to it but holds no DELETE itself. */
const RETENTION_ROLE = "offload_retention";

export interface RetentionResult {
  perPersonBefore: string;
  workingTimeBefore: string;
  deleted: Record<string, number>;
}

async function missingTables(tx: Tx): Promise<string[]> {
  const names = RETENTION_TABLES.map((r) => r.table);
  const rows = (await tx`select t from jsonb_array_elements_text(${names}::jsonb) as t where to_regclass(quote_ident(t)) is null`) as Array<{ t: string }>;
  return rows.map((r) => r.t);
}

/** One retention pass for one tenant, with per-person reads opened for this transaction only. */
export async function runRetention(deps: Deps, tenantId: string, at = deps.clock.now()): Promise<RetentionResult> {
  return withTenant(deps.db, { tenantId, accessRole: "system" }, async (tx) => {
    const missing = await missingTables(tx);
    if (missing.length > 0) throw new Error(`compliance.retention: per-person tables missing: ${missing.join(", ")}`);
    await tx`select set_config('app.person_read', 'on', true)`;
    const [t] = await tx`select reporting_timezone, retention_per_person_days, retention_working_time_days from tenants`;
    const today = dayIn(t!.reporting_timezone as string, at);
    const days = { per_person: Number(t!.retention_per_person_days), working_time: Number(t!.retention_working_time_days) };
    const before = { per_person: addDays(today, -days.per_person), working_time: addDays(today, -days.working_time) };
    const deleted: Record<string, number> = {};
    await tx.unsafe(`set local role ${RETENTION_ROLE}`);
    for (const r of RETENTION_TABLES) {
      const cutoff = r.time.type === "date" ? before[r.kind] : at - days[r.kind] * DAY_MS;
      const col = JSON.stringify(r.time.column);
      const res = r.parent
        ? await tx.unsafe(
            `delete from ${JSON.stringify(r.table)} c using ${JSON.stringify(r.parent)} p
              where p.tenant_id = c.tenant_id and p.device_id = c.device_id and p.${JSON.stringify(r.key ?? "object_id")} = c.${JSON.stringify(r.key ?? "object_id")}
                and p.${col} < $1`,
            [cutoff],
          )
        : await tx.unsafe(`delete from ${JSON.stringify(r.table)} where ${col} < $1`, [cutoff]);
      deleted[r.table] = res.count;
    }
    await tx.unsafe("reset role");
    await tx`insert into retention_runs (tenant_id, ran_at_ms, per_person_before, working_time_before, deleted, skipped)
      values (current_setting('app.tenant_id')::uuid, ${at}, ${before.per_person}, ${before.working_time},
        ${deleted}::jsonb, '[]'::jsonb)`;
    await deps.ports.audit.write(tx, {
      actor: { type: "system", id: null, accessRole: null },
      action: "retention.run",
      resource: { type: "retention_run", id: null },
      detail: { perPersonBefore: before.per_person, workingTimeBefore: before.working_time, deleted },
    });
    return { perPersonBefore: before.per_person, workingTimeBefore: before.working_time, deleted };
  });
}

/** Every tenant id, read under app.job (migration 0801), the way S2-05's nightly recompute walks tenants. */
async function tenantIds(deps: Deps): Promise<string[]> {
  const rows = (await deps.db.begin("read only", async (tx) => {
    await tx`select set_config('app.job', 'compliance_retention', true)`;
    return tx`select id from tenants order by id`;
  })) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Nightly at 03:17 UTC. `Job.run(deps)` carries no tenant, so the job walks every tenant itself, each in its own
 * transaction. One tenant's failure does not stop the others; the job then fails, naming the tenants that did.
 */
export const retentionJob: Job = {
  name: "compliance.retention",
  schedule: "17 3 * * *",
  async run(deps: Deps) {
    const failed: string[] = [];
    for (const id of await tenantIds(deps)) {
      try {
        await runRetention(deps, id);
      } catch (e) {
        failed.push(`${id} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (failed.length > 0) throw new Error(`compliance.retention failed for ${failed.length} tenant(s): ${failed.join("; ")}`);
  },
};
