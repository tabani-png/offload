// Nightly recompute (ADR 0109 §11): per tenant, the current and previous month for every group scope. A snapshot that
// new data made stale is replaced; otherwise hs-1's recompute() must reproduce it exactly, or an alert row is written
// and the month loses its "final" badge. Never corrects a number.
import type { Deps, Job } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { withTenant } from "../../db/tenant.ts";
import {
  jcs, localDay, recompute, report, sha256OfString, type HoursSavedReport, type Period, type Scope,
} from "../../../../packages/hours-saved/src/index.ts";
import { groupInput } from "./hours.ts";
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
    await aggregateRead(tx);
    const { timezone, floor } = await tenantSettings(tx);
    const thisMonth = `${localDay(deps.clock.now(), timezone).slice(0, 7)}-01`;
    const at = new Date(deps.clock.now());
    for (const from of [prevMonthStart(thisMonth), thisMonth]) {
      const period: Period = { from, toExclusive: nextMonthStart(from) };
      const month = from.slice(0, 7);
      for (const scope of await groupScopes(tx)) {
        const input = await groupInput(tx, scope, period, timezone, floor);
        const fresh = report(input);
        const [snap] = await tx`select report, stale from metric_snapshots
          where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid for update`;
        if (!snap) {
          await tx`insert into metric_snapshots (tenant_id, month, scope_type, scope_id, inputs_digest, report, computed_at)
            values (current_setting('app.tenant_id')::uuid, ${month}, ${scope.type}, ${scope.id}, ${fresh.inputsDigest},
              ${fresh}::jsonb, ${at})`;
        } else if (snap.stale) {
          await tx`update metric_snapshots set inputs_digest = ${fresh.inputsDigest}, report = ${fresh}::jsonb, final = false,
              stale = false, computed_at = ${at}, checked_at = ${at}
            where month = ${month} and scope_type = ${scope.type} and scope_id is not distinct from ${scope.id}::uuid`;
        } else if (recompute(snap.report as HoursSavedReport, input)) {
          await tx`update metric_snapshots set final = true, checked_at = ${at}
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
