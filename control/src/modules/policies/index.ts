/**
 * S2-07 policies module: role policies per job role (tools, approvers, budgets, models) and overnight policies
 * (ADR 0106). The pure overnight evaluator lives in evaluate.ts and is used by the broker.
 */
import type { Context } from "hono";
import type { App, AppEnv, Deps, ModuleDef, Principal } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { conflict, forbidden, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { brokerOf } from "../broker/broker.ts";
import { OVERNIGHT_LIST, OVERNIGHT_PATCH, readLocal, replyLocal } from "../broker/schemas.ts";
import { itemRef } from "../broker/stage1.ts";
import type { RegistryApi, RegistryVersion } from "../registry/port.ts";
import { trustChange, type OvernightPolicy } from "./evaluate.ts";
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

/** The role workflow version a policy names (S2-06 registry). Without the registry nothing can be checked: fail closed. */
async function workflowOf(tx: Tx, deps: Deps, workflowId: string, version: number): Promise<RegistryVersion> {
  const reg = deps.ports.registry as Partial<RegistryApi>;
  if (typeof reg.getVersion !== "function") throw invalid("the workflow registry is not loaded");
  const v = await reg.getVersion(tx, workflowId, version);
  if (!v || v.state !== "role") throw invalid("workflowId and version must name a live role workflow version");
  return v;
}

/** Does the person hold the workflow's job role (an active or leaving holder)? */
async function holds(tx: Tx, wf: RegistryVersion, personId: string): Promise<boolean> {
  const [h] = await tx`select 1 from job_role_holders h join people p on p.tenant_id = h.tenant_id and p.id = h.person_id
    where h.job_role_id = ${wf.jobRoleId} and h.person_id = ${personId} and p.state in ('active', 'leaving')`;
  return h !== undefined;
}

/** The owner runs the workflow (N1): a holder of its job role, or a dept lead of its department. */
async function ownerRuns(tx: Tx, wf: RegistryVersion, ownerPersonId: string): Promise<boolean> {
  if (await holds(tx, wf, ownerPersonId)) return true;
  const [o] = await tx`select access_role, dept_lead_of from people where id = ${ownerPersonId} and state in ('active', 'leaving')`;
  return o?.access_role === "dept_lead" && (o.dept_lead_of as string[]).includes(wf.departmentId);
}

/**
 * Who may let a policy approve in a person's place (N1): someone who could approve the batches it approves under the
 * role policy (the owner as runner, when the role policy names the runner), or a dept lead of the workflow's
 * department, an admin or the tenant owner signing off. Without a role policy nothing is approvable.
 */
async function maySignOff(tx: Tx, p: Principal, wf: RegistryVersion, rp: RolePolicy | null, ownerPersonId: string): Promise<boolean> {
  if (rp === null) return false;
  if (p.accessRole === "owner" || p.accessRole === "admin") return true;
  if (p.accessRole === "dept_lead" && p.departmentScope.includes(wf.departmentId)) return true;
  return (rp.approvers === "runner" || rp.approvers === "runner_or_dept_lead") && p.personId === ownerPersonId && (await holds(tx, wf, ownerPersonId));
}

const overBudget = (rp: RolePolicy | null, cents: number) => rp !== null && cents > rp.dailyBudgetCents;

/** Fewer dry-run nights than this is an owner or admin decision (ADR 0112 §3). */
export const MIN_DRY_RUN_NIGHTS = 3;

const mayShortenDryRun = (p: Principal) => p.accessRole === "owner" || p.accessRole === "admin";

/** Content-free stand-in for an allowlisted address (the Stage 1 itemRef of the policy's workflow). */
const emailRef = (policy: OvernightPolicy, email: string) => itemRef(policy.workflowId, email.trim());

/**
 * Allowlisted addresses are recipients (ADR 0111 §6): only the policy's owner sees them. Everyone else in scope sees
 * one content-free ref per address, so the count stays readable; domains are organisations and stay.
 */
function viewOf(p: Principal, policy: OvernightPolicy): OvernightPolicy {
  if (p.personId === policy.ownerPersonId) return policy;
  return { ...policy, recipients: { ...policy.recipients, emails: policy.recipients.emails.map((e) => emailRef(policy, e)) } };
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
      return { ...pg, items: pg.items.map((o) => viewOf(p, o)) };
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
      const wf = await workflowOf(tx, deps, req.workflowId, req.version);
      if (!(await ownerRuns(tx, wf, req.ownerPersonId))) throw invalid("the owner does not run this workflow");
      const rp = await rolePolicyOf(tx, wf.jobRoleId);
      if (overBudget(rp, req.budgetCentsPerNight)) throw invalid("budgetCentsPerNight is above the role policy's dailyBudgetCents");
      if (req.mode === "preapproved" && !(await maySignOff(tx, p, wf, rp, req.ownerPersonId))) {
        throw forbidden("only an approver under the role policy, a dept lead or an admin makes a policy preapproved");
      }
      if (req.dryRunNights < MIN_DRY_RUN_NIGHTS && !mayShortenDryRun(p)) {
        throw forbidden(`only an owner or admin sets fewer than ${MIN_DRY_RUN_NIGHTS} dry-run nights`);
      }
      if (await overnightById(tx, req.id)) throw conflict("a policy with this id exists");
      const saved = await insertOvernight(tx, req, deps.clock.now());
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "overnight.create",
        subjectPersonId: saved.ownerPersonId,
        resource: { type: "overnight_policy", id: saved.id },
        detail: { workflowId: saved.workflowId, version: saved.version, mode: saved.mode, templateHash: saved.templateHash },
      });
      return viewOf(p, saved);
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
      // Someone who sees refs (not the owner) may send them back unchanged: a ref keeps the address it stands for.
      if (patch.recipients && p.personId !== cur.ownerPersonId) {
        const byRef = new Map(cur.recipients.emails.map((e) => [emailRef(cur, e), e]));
        patch.recipients = { ...patch.recipients, emails: patch.recipients.emails.map((e) => byRef.get(e) ?? e) };
      }
      const next: OvernightPolicy = { ...cur, ...patch };
      if (next.dryRunNights < MIN_DRY_RUN_NIGHTS && next.dryRunNights < cur.dryRunNights && !mayShortenDryRun(p)) {
        throw forbidden(`only an owner or admin sets fewer than ${MIN_DRY_RUN_NIGHTS} dry-run nights`);
      }
      const rearm = cur.state === "tripped" && next.state === "active";
      if (rearm) next.trippedReason = null;
      // Any trust-widening edit (a new template, more recipients, a wider window, higher caps, attachments, mode
      // preapproved) is a new policy as far as trust goes: its dry-run nights start again (ADR 0112 §2).
      const change = trustChange(cur, next);
      if (change.widened) next.dryRunNightsDone = 0;
      const wf = await workflowOf(tx, deps, cur.workflowId, cur.version);
      const rp = await rolePolicyOf(tx, wf.jobRoleId);
      if (next.budgetCentsPerNight > cur.budgetCentsPerNight && overBudget(rp, next.budgetCentsPerNight)) {
        throw invalid("budgetCentsPerNight is above the role policy's dailyBudgetCents");
      }
      // Making a policy preapproved, or widening one, lets it approve more in a person's place (N1).
      if (next.mode === "preapproved" && (cur.mode !== "preapproved" || change.widened) && !(await maySignOff(tx, p, wf, rp, cur.ownerPersonId))) {
        throw forbidden("only an approver under the role policy, a dept lead or an admin makes a policy preapproved or widens it");
      }
      const v = deps.validator.validate(OVERNIGHT_POLICY, next);
      if (!v.ok) throw invalid("policy does not match its schema", v.errors);
      checkPolicy(next);
      const saved = await updateOvernight(tx, next, deps.clock.now(), rearm);
      if (rearm) await tx`update overnight_policies set connection_fingerprint = null where id = ${id}`;
      // Pausing or narrowing takes back what the policy approved and has not sent (ADR 0112 §1).
      const unlinked = await brokerOf(deps.ports).policyChanged(tx, id, change);
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: rearm ? "overnight.rearm" : "overnight.update",
        subjectPersonId: saved.ownerPersonId,
        resource: { type: "overnight_policy", id },
        detail: { changed: Object.keys(patch).sort(), state: saved.state, narrowed: change.narrowed, widened: change.widened, unlinkedBatches: unlinked },
      });
      return viewOf(p, saved);
    });
    return reply(c, deps, 200, out, OVERNIGHT_POLICY);
  });
}

const policies: ModuleDef = { name: "policies", routes };

export default policies;
