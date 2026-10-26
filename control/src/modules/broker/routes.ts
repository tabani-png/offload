/** Batches, approvals and kill switches (API.md "Batches, approvals, kill switch (broker)"). */
import type { Context } from "hono";
import type { App, AppEnv, Deps, Principal } from "../../app.ts";
import { actorOf, body, principalOf, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { msNN } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { conflict, forbidden, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { cleanConflict, type ApprovalRequest, type BatchDto, type BatchState, type Broker } from "./broker.ts";
import { BATCH_LIST, KILL_CREATE, KILL_LIST, REJECT, RELEASE, readLocal, replyLocal } from "./schemas.ts";

const BATCH = "offload/stage2/batch.schema.json";
const STATES: readonly BatchState[] = ["pending", "approved", "sending", "done", "rejected", "expired"];

function hashParam(c: Context<AppEnv>): string {
  const h = c.req.param("hash") ?? "";
  if (!/^[0-9a-f]{64}$/.test(h)) throw notFound();
  return h;
}

export function batchRoutes(app: App, deps: Deps, broker: () => Broker): void {
  // Batches I may approve (ADR 0111 §6), with their fields: every list read is one audit event naming the batches.
  app.get("/v1/batches", async (c) => {
    const { limit, cursor } = pageParams(c);
    const state = c.req.query("state") ?? null;
    if (state !== null && !STATES.includes(state as BatchState)) throw invalid("unknown state");
    const afterAt = typeof cursor?.at === "number" ? cursor.at : null;
    const afterHash = typeof cursor?.h === "string" && /^[0-9a-f]{64}$/.test(cursor.h) ? cursor.h : null;
    const out = await tenantTx(c, deps, async (tx, p) => {
      const lead = p.accessRole === "dept_lead";
      const rows = (await tx`select b.hash, b.created_at from batches b join role_policies rp on rp.tenant_id = b.tenant_id and rp.job_role_id = b.job_role_id
        where ((rp.approvers in ('runner', 'runner_or_dept_lead') and b.runner_person_id = ${p.personId})
            or (${lead} and rp.approvers in ('dept_lead', 'runner_or_dept_lead')
              and b.department_id in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid)))
          and (${state}::text is null or b.state = ${state})
          and (${afterAt}::bigint is null or (extract(epoch from b.created_at) * 1000)::bigint < ${afterAt}
            or ((extract(epoch from b.created_at) * 1000)::bigint = ${afterAt} and b.hash > ${afterHash}))
        order by b.created_at desc, b.hash limit ${limit + 1}`) as Array<Record<string, unknown>>;
      const pg = page(rows, limit, (l) => ({ at: msNN(l.created_at as Date), h: l.hash as string }));
      const items: BatchDto[] = [];
      for (const r of pg.items) {
        const b = (await broker().loadBatch(tx, r.hash as string))!;
        items.push(await broker().dto(tx, b, true));
      }
      if (items.length > 0) {
        await deps.ports.audit.write(tx, {
          actor: actorOf(p),
          action: "batch.fields_viewed",
          resource: { type: "batch", id: null },
          detail: { batches: items.map((b) => b.batchHash) },
        });
      }
      return { items, page: pg.page };
    });
    return replyLocal(c, deps, 200, out, BATCH_LIST);
  });

  app.get("/v1/batches/:hash", async (c) => {
    const hash = hashParam(c);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const b = await broker().loadBatch(tx, hash);
      if (!b) throw notFound();
      const v = await broker().visibility(tx, p, b);
      if (!v.visible) throw notFound();
      const d = await broker().dto(tx, b, v.fields);
      if (v.fields) {
        await deps.ports.audit.write(tx, {
          actor: actorOf(p),
          action: "batch.fields_viewed",
          subjectPersonId: b.runnerPersonId,
          resource: { type: "batch", id: hash },
          detail: { batches: [hash] },
        });
      }
      return d;
    });
    return reply(c, deps, 200, out, BATCH);
  });

  app.post("/v1/batches/:hash/approve", async (c) => {
    const hash = hashParam(c);
    const req = await body<ApprovalRequest>(c, deps, "offload/stage2/approval.schema.json#/$defs/request");
    const p0 = principalOf(c);
    const r = await cleanConflict(tenantTx(c, deps, (tx, p) => broker().approve(tx, p, hash, req)), "an identical batch already exists");
    // The token never leaves the broker: it is spent right after the approval is committed.
    broker().dispatch(p0.tenantId, r.response.batchHash, r.token);
    return reply(c, deps, 200, r.response, "offload/stage2/approval.schema.json#/$defs/response");
  });

  app.post("/v1/batches/:hash/reject", async (c) => {
    const hash = hashParam(c);
    const { reason } = await readLocal<{ reason: string }>(c, REJECT);
    const out = await cleanConflict(tenantTx(c, deps, (tx, p) => broker().reject(tx, p, hash, reason)));
    return reply(c, deps, 200, out, BATCH);
  });

  app.post("/v1/batches/:hash/release", async (c) => {
    const hash = hashParam(c);
    const { keys } = await readLocal<{ keys: string[] }>(c, RELEASE);
    const out = await cleanConflict(tenantTx(c, deps, (tx, p) => broker().release(tx, p, hash, keys)));
    return reply(c, deps, 200, out, BATCH);
  });
}

// ---------- kill switches ----------

type KillScope = "tenant" | "person" | "workflow";

interface KillRow {
  id: string;
  scope: KillScope;
  targetId: string | null;
  active: boolean;
  setBy: string;
  setByRole: string;
  setAt: number;
  reason: string;
}

const killRow = (r: Record<string, unknown>): KillRow => ({
  id: r.id as string,
  scope: r.scope as KillScope,
  targetId: (r.target_id as string | null) ?? null,
  active: r.active as boolean,
  setBy: r.set_by as string,
  setByRole: r.set_by_role as string,
  setAt: msNN(r.set_at as Date),
  reason: r.reason as string,
});

const killDto = (k: KillRow) => ({ scope: k.scope, targetId: k.targetId, active: k.active, setBy: k.setBy, setAt: k.setAt, reason: k.reason });

/**
 * Departments a workflow belongs to. The registry (S2-06) decides first: a role or retired workflow's owning department,
 * a proposal's proposer department. A safety control must be reachable for a workflow with no history (Codex P2, round
 * 6); the broker's own rows (batches, policy owners) only add departments, never gate.
 */
async function workflowDepartments(tx: Tx, workflowId: string): Promise<string[]> {
  const rows = await tx`select department_id from workflows where id = ${workflowId} and department_id is not null
    union select proposer_department_id from workflows where id = ${workflowId} and proposer_department_id is not null
    union select department_id from batches where workflow_id = ${workflowId}
    union select p.department_id from overnight_policies o join people p on p.tenant_id = o.tenant_id and p.id = o.owner_person_id
      where o.workflow_id = ${workflowId} and p.department_id is not null`;
  return rows.map((r: Record<string, unknown>) => r.department_id as string);
}

/** Workflows a person runs or owns: the registry's, plus the ones the broker saw them run or set a policy for. */
async function workflowsOf(tx: Tx, deps: Deps, personId: string): Promise<Set<string>> {
  const out = new Set(await deps.ports.registry.workflowsOf(tx, personId));
  for (const r of await tx`select distinct workflow_id from batches where runner_person_id = ${personId}
      union select workflow_id from overnight_policies where owner_person_id = ${personId}`) out.add(r.workflow_id as string);
  return out;
}

/** May `p` set or clear a switch on this target? Outside the caller's scope is 404; a forbidden scope is 403. */
async function killScopeCheck(tx: Tx, deps: Deps, p: Principal, scope: KillScope, targetId: string | null): Promise<void> {
  if (p.accessRole === "owner" || p.accessRole === "admin") return;
  if (scope === "tenant") throw forbidden("only an owner or admin sets a tenant kill switch");
  if (p.accessRole === "dept_lead") {
    if (scope === "person") {
      const [r] = await tx`select department_id from people where id = ${targetId}`;
      if (!r || !(targetId === p.personId || p.departmentScope.includes(r.department_id as string))) throw notFound();
      return;
    }
    const depts = await workflowDepartments(tx, targetId!);
    if (!depts.some((d) => p.departmentScope.includes(d)) && !(await workflowsOf(tx, deps, p.personId)).has(targetId!)) throw notFound();
    return;
  }
  // member: own person, own workflows.
  if (scope === "person" ? targetId !== p.personId : !(await workflowsOf(tx, deps, p.personId)).has(targetId!)) throw notFound();
}

async function visibleKill(tx: Tx, deps: Deps, p: Principal, k: KillRow): Promise<boolean> {
  if (p.accessRole === "owner" || p.accessRole === "admin" || p.accessRole === "auditor") return true;
  if (k.scope === "tenant") return true;
  try {
    await killScopeCheck(tx, deps, p, k.scope, k.targetId);
    return true;
  } catch {
    return false;
  }
}

export function killRoutes(app: App, deps: Deps, broker: () => Broker): void {
  app.get("/v1/kill-switches", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
    const afterAt = typeof cursor?.at === "number" ? cursor.at : null;
    const out = await tenantTx(c, deps, async (tx, p) => {
      // Visibility is per row (scope rules), so filter while paging: fetch in order and keep the visible ones.
      const visible: KillRow[] = [];
      let at = afterAt;
      let id = after;
      for (;;) {
        const rows = (await tx`select * from kill_switches
          where (${at}::bigint is null or (extract(epoch from set_at) * 1000)::bigint < ${at}
            or ((extract(epoch from set_at) * 1000)::bigint = ${at} and id > ${id}::uuid))
          order by set_at desc, id limit 200`).map(killRow);
        for (const k of rows) if (await visibleKill(tx, deps, p, k)) visible.push(k);
        if (rows.length < 200 || visible.length > limit) break;
        const last = rows[rows.length - 1]!;
        at = last.setAt;
        id = last.id;
      }
      const pg = page(visible, limit, (l) => ({ at: l.setAt, id: l.id }));
      return { items: pg.items.map(killDto), page: pg.page };
    });
    return replyLocal(c, deps, 200, out, KILL_LIST);
  });

  app.post("/v1/kill-switches", async (c) => {
    const req = await readLocal<{ scope: KillScope; targetId: string | null; reason: string }>(c, KILL_CREATE);
    if ((req.scope === "tenant") !== (req.targetId === null)) throw invalid("a tenant switch has no targetId; the others need one");
    // A concurrent set of the same switch loses on the unique index: 409, like the duplicate check below.
    const out = await cleanConflict(tenantTx(c, deps, async (tx, p) => {
      await killScopeCheck(tx, deps, p, req.scope, req.targetId);
      if (req.scope === "person") {
        const [r] = await tx`select 1 from people where id = ${req.targetId}`;
        if (!r) throw notFound();
      }
      const [dup] = await tx`select 1 from kill_switches where active and scope = ${req.scope}
        and target_id is not distinct from ${req.targetId}::uuid`;
      if (dup) throw conflict("this kill switch is already on");
      const t = deps.clock.now();
      const [row] = await tx`insert into kill_switches (tenant_id, scope, target_id, set_by, set_by_role, set_at, reason)
        values (current_setting('app.tenant_id')::uuid, ${req.scope}, ${req.targetId}::uuid, ${p.personId}, ${p.accessRole},
          ${new Date(t)}, ${req.reason}) returning *`;
      // ADR 0106 §4: revoke unspent tokens; queued batches stay queued. Cloud workers of the person pause too.
      const revoked = await broker().revokeForKill(tx, req.scope, req.targetId, "kill switch");
      const workers = req.scope === "person" ? await deps.ports.workers.pauseFor(tx, req.targetId!) : 0;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "kill.set",
        subjectPersonId: req.scope === "person" ? req.targetId : null,
        resource: { type: "kill_switch", id: row!.id as string },
        detail: { scope: req.scope, targetId: req.targetId, reason: req.reason, tokensRevoked: revoked, workersPaused: workers },
      });
      return killDto(killRow(row!));
    }), "this kill switch is already on");
    return reply(c, deps, 201, out, "offload/stage2/kill-switch.schema.json");
  });

  // Tenant scope is addressed as /v1/kill-switches/tenant/null (its targetId is null).
  app.delete("/v1/kill-switches/:scope/:targetId", async (c) => {
    const scope = c.req.param("scope") as KillScope;
    const raw = c.req.param("targetId") ?? "";
    if (!["tenant", "person", "workflow"].includes(scope)) throw notFound();
    const targetId = scope === "tenant" ? (raw === "null" ? null : undefined) : isUuid(raw) ? raw : undefined;
    if (targetId === undefined) throw notFound();
    const out = await cleanConflict(tenantTx(c, deps, async (tx, p) => {
      const [r] = await tx`select * from kill_switches where active and scope = ${scope}
        and target_id is not distinct from ${targetId}::uuid for update`;
      if (!r) throw notFound();
      const k = killRow(r);
      // API.md clearing rules.
      // Nobody lifts a switch that stops themselves, whatever their role: someone else must.
      if (k.scope === "person" && k.targetId === p.personId) throw forbidden("a kill switch on you is cleared by someone else");
      if (p.accessRole === "admin" && k.scope === "tenant" && k.setByRole === "owner") {
        throw forbidden("a tenant kill switch set by an owner is cleared by an owner");
      }
      if (p.accessRole === "dept_lead" || p.accessRole === "member") {
        await killScopeCheck(tx, deps, p, k.scope, k.targetId);
        // A switch an owner or admin set is cleared by an owner or admin.
        if (k.setByRole === "owner" || k.setByRole === "admin") throw forbidden("a kill switch set by an owner or admin is cleared by an owner or admin");
        if (p.accessRole === "member" && k.setBy !== p.personId) throw forbidden("you can clear only a kill switch you set");
        if (p.accessRole === "dept_lead" && k.setBy !== p.personId) {
          // A dept lead clears what a dept lead or member of their own department set.
          const [setter] = await tx`select department_id from people where id = ${k.setBy}`;
          const dept = (setter?.department_id as string | null | undefined) ?? null;
          if (!(k.setByRole === "dept_lead" || k.setByRole === "member") || dept === null || !p.departmentScope.includes(dept)) {
            throw forbidden("a dept lead clears only kill switches set in their department");
          }
        }
      }
      const t = deps.clock.now();
      const [row] = await tx`update kill_switches set active = false, cleared_at = ${new Date(t)}, cleared_by = ${p.personId}
        where id = ${k.id} returning *`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "kill.clear",
        subjectPersonId: k.scope === "person" ? k.targetId : null,
        resource: { type: "kill_switch", id: k.id },
        detail: { scope: k.scope, targetId: k.targetId },
      });
      return killDto(killRow(row!));
    }));
    return reply(c, deps, 200, out, "offload/stage2/kill-switch.schema.json");
  });
}

