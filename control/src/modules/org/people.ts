import type { App, Deps } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import { personById, selectPeople, type PersonDto } from "../../db/people.ts";
import { conflict, forbidden, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { afterCursor, allow, ensureDepartments, idParam } from "./util.ts";

interface PersonPatch {
  accessRole?: PersonDto["accessRole"];
  departmentId?: string | null;
  deptLeadOf?: string[];
  jobRoleIds?: string[];
  jurisdiction?: string;
  leavingOn?: string | null;
}

interface Invite {
  email: string;
  displayName: string;
  departmentId: string | null;
  jurisdiction: string;
}

const PERSON = "offload/stage2/person.schema.json";

export function peopleRoutes(app: App, deps: Deps): void {
  app.get("/v1/people", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = afterCursor(cursor);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const dp = c.get("scope") === "Dp";
      const rows = await selectPeople(
        tx,
        tx`(${after}::uuid is null or p.id > ${after}::uuid)
          and (${dp} = false or p.department_id in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid))`,
        limit + 1,
      );
      return page(rows, limit, (l) => ({ id: l.id }));
    });
    return reply(c, deps, 200, out, "offload/control/person-list.json");
  });

  app.get("/v1/people/:id", async (c) => {
    const id = idParam(c);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const person = await personById(tx, id);
      if (!person) throw notFound();
      allow(c, p, { personId: person.id, departmentId: person.departmentId });
      // Every read of another person's record is an audit event (ADR 0108 §5).
      if (person.id !== p.personId) {
        await deps.ports.audit.write(tx, {
          actor: actorOf(p),
          action: "person.read",
          subjectPersonId: person.id,
          resource: { type: "person", id: person.id },
        });
      }
      return person;
    });
    return reply(c, deps, 200, out, PERSON);
  });

  app.patch("/v1/people/:id", async (c) => {
    const id = idParam(c);
    const patch = await body<PersonPatch>(c, deps, "offload/control/person-patch.json");
    const out = await tenantTx(c, deps, async (tx, p) => {
      // Serialise owner changes so two concurrent demotions cannot remove the last owner.
      await tx`select pg_advisory_xact_lock(hashtextextended('owners:' || current_setting('app.tenant_id'), 0))`;
      const cur = await personById(tx, id);
      if (!cur) throw notFound();
      const role = patch.accessRole;
      if (role !== undefined && role !== cur.accessRole) {
        if ((role === "owner" || cur.accessRole === "owner") && p.accessRole !== "owner") {
          throw forbidden("only an owner may grant or remove the owner role");
        }
        if (cur.accessRole === "owner") {
          const [n] = await tx`select count(*)::int as n from people
            where access_role = 'owner' and state in ('active', 'leaving') and id <> ${id}`;
          if (n!.n === 0) throw conflict("a tenant must keep at least one owner");
        }
      }
      if (patch.departmentId) await ensureDepartments(tx, [patch.departmentId]);
      if (patch.deptLeadOf) await ensureDepartments(tx, patch.deptLeadOf);
      if (patch.jobRoleIds) {
        for (const jr of patch.jobRoleIds) {
          const [r] = await tx`select 1 from job_roles where id = ${jr}`;
          if (!r) throw invalid(`unknown job role ${jr}`);
        }
      }
      let state = cur.state;
      if (patch.leavingOn !== undefined) {
        if (patch.leavingOn !== null && state === "active") state = "leaving";
        if (patch.leavingOn === null && state === "leaving") state = "active";
      }
      await tx`update people set
          access_role = ${role ?? cur.accessRole},
          department_id = ${patch.departmentId === undefined ? cur.departmentId : patch.departmentId},
          dept_lead_of = ${patch.deptLeadOf ?? cur.deptLeadOf}::jsonb,
          jurisdiction = ${patch.jurisdiction ?? cur.jurisdiction},
          leaving_on = ${patch.leavingOn === undefined ? cur.leavingOn : patch.leavingOn}::date,
          state = ${state}
        where id = ${id}`;
      if (patch.jobRoleIds) {
        await tx`delete from job_role_holders where person_id = ${id}`;
        for (const jr of new Set(patch.jobRoleIds)) {
          await tx`insert into job_role_holders (tenant_id, job_role_id, person_id)
            values (current_setting('app.tenant_id')::uuid, ${jr}, ${id})`;
        }
      }
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "person.update",
        subjectPersonId: id,
        resource: { type: "person", id },
        detail: { fields: Object.keys(patch).sort(), ...(role ? { accessRole: role } : {}) },
      });
      return (await personById(tx, id))!;
    });
    return reply(c, deps, 200, out, PERSON);
  });

  app.post("/v1/people/invite", async (c) => {
    const inv = await body<Invite>(c, deps, "offload/control/person-invite.json");
    const { person, orgId } = await tenantTx(c, deps, async (tx, p) => {
      if (inv.departmentId) await ensureDepartments(tx, [inv.departmentId]);
      const [dup] = await tx`select 1 from people where lower(email) = lower(${inv.email})`;
      if (dup) throw conflict("a person with this email already exists");
      const [row] = await tx`insert into people (tenant_id, email, display_name, department_id, jurisdiction, source)
        values (current_setting('app.tenant_id')::uuid, ${inv.email}, ${inv.displayName}, ${inv.departmentId},
          ${inv.jurisdiction}, 'invite')
        returning id`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "person.invite",
        subjectPersonId: row!.id,
        resource: { type: "person", id: row!.id },
      });
      const [t] = await tx`select workos_org_id from tenants where id = current_setting('app.tenant_id')::uuid`;
      return { person: (await personById(tx, row!.id))!, orgId: (t?.workos_org_id as string | null) ?? null };
    });
    // After commit: WorkOS sends the invitation email. Failure leaves the person invited; re-invite resends.
    if (orgId) await deps.workos.sendInvitation(person.email, orgId).catch(() => undefined);
    return reply(c, deps, 201, person, PERSON);
  });
}
