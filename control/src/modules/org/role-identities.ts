import type { App, Deps } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { HttpError, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { afterCursor, idParam } from "./util.ts";

interface RoleIdentity {
  id: string;
  jobRoleId: string;
  label: string;
  address: string | null;
  connectionId: string;
  signature: string;
}

const RI = "offload/stage2/role-identity.schema.json";

async function selectIdentities(tx: Tx, where: unknown, limit: number): Promise<RoleIdentity[]> {
  const rows: Array<Record<string, unknown>> = await tx`select r.id, r.job_role_id, r.label, r.address,
      r.connection_id, r.signature
    from role_identities r join job_roles j on j.tenant_id = r.tenant_id and j.id = r.job_role_id
    where ${where} order by r.id limit ${limit}`;
  return rows.map((r) => ({
    id: r.id as string,
    jobRoleId: r.job_role_id as string,
    label: r.label as string,
    address: (r.address as string | null) ?? null,
    connectionId: r.connection_id as string,
    signature: r.signature as string,
  }));
}

async function identityById(tx: Tx, id: string): Promise<RoleIdentity> {
  const [r] = await selectIdentities(tx, tx`r.id = ${id}`, 1);
  if (!r) throw notFound();
  return r;
}

/** A role identity sends for the company: its connection must be company-owned and never a personal LinkedIn. */
async function checkConnection(tx: Tx, connectionId: string): Promise<void> {
  const [conn] = await tx`select kind, ownership from connections where id = ${connectionId}`;
  if (!conn) throw invalid(`unknown connection ${connectionId}`);
  if (conn.ownership !== "company" || conn.kind === "linkedin_personal") {
    throw new HttpError(409, "forbidden_binding", "a role identity needs a company-owned connection");
  }
}

export function roleIdentityRoutes(app: App, deps: Deps): void {
  app.get("/v1/role-identities", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = afterCursor(cursor);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const dp = c.get("scope") === "Dp";
      const rows = await selectIdentities(
        tx,
        tx`(${after}::uuid is null or r.id > ${after}::uuid)
          and (${dp} = false or j.department_id in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid))`,
        limit + 1,
      );
      return page(rows, limit, (l) => ({ id: l.id }));
    });
    return reply(c, deps, 200, out, "offload/control/role-identity-list.json");
  });

  app.post("/v1/role-identities", async (c) => {
    const input = await body<Omit<RoleIdentity, "id">>(c, deps, "offload/control/role-identity-create.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      const [jr] = await tx`select 1 from job_roles where id = ${input.jobRoleId}`;
      if (!jr) throw invalid(`unknown job role ${input.jobRoleId}`);
      await checkConnection(tx, input.connectionId);
      const [r] = await tx`insert into role_identities (tenant_id, job_role_id, label, address, connection_id, signature)
        values (current_setting('app.tenant_id')::uuid, ${input.jobRoleId}, ${input.label}, ${input.address ?? null},
          ${input.connectionId}, ${input.signature ?? ""})
        returning id`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "role_identity.create",
        resource: { type: "role_identity", id: r!.id },
        detail: { jobRoleId: input.jobRoleId },
      });
      return identityById(tx, r!.id);
    });
    return reply(c, deps, 201, out, RI);
  });

  app.patch("/v1/role-identities/:id", async (c) => {
    const id = idParam(c);
    const input = await body<Partial<RoleIdentity>>(c, deps, "offload/control/role-identity-patch.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      const cur = await identityById(tx, id);
      if (input.connectionId) await checkConnection(tx, input.connectionId);
      await tx`update role_identities set label = ${input.label ?? cur.label},
          address = ${input.address === undefined ? cur.address : input.address},
          connection_id = ${input.connectionId ?? cur.connectionId},
          signature = ${input.signature ?? cur.signature}
        where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "role_identity.update",
        resource: { type: "role_identity", id },
        detail: { fields: Object.keys(input).sort() },
      });
      return identityById(tx, id);
    });
    return reply(c, deps, 200, out, RI);
  });

  app.delete("/v1/role-identities/:id", async (c) => {
    const id = idParam(c);
    await tenantTx(c, deps, async (tx, p) => {
      await identityById(tx, id);
      await tx`delete from role_identities where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "role_identity.delete",
        resource: { type: "role_identity", id },
      });
    });
    return c.body(null, 204);
  });
}
