/**
 * S2-07 policies module: role policies per job role (tools, approvers, budgets, models) and overnight policies
 * (ADR 0106). The pure overnight evaluator lives in evaluate.ts and is used by the broker.
 */
import type { Context } from "hono";
import type { App, AppEnv, Deps, ModuleDef, Principal } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { conflict, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { OVERNIGHT_LIST, OVERNIGHT_PATCH, readLocal, replyLocal } from "../broker/schemas.ts";
import type { OvernightPolicy } from "./evaluate.ts";
import {
  OVERNIGHT_POLICY,
  ROLE_POLICY,
  insertOvernight,
  overnightById,
  overnightDto,
  putRolePolicy,
  rolePolicyOf,
  updateOvernight,
  type RolePolicy,
} from "./repo.ts";

export { evaluateOvernight } from "./evaluate.ts";

function idParam(c: Context<AppEnv>): string {
  const id = c.req.param("id");
  if (!id || !isUuid(id)) throw notFound();
  return id;
}

/** Job-role scope: owner/admin/auditor whole tenant, a dept lead their departments, a member the roles they hold. */
async function jobRoleAccess(tx: Tx, p: Principal, jobRoleId: string, write: boolean): Promise<void> {
  const [jr] = await tx`select department_id from job_roles where id = ${jobRoleId}`;
  if (!jr) throw notFound();
  if (p.accessRole === "owner" || p.accessRole === "admin") return;
  if (p.accessRole === "auditor" && !write) return;
  if (p.accessRole === "dept_lead" && p.departmentScope.includes(jr.department_id as string)) return;
  if (p.accessRole === "member" && !write) {
    const [h] = await tx`select 1 from job_role_holders where job_role_id = ${jobRoleId} and person_id = ${p.personId}`;
    if (h) return;
  }
  throw notFound();
}

/** Overnight-policy scope by its owner: a dept lead for people of their departments (and themself), a member own. */
async function ownerAccess(tx: Tx, p: Principal, ownerPersonId: string, write: boolean): Promise<void> {
  const [o] = await tx`select department_id from people where id = ${ownerPersonId}`;
  if (!o) throw (p.accessRole === "member" || p.accessRole === "dept_lead" ? notFound() : invalid("unknown owner"));
  if (p.accessRole === "owner" || p.accessRole === "admin") return;
  if (p.accessRole === "auditor" && !write) return;
  if (ownerPersonId === p.personId && (p.accessRole === "member" || p.accessRole === "dept_lead")) return;
  if (p.accessRole === "dept_lead" && p.departmentScope.includes(o.department_id as string)) return;
  throw notFound();
}

function checkPolicy(p: OvernightPolicy): void {
  if (p.mode === "preapproved" && p.templateHash === null) throw invalid("mode preapproved needs templateHash");
  if (p.sendWindow.startHour >= p.sendWindow.endHour) throw invalid("sendWindow.startHour must be before endHour");
  if (new Set(p.sendWindow.days).size !== p.sendWindow.days.length) throw invalid("sendWindow.days repeats a day");
}

function routes(app: App, deps: Deps): void {
  app.get("/v1/policies/job-roles/:id", async (c) => {
    const id = idParam(c);
    const out = await tenantTx(c, deps, async (tx, p) => {
      await jobRoleAccess(tx, p, id, false);
      const policy = await rolePolicyOf(tx, id);
      if (!policy) throw notFound("this job role has no role policy yet");
      return policy;
    });
    return reply(c, deps, 200, out, ROLE_POLICY);
  });

  app.put("/v1/policies/job-roles/:id", async (c) => {
    const id = idParam(c);
    const req = await body<RolePolicy>(c, deps, ROLE_POLICY);
    if (req.jobRoleId !== id) throw invalid("jobRoleId must be the job role in the path");
    if (new Set(req.allowedCapabilities).size !== req.allowedCapabilities.length) throw invalid("allowedCapabilities repeats a capability");
    const out = await tenantTx(c, deps, async (tx, p) => {
      await jobRoleAccess(tx, p, id, true);
      const before = await rolePolicyOf(tx, id);
      // updatedAt / updatedBy are the server's, whatever the body says.
      const saved = await putRolePolicy(tx, { ...req, updatedAt: deps.clock.now(), updatedBy: p.personId });
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "policy.role_put",
        resource: { type: "job_role", id },
        detail: { created: before === null, allowedCapabilities: saved.allowedCapabilities, approvers: saved.approvers, maxItemsPerBatch: saved.maxItemsPerBatch, sessionBudgetCents: saved.sessionBudgetCents, dailyBudgetCents: saved.dailyBudgetCents },
      });
      return saved;
    });
    return reply(c, deps, 200, out, ROLE_POLICY);
  });

  app.get("/v1/overnight-policies", async (c) => {
    const { limit, cursor } = pageParams(c);
    const wf = c.req.query("workflowId") ?? null;
    if (wf !== null && !isUuid(wf)) throw invalid("workflowId must be a uuid");
    const after = typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
    const out = await tenantTx(c, deps, async (tx, p) => {
      const tenantWide = p.accessRole === "owner" || p.accessRole === "admin" || p.accessRole === "auditor";
      const lead = p.accessRole === "dept_lead";
      const rows = await tx`select o.* from overnight_policies o join people p on p.tenant_id = o.tenant_id and p.id = o.owner_person_id
        where (${wf}::uuid is null or o.workflow_id = ${wf}::uuid) and (${after}::uuid is null or o.id > ${after}::uuid)
          and (${tenantWide} or o.owner_person_id = ${p.personId}
            or (${lead} and p.department_id in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid)))
        order by o.id limit ${limit + 1}`;
      const pg = page(rows.map(overnightDto), limit, (l: OvernightPolicy) => ({ id: l.id }));
      return pg;
    });
    return replyLocal(c, deps, 200, out, OVERNIGHT_LIST);
  });

  app.post("/v1/overnight-policies", async (c) => {
    const req = await body<OvernightPolicy>(c, deps, OVERNIGHT_POLICY);
    checkPolicy(req);
    if (req.dryRunNightsDone !== 0 || req.state !== "active" || req.trippedReason !== null) {
      throw invalid("a new policy starts active with no dry-run nights done and no trip");
    }
    const out = await tenantTx(c, deps, async (tx, p) => {
      await ownerAccess(tx, p, req.ownerPersonId, true);
      if (await overnightById(tx, req.id)) throw conflict("a policy with this id exists");
      const saved = await insertOvernight(tx, req, deps.clock.now());
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "overnight.create",
        subjectPersonId: saved.ownerPersonId,
        resource: { type: "overnight_policy", id: saved.id },
        detail: { workflowId: saved.workflowId, version: saved.version, mode: saved.mode, templateHash: saved.templateHash },
      });
      return saved;
    });
    return reply(c, deps, 201, out, OVERNIGHT_POLICY);
  });

  app.patch("/v1/overnight-policies/:id", async (c) => {
    const id = idParam(c);
    const patch = await readLocal<Partial<OvernightPolicy>>(c, OVERNIGHT_PATCH);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const cur = await overnightById(tx, id, true);
      if (!cur) throw notFound();
      await ownerAccess(tx, p, cur.ownerPersonId, true);
      for (const k of ["id", "workflowId", "version", "ownerPersonId", "dryRunNightsDone", "trippedReason"] as const) {
        if (k in patch && JSON.stringify(patch[k]) !== JSON.stringify(cur[k])) throw invalid(`${k} cannot be changed`);
      }
      if (patch.state === "tripped" && cur.state !== "tripped") throw invalid("only a circuit breaker trips a policy");
      const next: OvernightPolicy = { ...cur, ...patch };
      const rearm = cur.state === "tripped" && next.state === "active";
      if (rearm) next.trippedReason = null;
      // A new template is a new policy as far as trust goes: its dry-run nights start again.
      if (next.templateHash !== cur.templateHash) next.dryRunNightsDone = 0;
      const v = deps.validator.validate(OVERNIGHT_POLICY, next);
      if (!v.ok) throw invalid("policy does not match its schema", v.errors);
      checkPolicy(next);
      const saved = await updateOvernight(tx, next, deps.clock.now(), rearm);
      if (rearm) await tx`update overnight_policies set connection_fingerprint = null where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: rearm ? "overnight.rearm" : "overnight.update",
        subjectPersonId: saved.ownerPersonId,
        resource: { type: "overnight_policy", id },
        detail: { changed: Object.keys(patch).sort(), state: saved.state },
      });
      return saved;
    });
    return reply(c, deps, 200, out, OVERNIGHT_POLICY);
  });
}

const policies: ModuleDef = { name: "policies", routes };

export default policies;
