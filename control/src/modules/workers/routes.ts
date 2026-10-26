/** Cloud worker endpoints (API.md "Cloud workers"). Provisioning and deployment changes run right after the response. */
import type { Context } from "hono";
import type { App, AppEnv, Deps, Principal } from "../../app.ts";
import { actorOf, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { conflict, forbidden, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { rolePolicyOf } from "../policies/repo.ts";
import type { RegistryApi } from "../registry/port.ts";
import { scheduleOrThrow, templateHashOf, type Workers } from "./orchestrator.ts";
import { loadDeployment, loadRun, loadWorker, runDto, runRow, workerDto, workerRow, type WorkerRow } from "./repo.ts";
import { RUN_CREATE, RUN_LIST, WORKER, WORKER_CREATE, WORKER_LIST, WORKER_PATCH, WORKER_RUN, readLocal, replyLocal } from "./schemas.ts";

interface Schedule {
  cron: string;
  timezone: string;
}

function idParam(c: Context<AppEnv>, name = "id"): string {
  const id = c.req.param(name);
  if (!id || !isUuid(id)) throw notFound();
  return id;
}

/** Owner/admin/auditor: the tenant. Dept lead: own departments. Member: workers of job roles they hold. Else 404. */
async function canSee(tx: Tx, p: Principal, w: Pick<WorkerRow, "departmentId" | "jobRoleId">): Promise<boolean> {
  if (p.accessRole === "owner" || p.accessRole === "admin" || p.accessRole === "auditor") return true;
  if (p.accessRole === "dept_lead") return p.departmentScope.includes(w.departmentId);
  const [h] = await tx`select 1 from job_role_holders where job_role_id = ${w.jobRoleId} and person_id = ${p.personId}`;
  return h !== undefined;
}

async function visibleWorker(tx: Tx, p: Principal, id: string, lock = false): Promise<WorkerRow> {
  const w = await loadWorker(tx, id, lock);
  if (!w || !(await canSee(tx, p, w))) throw notFound();
  return w;
}

async function budgetCheck(tx: Tx, jobRoleId: string, cents: number): Promise<void> {
  const policy = await rolePolicyOf(tx, jobRoleId);
  if (!policy) throw conflict("this job role has no role policy, so no cloud worker can run for it");
  if (cents > policy.sessionBudgetCents) throw invalid(`the session budget is above the role policy's ${policy.sessionBudgetCents} cents`);
}

/**
 * A person sends only through their own personal-allowed connection (the broker's run binding rule): the commit step's
 * company binding is never theirs. The person's own sendable personal-allowed connection is used: the one named, or
 * their only one. A workflow with no enabled commit step has none.
 */
async function personCommitConnection(tx: Tx, personId: string, named: string | undefined): Promise<string> {
  const own = (await tx`select id from connections where owner_person_id = ${personId} and ownership = 'personal-allowed'
      and kind <> 'linkedin_personal' and provider in ('composio', 'mcp', 'api') order by id`).map((r: { id: string }) => r.id as string);
  if (named !== undefined) {
    if (!own.includes(named)) throw conflict("commitConnectionId is not a sending personal-allowed connection of this person");
    return named;
  }
  if (own.length === 1) return own[0]!;
  throw conflict(own.length === 0
    ? "this person has no personal-allowed sending connection, so a worker running as them cannot commit"
    : "this person has several personal-allowed sending connections: name one in commitConnectionId");
}

export function workerRoutes(app: App, deps: Deps, workers: () => Workers): void {
  const registry = () => deps.ports.registry as RegistryApi;
  const dto = async (tx: Tx, id: string) => workerDto((await loadWorker(tx, id))!, await loadDeployment(tx, id), deps.clock.now());

  app.get("/v1/workers", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
    const out = await tenantTx(c, deps, async (tx, p) => {
      // canSee in SQL, before the limit: a page is never cut short by rows the caller cannot see.
      const all = p.accessRole === "owner" || p.accessRole === "admin" || p.accessRole === "auditor";
      const lead = p.accessRole === "dept_lead";
      const rows = await tx`select * from workers where (${after}::uuid is null or id > ${after}::uuid)
          and (${all} or (${lead} and department_id::text in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)))
            or (not ${all} and not ${lead} and job_role_id in (select job_role_id from job_role_holders where person_id = ${p.personId}::uuid)))
        order by id limit ${limit + 1}`;
      const items = [];
      for (const r of rows) {
        const w = workerRow(r);
        items.push(workerDto(w, await loadDeployment(tx, w.id), deps.clock.now()));
      }
      return page(items, limit, (l) => ({ id: l.id }));
    });
    return replyLocal(c, deps, 200, out, WORKER_LIST);
  });

  app.post("/v1/workers", async (c) => {
    const req = await readLocal<{ workflowId: string; version: number; identityId: string; commitConnectionId?: string; schedule?: Schedule | null; sessionBudgetCents: number }>(c, WORKER_CREATE);
    scheduleOrThrow(req.schedule);
    const { out, tenantId } = await tenantTx(c, deps, async (tx, p) => {
      const v = await registry().getVersion(tx, req.workflowId, req.version);
      if (!v || v.state !== "role") throw notFound();
      if (p.accessRole === "dept_lead" && !p.departmentScope.includes(v.departmentId)) throw notFound();
      await budgetCheck(tx, v.jobRoleId, req.sessionBudgetCents);
      // The identity: one of the job role's role identities, or a person who holds the job role (ADR 0106 §6).
      const [ri] = await tx`select id, connection_id from role_identities where id = ${req.identityId} and job_role_id = ${v.jobRoleId}`;
      let identityType: "person" | "role_identity";
      let commit: string | null;
      if (ri) {
        if (req.commitConnectionId !== undefined) throw invalid("a role identity sends through its own connection: commitConnectionId is for a person identity");
        identityType = "role_identity";
        commit = ri.connection_id as string;
      } else if (await registry().isRunnableBy(tx, req.workflowId, req.version, { personId: req.identityId })) {
        identityType = "person";
        const hasCommit = (await registry().bindingsFor(tx, req.workflowId, req.version)).some((x) => x.stepClass === "commit" && !x.disabled);
        commit = hasCommit ? await personCommitConnection(tx, req.identityId, req.commitConnectionId) : null;
        if (!hasCommit && req.commitConnectionId !== undefined) throw invalid("this workflow has no commit step");
      } else {
        throw conflict("the identity is neither a role identity of this job role nor an active holder of it");
      }
      const t = deps.clock.now();
      const [row] = await tx`insert into workers (tenant_id, workflow_id, version, job_role_id, department_id, identity_type, identity_id,
          owner_person_id, commit_connection_id, state, session_budget_cents, template_hash, created_by, created_at, updated_at)
        values (current_setting('app.tenant_id')::uuid, ${req.workflowId}, ${req.version}, ${v.jobRoleId}, ${v.departmentId}, ${identityType},
          ${req.identityId}, ${identityType === "person" ? req.identityId : p.personId}, ${commit}, 'provisioning', ${req.sessionBudgetCents},
          ${templateHashOf(v.definition.skillMd)}, ${p.personId}, ${new Date(t)}, ${new Date(t)})
        returning *`;
      const w = workerRow(row!);
      if (req.schedule) {
        await tx`insert into deployments (tenant_id, worker_id, cron, timezone, desired_status, updated_at)
          values (current_setting('app.tenant_id')::uuid, ${w.id}, ${req.schedule.cron}, ${req.schedule.timezone}, 'active', ${new Date(t)})`;
      }
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "worker.create",
        subjectPersonId: identityType === "person" ? req.identityId : null,
        resource: { type: "worker", id: w.id },
        detail: { workflowId: w.workflowId, version: w.version, identityType, sessionBudgetCents: w.sessionBudgetCents, schedule: req.schedule ?? null },
      });
      return { out: await dto(tx, w.id), tenantId: p.tenantId };
    });
    workers().dispatchReconcile(tenantId, out.id);
    return replyLocal(c, deps, 201, out, WORKER);
  });

  app.patch("/v1/workers/:id", async (c) => {
    const id = idParam(c);
    const req = await readLocal<{ schedule?: Schedule | null; sessionBudgetCents?: number }>(c, WORKER_PATCH);
    scheduleOrThrow(req.schedule);
    const { out, tenantId } = await tenantTx(c, deps, async (tx, p) => {
      // It rewrites the deployment row a sync writes: the worker's sync lock first (lock order step 9, before rows).
      await workers().lockWorkerSync(tx, id);
      const w = await visibleWorker(tx, p, id, true);
      if (w.state === "retired") throw conflict("this worker is retired");
      const t = new Date(deps.clock.now());
      const d = await loadDeployment(tx, id);
      let replace = false;
      if (req.sessionBudgetCents !== undefined && req.sessionBudgetCents !== w.sessionBudgetCents) {
        await budgetCheck(tx, w.jobRoleId, req.sessionBudgetCents);
        await tx`update workers set session_budget_cents = ${req.sessionBudgetCents}, updated_at = ${t} where id = ${id}`;
        replace = true; // a deployment's budget is fixed at creation
      }
      if (req.schedule === null && d) {
        await tx`update deployments set desired_status = 'archived', updated_at = ${t} where worker_id = ${id}`;
      } else if (req.schedule) {
        if (d) {
          await tx`update deployments set cron = ${req.schedule.cron}, timezone = ${req.schedule.timezone}, deployment_id = null,
              remote_status = 'none', desired_status = 'active',
              stale_deployment_ids = case when deployment_id is null or remote_status = 'archived' then stale_deployment_ids
                else stale_deployment_ids || to_jsonb(deployment_id) end, updated_at = ${t}
            where worker_id = ${id}`;
        } else {
          await tx`insert into deployments (tenant_id, worker_id, cron, timezone, desired_status, updated_at)
            values (current_setting('app.tenant_id')::uuid, ${id}, ${req.schedule.cron}, ${req.schedule.timezone}, 'active', ${t})`;
        }
      } else if (replace && d && d.desired !== "archived" && d.deploymentId) {
        await tx`update deployments set deployment_id = null, remote_status = 'none',
            stale_deployment_ids = stale_deployment_ids || to_jsonb(deployment_id), updated_at = ${t} where worker_id = ${id}`;
      }
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "worker.update",
        resource: { type: "worker", id },
        detail: { ...(req.schedule !== undefined ? { schedule: req.schedule } : {}), ...(req.sessionBudgetCents !== undefined ? { sessionBudgetCents: req.sessionBudgetCents } : {}) },
      });
      return { out: await dto(tx, id), tenantId: p.tenantId };
    });
    workers().dispatchReconcile(tenantId, id);
    return replyLocal(c, deps, 200, out, WORKER);
  });

  const transition = (action: "pause" | "resume" | "retire") =>
    app.post(`/v1/workers/:id/${action}`, async (c) => {
      const id = idParam(c);
      const { out, tenantId } = await tenantTx(c, deps, async (tx, p) => {
        const w = await visibleWorker(tx, p, id, true);
        const t = new Date(deps.clock.now());
        if (w.state === "retired") throw conflict("this worker is retired");
        if (action === "pause") {
          await tx`update workers set state = 'paused', paused_reason = 'manual', updated_at = ${t} where id = ${id}`;
          await tx`update deployments set desired_status = 'paused', updated_at = ${t} where worker_id = ${id} and desired_status = 'active'`;
        } else if (action === "resume") {
          if (w.state !== "paused" && w.state !== "failed") throw conflict(`this worker is ${w.state}`);
          // A failed worker is provisioned again; a paused one goes back to ready.
          const next = w.state === "failed" || w.agentId === null ? "provisioning" : "ready";
          await tx`update workers set state = ${next}, paused_reason = null, failed_reason = null, consecutive_failures = 0, updated_at = ${t} where id = ${id}`;
          await tx`update deployments set desired_status = 'active', updated_at = ${t} where worker_id = ${id} and desired_status = 'paused'`;
        } else {
          await tx`update workers set state = 'retired', updated_at = ${t} where id = ${id}`;
          await tx`update deployments set desired_status = 'archived', updated_at = ${t} where worker_id = ${id}`;
        }
        await deps.ports.audit.write(tx, { actor: actorOf(p), action: `worker.${action}`, resource: { type: "worker", id }, detail: { from: w.state } });
        return { out: await dto(tx, id), tenantId: p.tenantId };
      });
      workers().dispatchReconcile(tenantId, id);
      return replyLocal(c, deps, 200, out, WORKER);
    });
  transition("pause");
  transition("resume");
  transition("retire");

  app.post("/v1/workers/:id/runs", async (c) => {
    const id = idParam(c);
    const req = await readLocal<{ inputs?: { recipients?: string[]; context?: string } }>(c, RUN_CREATE);
    const { out, run, w, tenantId } = await tenantTx(c, deps, async (tx, p) => {
      if (p.kind !== "person") throw forbidden();
      // Lock order (workers step 9): the tenant's run-admission lock before the worker row (startRun re-takes it).
      await workers().lockBudget(tx);
      const w = await visibleWorker(tx, p, id, true);
      const run = await workers().startRun(tx, p.tenantId, w, { trigger: "manual", runnerPersonId: p.personId, inputs: req.inputs ?? null });
      return { out: await runDto(tx, run), run, w, tenantId: p.tenantId };
    });
    workers().dispatchRun(tenantId, run, w, req.inputs ?? null);
    return replyLocal(c, deps, 201, out, WORKER_RUN);
  });

  app.get("/v1/workers/:id/runs", async (c) => {
    const id = idParam(c);
    const { limit, cursor } = pageParams(c);
    const before = typeof cursor?.id === "string" ? cursor.id : null;
    const out = await tenantTx(c, deps, async (tx, p) => {
      await visibleWorker(tx, p, id);
      const rows = await tx`select * from worker_runs where worker_id = ${id} and (${before}::text is null or id < ${before})
        order by id desc limit ${limit + 1}`;
      const items = [];
      for (const r of rows) items.push(await runDto(tx, runRow(r)));
      return page(items, limit, (l) => ({ id: l.id }));
    });
    return replyLocal(c, deps, 200, out, RUN_LIST);
  });

  app.get("/v1/worker-runs/:id", async (c) => {
    const id = c.req.param("id") ?? "";
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw notFound();
    const out = await tenantTx(c, deps, async (tx, p) => {
      const r = await loadRun(tx, id);
      if (!r) throw notFound();
      await visibleWorker(tx, p, r.workerId);
      return runDto(tx, r);
    });
    return replyLocal(c, deps, 200, out, WORKER_RUN);
  });
}
