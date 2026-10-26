// Nightly recompute (ADR 0109 §11): per tenant, the current and previous month for every group scope. A snapshot that
// new data made stale (metric_dirty) is replaced; otherwise hs-1's recompute() must reproduce it exactly, or an alert
// row is written and the month loses its "final" badge. Never corrects a number.
// Below the company a snapshot follows only the inputs behind the cell its reader sees (scope_digest, migration 0506):
// new data elsewhere in the tenant neither drops nor delays its final flag.
import type { Deps, Job } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { withTenant } from "../../db/tenant.ts";
import {
  jcs, localDay, recompute, sha256OfString, type HoursSavedReport, type Period, type Scope,
} from "../../../../packages/hours-saved/src/index.ts";
import { loadHierarchy } from "./floor.ts";
import { groupView } from "./hours.ts";
import { aggregateRead } from "./load.ts";
import { nextMonthStart, prevMonthStart, tenantSettings } from "./scope.ts";

async function groupScopes(tx: Tx): Promise<Scope[]> {
  const depts = await tx`select id from departments order by id`;
  const roles = await tx`select id from job_roles order by id`;
  return [
    { type: "company", id: null },
    ...depts.map((d: { id: string }) => ({ type: "department" as const, id: d.id })),
    ...roles.map((r: { id: string }) => ({ type: "job_role" as const, id: r.id })),
  ];
}

const reportDigest = (r: HoursSavedReport) => sha256OfString(jcs({ ...r, final: false }));

/** One tenant, in its own tenant transaction. */
export async function recomputeTenant(deps: Deps, tenantId: string): Promise<void> {
  await withTenant(deps.db, { tenantId, accessRole: "system" }, async (tx) => {
    // One recompute per tenant at a time. New data recorded so far marks every snapshot stale before any input is read;
    // an ingest committing after this point leaves its metric_dirty row for the next night (migration 0502).
    await tx`select pg_advisory_xact_lock(hashtextextended('metrics.recompute:' || current_setting('app.tenant_id'), 0))`;
    const taken = (await tx`update metric_dirty set taken_at = now() where taken_at is null returning id`).length > 0;
    if (taken) {
      await tx`update metric_snapshots set stale = true where stale = false`;
    }
    await aggregateRead(tx);
    const { timezone, floor } = await tenantSettings(tx);
    const thisMonth = `${localDay(deps.clock.now(), timezone).slice(0, 7)}-01`;
    const at = new Date(deps.clock.now());
    const h = await loadHierarchy(tx);
    for (const from of [prevMonthStart(thisMonth), thisMonth]) {
      const period: Period = { from, toExclusive: nextMonthStart(from) };
      const month = from.slice(0, 7);
      for (const scope of await groupScopes(tx)) {
        const v = await groupView(tx, scope, period, timezone, floor, h);
        const { input, r: fresh } = v;
        const [snap] = await tx`select report, stale, final, scope_digest from metric_snapshots
          where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid for update`;
        if (!snap) {
          await tx`insert into metric_snapshots (tenant_id, month, scope_type, scope_id, inputs_digest, report, computed_at, scope_digest)
            values (current_setting('app.tenant_id')::uuid, ${month}, ${scope.type}, ${scope.id}, ${fresh.inputsDigest},
              ${fresh}::jsonb, ${at}, ${v.digest})`;
        } else if (scope.type !== "company" || v.hidden) {
          // Below the company, or a suppressed company: it follows only the inputs behind the cell shown (scope_digest).
          // Unchanged inputs: a visible cell must reproduce what it showed (hs-1's digest of the whole tenant aside); a
          // hidden one shows nothing to check. Changed inputs are new data only if ingest recorded some since the last
          // run; otherwise its rows changed outside ingest. A mismatch, like the company's, is an alert: the stored
          // report stays, and the cell is not final until new data replaces it. Never a silent correction.
          const same = snap.scope_digest === v.digest;
          const stored = snap.report as HoursSavedReport;
          const matches = v.hidden || jcs({ ...stored, inputsDigest: fresh.inputsDigest, final: false }) === jcs({ ...fresh, final: false });
          const mismatch = same ? !matches : !taken && !v.hidden && snap.scope_digest !== null;
          if (mismatch) {
            await tx`insert into metric_alerts (tenant_id, code, month, scope_key, stored_digest, fresh_digest, at)
              values (current_setting('app.tenant_id')::uuid, 'recompute_mismatch', ${month},
                ${`${scope.type}:${scope.id ?? ""}`}, ${reportDigest(stored)}, ${reportDigest(fresh)}, ${at})
              on conflict (tenant_id, month, scope_key, stored_digest, fresh_digest) do nothing`;
            await tx`update metric_snapshots set final = false, stale = false, checked_at = ${at}
              where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
          } else if (same) {
            await tx`update metric_snapshots set final = true, stale = false, checked_at = ${at}
              where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
          } else {
            await tx`update metric_snapshots set inputs_digest = ${fresh.inputsDigest}, report = ${fresh}::jsonb,
                scope_digest = ${v.digest}, final = false, stale = false, computed_at = ${at}, checked_at = ${at}
              where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
          }
        } else if (snap.stale) {
          await tx`update metric_snapshots set inputs_digest = ${fresh.inputsDigest}, report = ${fresh}::jsonb, final = false,
              stale = false, computed_at = ${at}, checked_at = ${at}, scope_digest = ${v.digest}
            where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
        } else if (recompute(snap.report as HoursSavedReport, input)) {
          await tx`update metric_snapshots set final = true, checked_at = ${at}, scope_digest = ${v.digest}
            where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid
              and stale = false`;
        } else {
          const stored = snap.report as HoursSavedReport;
          await tx`insert into metric_alerts (tenant_id, code, month, scope_key, stored_digest, fresh_digest, at)
            values (current_setting('app.tenant_id')::uuid, 'recompute_mismatch', ${month},
              ${`${scope.type}:${scope.id ?? ""}`}, ${reportDigest(stored)}, ${reportDigest(fresh)}, ${at})
            on conflict (tenant_id, month, scope_key, stored_digest, fresh_digest) do nothing`;
          await tx`update metric_snapshots set final = false, checked_at = ${at}
            where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
        }
      }
    }
  });
}

/** Every tenant: the job lists tenant ids under app.job (migration 0501), then works tenant by tenant. */
export async function nightlyRecompute(deps: Deps): Promise<void> {
  const tenants = (await deps.db.begin("read only", async (tx) => {
    await tx`select set_config('app.job', 'metrics_recompute', true)`;
    return tx`select id from tenants order by id`;
  })) as Array<{ id: string }>;
  for (const t of tenants) await recomputeTenant(deps, t.id);
}

export const nightlyJob: Job = {
  name: "metrics.nightly_recompute",
  schedule: "30 2 * * *",
  run: nightlyRecompute,
};
