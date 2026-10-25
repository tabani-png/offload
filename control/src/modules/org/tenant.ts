import type { App, Deps } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { msNN } from "../../db/pool.ts";
import { conflict, forbidden, notFound } from "../../schema/http.ts";

interface TenantPatch {
  name?: string;
  reportingTimezone?: string;
  groupFloor?: number;
  identityAddon?: { sso?: boolean; directorySync?: boolean };
  retention?: { perPersonDays?: number; workingTimeDays?: number; groupMonths?: number };
  monthlyWorkerBudgetCents?: number;
}

async function tenantDto(tx: Tx) {
  const [t] = await tx`select * from tenants where id = current_setting('app.tenant_id')::uuid`;
  if (!t) throw notFound();
  return {
    id: t.id as string,
    name: t.name as string,
    createdAt: msNN(t.created_at),
    reportingTimezone: t.reporting_timezone as string,
    groupFloor: t.group_floor as number,
    identityAddon: { sso: t.identity_sso as boolean, directorySync: t.identity_directory_sync as boolean },
    retention: {
      perPersonDays: t.retention_per_person_days as number,
      workingTimeDays: t.retention_working_time_days as number,
      groupMonths: t.retention_group_months as number,
    },
    monthlyWorkerBudgetCents: Number(t.monthly_worker_budget_cents),
  };
}

export function tenantRoutes(app: App, deps: Deps): void {
  app.get("/v1/tenant", async (c) => {
    const out = await tenantTx(c, deps, (tx) => tenantDto(tx));
    return reply(c, deps, 200, out, "offload/stage2/tenant.schema.json");
  });

  app.patch("/v1/tenant", async (c) => {
    const patch = await body<TenantPatch>(c, deps, "offload/control/tenant-patch.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      if (p.accessRole !== "owner" && (patch.identityAddon !== undefined || patch.monthlyWorkerBudgetCents !== undefined)) {
        throw forbidden("only an owner may change identityAddon or monthlyWorkerBudgetCents");
      }
      const cur = await tenantDto(tx);
      if (patch.groupFloor !== undefined && patch.groupFloor < cur.groupFloor) {
        throw conflict("groupFloor can only be raised");
      }
      const r = patch.retention ?? {};
      for (const k of ["perPersonDays", "workingTimeDays", "groupMonths"] as const) {
        const v = r[k];
        if (v !== undefined && v > cur.retention[k]) throw conflict(`retention.${k} can only be lowered`);
      }
      await tx`update tenants set
          name = ${patch.name ?? cur.name},
          reporting_timezone = ${patch.reportingTimezone ?? cur.reportingTimezone},
          group_floor = ${patch.groupFloor ?? cur.groupFloor},
          identity_sso = ${patch.identityAddon?.sso ?? cur.identityAddon.sso},
          identity_directory_sync = ${patch.identityAddon?.directorySync ?? cur.identityAddon.directorySync},
          retention_per_person_days = ${r.perPersonDays ?? cur.retention.perPersonDays},
          retention_working_time_days = ${r.workingTimeDays ?? cur.retention.workingTimeDays},
          retention_group_months = ${r.groupMonths ?? cur.retention.groupMonths},
          monthly_worker_budget_cents = ${patch.monthlyWorkerBudgetCents ?? cur.monthlyWorkerBudgetCents}
        where id = current_setting('app.tenant_id')::uuid`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "tenant.update",
        resource: { type: "tenant", id: cur.id },
        detail: { fields: Object.keys(patch).sort() },
      });
      return tenantDto(tx);
    });
    return reply(c, deps, 200, out, "offload/stage2/tenant.schema.json");
  });
}
