import type { App, Deps } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { notFound, page, pageParams } from "../../schema/http.ts";
import { afterCursor, allow, ensureDepartments, idParam } from "./util.ts";

interface JobRole {
  id: string;
  name: string;
  departmentId: string;
  roleIdentityIds: string[];
  holderPersonIds: string[];
}

const JR = "offload/stage2/job-role.schema.json";

async function selectJobRoles(tx: Tx, where: unknown, limit: number): Promise<JobRole[]> {
  const rows: Array<Record<string, unknown>> = await tx`select j.id, j.name, j.department_id,
      coalesce((select jsonb_agg(r.id order by r.id) from role_identities r
        where r.tenant_id = j.tenant_id and r.job_role_id = j.id), '[]'::jsonb) as identities,
      coalesce((select jsonb_agg(h.person_id order by h.person_id) from job_role_holders h
        where h.tenant_id = j.tenant_id and h.job_role_id = j.id), '[]'::jsonb) as holders
    from job_roles j where ${where} order by j.id limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    departmentId: r.department_id as string,
    roleIdentityIds: r.identities as string[],
    holderPersonIds: r.holders as string[],
  }));
}

export async function jobRoleById(tx: Tx, id: string): Promise<JobRole> {
  const [j] = await selectJobRoles(tx, tx`j.id = ${id}`, 1);
  if (!j) throw notFound();
  return j;
}

export function jobRoleRoutes(app: App, deps: Deps): void {
  app.get("/v1/job-roles", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = afterCursor(cursor);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const dp = c.get("scope") === "Dp";
      const rows = await selectJobRoles(
        tx,
        tx`(${after}::uuid is null or j.id > ${after}::uuid)
          and (${dp} = false or j.department_id in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid))`,
        limit + 1,
      );
      return page(rows, limit, (l) => ({ id: l.id }));
    });
    return reply(c, deps, 200, out, "offload/control/job-role-list.json");
  });

  app.post("/v1/job-roles", async (c) => {
    const input = await body<{ name: string; departmentId: string }>(c, deps, "offload/control/job-role-create.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      allow(c, p, { departmentId: input.departmentId });
      await ensureDepartments(tx, [input.departmentId]);
      const [j] = await tx`insert into job_roles (tenant_id, name, department_id)
        values (current_setting('app.tenant_id')::uuid, ${input.name}, ${input.departmentId}) returning id`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "job_role.create",
        resource: { type: "job_role", id: j!.id },
        detail: { name: input.name, departmentId: input.departmentId },
      });
      return jobRoleById(tx, j!.id);
    });
    return reply(c, deps, 201, out, JR);
  });

  app.patch("/v1/job-roles/:id", async (c) => {
    const id = idParam(c);
    const input = await body<{ name?: string; departmentId?: string }>(c, deps, "offload/control/job-role-patch.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      const cur = await jobRoleById(tx, id);
      allow(c, p, { departmentId: cur.departmentId });
      if (input.departmentId) {
        allow(c, p, { departmentId: input.departmentId });
        await ensureDepartments(tx, [input.departmentId]);
      }
      await tx`update job_roles set name = ${input.name ?? cur.name}, department_id = ${input.departmentId ?? cur.departmentId}
        where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "job_role.update",
        resource: { type: "job_role", id },
        detail: { fields: Object.keys(input).sort() },
      });
      return jobRoleById(tx, id);
    });
    return reply(c, deps, 200, out, JR);
  });
}
