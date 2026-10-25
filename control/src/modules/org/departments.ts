import type { App, Deps } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { conflict, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { afterCursor, idParam } from "./util.ts";

interface DeptInput {
  name?: string;
  parentId?: string | null;
  directoryGroups?: string[];
}

const DEPT = "offload/stage2/department.schema.json";

interface Department {
  id: string;
  name: string;
  parentId: string | null;
  directoryGroups: string[];
  leadPersonIds: string[];
}

async function selectDepartments(tx: Tx, where: unknown, limit: number): Promise<Department[]> {
  const rows: Array<Record<string, unknown>> = await tx`select d.id, d.name, d.parent_id,
      coalesce((select jsonb_agg(m.directory_group order by m.directory_group) from department_group_mappings m
        where m.tenant_id = d.tenant_id and m.department_id = d.id), '[]'::jsonb) as directory_groups,
      coalesce((select jsonb_agg(p.id order by p.id) from people p
        where p.tenant_id = d.tenant_id and p.dept_lead_of @> jsonb_build_array(d.id::text)), '[]'::jsonb) as leads
    from departments d where ${where} order by d.id limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    parentId: (r.parent_id as string | null) ?? null,
    directoryGroups: r.directory_groups as string[],
    leadPersonIds: r.leads as string[],
  }));
}

async function deptById(tx: Tx, id: string) {
  const [d] = await selectDepartments(tx, tx`d.id = ${id}`, 1);
  if (!d) throw notFound();
  return d;
}

async function checkParent(tx: Tx, id: string | null, parentId: string | null | undefined): Promise<void> {
  if (!parentId) return;
  if (parentId === id) throw invalid("a department cannot be its own parent");
  // Walk up from the new parent; meeting `id` would make a cycle.
  let cur: string | null = parentId;
  for (let i = 0; cur && i < 100; i++) {
    const [d]: Array<{ parent_id: string | null }> = await tx`select parent_id from departments where id = ${cur}`;
    if (!d) throw invalid(`unknown department ${cur}`);
    if (id && d.parent_id === id) throw invalid("department parent would create a cycle");
    cur = d.parent_id;
  }
}

async function setGroups(tx: Tx, deptId: string, groups: string[]): Promise<void> {
  await tx`delete from department_group_mappings where department_id = ${deptId}`;
  for (const g of new Set(groups)) {
    const [taken] = await tx`select department_id from department_group_mappings where directory_group = ${g}`;
    if (taken) throw conflict(`directory group ${g} is already mapped to another department`);
    await tx`insert into department_group_mappings (tenant_id, directory_group, department_id)
      values (current_setting('app.tenant_id')::uuid, ${g}, ${deptId})`;
  }
}

export function departmentRoutes(app: App, deps: Deps): void {
  app.get("/v1/departments", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = afterCursor(cursor);
    const out = await tenantTx(c, deps, async (tx) => {
      const rows = await selectDepartments(tx, tx`(${after}::uuid is null or d.id > ${after}::uuid)`, limit + 1);
      return page(rows, limit, (l) => ({ id: l.id }));
    });
    return reply(c, deps, 200, out, "offload/control/department-list.json");
  });

  app.post("/v1/departments", async (c) => {
    const input = await body<Required<Pick<DeptInput, "name">> & DeptInput>(c, deps, "offload/control/department-create.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      await checkParent(tx, null, input.parentId);
      const [d] = await tx`insert into departments (tenant_id, name, parent_id)
        values (current_setting('app.tenant_id')::uuid, ${input.name}, ${input.parentId ?? null}) returning id`;
      await setGroups(tx, d!.id, input.directoryGroups ?? []);
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "department.create",
        resource: { type: "department", id: d!.id },
        detail: { name: input.name },
      });
      return deptById(tx, d!.id);
    });
    return reply(c, deps, 201, out, DEPT);
  });

  app.patch("/v1/departments/:id", async (c) => {
    const id = idParam(c);
    const input = await body<DeptInput>(c, deps, "offload/control/department-patch.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      const cur = await deptById(tx, id);
      if (input.parentId !== undefined) await checkParent(tx, id, input.parentId);
      await tx`update departments set name = ${input.name ?? cur.name},
          parent_id = ${input.parentId === undefined ? cur.parentId : input.parentId}
        where id = ${id}`;
      if (input.directoryGroups) await setGroups(tx, id, input.directoryGroups);
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "department.update",
        resource: { type: "department", id },
        detail: { fields: Object.keys(input).sort() },
      });
      return deptById(tx, id);
    });
    return reply(c, deps, 200, out, DEPT);
  });

  app.delete("/v1/departments/:id", async (c) => {
    const id = idParam(c);
    await tenantTx(c, deps, async (tx, p) => {
      await deptById(tx, id);
      const [used] = await tx`select
          (select count(*) from people where department_id = ${id})
        + (select count(*) from job_roles where department_id = ${id})
        + (select count(*) from departments where parent_id = ${id}) as n`;
      if (Number(used!.n) > 0) throw conflict("department still has people, job roles or child departments");
      await tx`update people set dept_lead_of = dept_lead_of - ${id}::text where dept_lead_of ? ${id}::text`;
      await tx`delete from departments where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "department.delete",
        resource: { type: "department", id },
      });
    });
    return c.body(null, 204);
  });
}
