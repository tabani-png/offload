import type { Context } from "hono";
import type { App, AppEnv, Deps, Principal } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import type { Scope } from "../../rbac/permissions.ts";
import { HttpError, conflict, forbidden, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { ulid } from "../../schema/encoding.ts";
import { definitionHash } from "./hash.ts";
import { forbiddenBinding, stripDefinition } from "./strip.ts";
import { renderSop } from "./sop/template.ts";
import {
  type BindingInsert, type WorkflowRow, connectionById, definitionAt, dto, dtos, findVisible, insertVersion, isRole,
  listVisible, roleVersion, roleVersions,
} from "./store.ts";
import type { ConnectionKind, Definition, DefinitionObject, Step, WorkflowState } from "./types.ts";

const WORKFLOW = "offload/stage2/workflow.schema.json";
const DEFINITION = "offload/stage2/workflow-definition.schema.json";
const PROMOTE = "offload/stage2/promote-request.schema.json";
const PAGE = "offload/stage2/common.schema.json#/$defs/page";
const PLAIN = "offload/stage2/common.schema.json#/$defs/plainText";
const STATES = new Set<WorkflowState>(["proposed", "role", "retired", "declined"]);

interface PromoteRequest {
  jobRoleId: string;
  departmentId: string;
  fromVersion: number;
  bindings: Array<{ stepId: string; connectionId: string | null; disable: boolean }>;
}

const forbiddenBindingError = (m: string) => new HttpError(409, "forbidden_binding", m);

function scopeOf(c: Context<AppEnv>): Scope {
  const s = c.get("scope");
  if (!s) throw forbidden();
  return s;
}

function idParam(c: Context<AppEnv>): string {
  const id = c.req.param("id");
  if (!id || !isUuid(id)) throw notFound();
  return id;
}

function versionParam(c: Context<AppEnv>): number {
  const v = c.req.param("v") ?? "";
  if (!/^[1-9][0-9]{0,8}$/.test(v)) throw notFound();
  return Number(v);
}

async function visible(c: Context<AppEnv>, tx: Tx, p: Principal, id: string, lock = false): Promise<WorkflowRow> {
  const w = await findVisible(tx, scopeOf(c), p, id, lock);
  if (!w) throw notFound();
  return w;
}

/** `{items: workflow[], page}`: each item and the page validated like every other response. */
function replyList(c: Context<AppEnv>, deps: Deps, out: { items: unknown[]; page: unknown }) {
  if (deps.config.validateResponses) {
    for (const [ref, v] of [...out.items.map((i) => [WORKFLOW, i] as const), [PAGE, out.page] as const]) {
      const r = deps.validator.validate(ref, v);
      if (!r.ok) throw new Error(`response for ${c.req.method} ${c.req.path} does not match ${ref}: ${r.errors.join("; ")}`);
    }
  }
  return c.json(out, 200);
}

function uuidQuery(c: Context<AppEnv>, name: string): string | null {
  const v = c.req.query(name);
  if (v === undefined || v === "") return null;
  if (!isUuid(v)) throw invalid(`${name} must be a uuid`);
  return v;
}

/** `{reason}`: plain words, 1..2000 characters, nothing else in the body. */
async function declineBody(c: Context<AppEnv>, deps: Deps): Promise<string> {
  let data: unknown;
  try {
    const text = await c.req.text();
    data = text === "" ? {} : JSON.parse(text);
  } catch {
    throw invalid("body is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw invalid("body must be {reason}");
  const keys = Object.keys(data);
  const reason = (data as { reason?: unknown }).reason;
  if (keys.length !== 1 || typeof reason !== "string") throw invalid("body must be exactly {reason}");
  if (reason.trim() === "" || /[\u0000-\u0009\u000B-\u001F\u007F]/.test(reason) || !deps.validator.validate(PLAIN, reason).ok) {
    throw invalid("reason must be 1..2000 characters of plain words");
  }
  return reason;
}

function versionObject(d: Definition, now: number): DefinitionObject {
  return { id: ulid(now), kind: "workflow_proposal", createdAt: now, ...d, definitionHash: definitionHash(d) };
}

const capabilities = (steps: Step[]) => JSON.stringify(steps.map((s) => s.capability));

/** Bindings of a promotion: each connection step bound to a company connection or disabled (ADR 0104 §4-5). */
async function resolvePromotion(tx: Tx, steps: Step[], bindings: PromoteRequest["bindings"]) {
  const ids = new Set(steps.map((s) => s.id));
  const byStep = new Map<string, PromoteRequest["bindings"][number]>();
  for (const b of bindings) {
    if (!ids.has(b.stepId)) throw invalid(`binding names unknown step ${b.stepId}`);
    if (byStep.has(b.stepId)) throw invalid(`step ${b.stepId} is bound twice`);
    if (b.disable && b.connectionId !== null) throw invalid(`step ${b.stepId} is disabled and bound at once`);
    byStep.set(b.stepId, b);
  }
  const kept: Step[] = [];
  const rows: BindingInsert[] = [];
  const disabled: string[] = [];
  for (const s of steps) {
    const b = byStep.get(s.id);
    if (b?.disable) {
      disabled.push(s.id);
      rows.push({ stepId: s.id, stepClass: s.class, capability: s.capability, connectionId: null, ownership: null, disabled: true });
      continue;
    }
    if (s.connection === null) {
      if (b && b.connectionId !== null) throw invalid(`step ${s.id} uses no connection`);
      kept.push(s);
      rows.push({ stepId: s.id, stepClass: s.class, capability: s.capability, connectionId: null, ownership: null, disabled: false });
      continue;
    }
    if (!b || b.connectionId === null) {
      throw forbiddenBindingError(
        forbiddenBinding(s, s.connection) ??
          `step ${s.id} uses a ${s.connection.ownership} connection: bind it to a company connection or disable it`,
      );
    }
    const conn = await connectionById(tx, b.connectionId);
    if (!conn) throw invalid(`unknown connection ${b.connectionId}`);
    const why = forbiddenBinding(s, conn);
    if (why) throw forbiddenBindingError(why);
    if (conn.ownership !== "company") throw forbiddenBindingError(`step ${s.id}: a role workflow binds company connections only`);
    kept.push({ ...s, connection: { kind: conn.kind as ConnectionKind, ownership: "company", connectionId: conn.id, label: conn.label } });
    rows.push({ stepId: s.id, stepClass: s.class, capability: s.capability, connectionId: conn.id, ownership: "company", disabled: false });
  }
  if (kept.length === 0) throw conflict("every step is disabled: a role workflow needs at least one step");
  return { kept, rows, disabled };
}

/** A new version's steps: every connection is a stored company connection, never a forbidden commit binding. */
async function resolveVersion(tx: Tx, steps: Step[]) {
  const seen = new Set<string>();
  const kept: Step[] = [];
  const rows: BindingInsert[] = [];
  for (const s of steps) {
    if (seen.has(s.id)) throw invalid(`step ${s.id} appears twice`);
    seen.add(s.id);
    if (s.connection === null) {
      kept.push(s);
      rows.push({ stepId: s.id, stepClass: s.class, capability: s.capability, connectionId: null, ownership: null, disabled: false });
      continue;
    }
    const claimed = forbiddenBinding(s, s.connection);
    if (claimed) throw forbiddenBindingError(claimed);
    if (s.connection.connectionId === null) throw forbiddenBindingError(`step ${s.id}: bind it to a company connection`);
    const conn = await connectionById(tx, s.connection.connectionId);
    if (!conn) throw invalid(`unknown connection ${s.connection.connectionId}`);
    const why = forbiddenBinding(s, conn);
    if (why) throw forbiddenBindingError(why);
    if (conn.ownership !== "company" || s.connection.ownership !== "company" || s.connection.kind !== conn.kind) {
      throw forbiddenBindingError(`step ${s.id}: the binding does not match a stored company connection`);
    }
    kept.push({ ...s, connection: { kind: s.connection.kind, ownership: "company", connectionId: conn.id, label: conn.label } });
    rows.push({ stepId: s.id, stepClass: s.class, capability: s.capability, connectionId: conn.id, ownership: "company", disabled: false });
  }
  return { kept, rows };
}

export function registryRoutes(app: App, deps: Deps): void {
  app.get("/v1/workflows", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
    if (cursor !== null && after === null) throw invalid("bad cursor");
    const state = c.req.query("state") || null;
    if (state !== null && !STATES.has(state as WorkflowState)) throw invalid("state must be proposed, role, retired or declined");
    const filter = { after, state: state as WorkflowState | null, jobRoleId: uuidQuery(c, "jobRoleId"), departmentId: uuidQuery(c, "departmentId"), limit: limit + 1 };
    const out = await tenantTx(c, deps, async (tx, p) => {
      const rows = await listVisible(tx, scopeOf(c), p, filter);
      return page(await dtos(tx, rows), limit, (l) => ({ id: l.id }));
    });
    return replyList(c, deps, out);
  });

  app.get("/v1/workflows/:id", async (c) => {
    const id = idParam(c);
    const out = await tenantTx(c, deps, async (tx, p) => dto(tx, await visible(c, tx, p, id)));
    return reply(c, deps, 200, out, WORKFLOW);
  });

  app.get("/v1/workflows/:id/versions/:v", async (c) => {
    const id = idParam(c);
    const v = versionParam(c);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const def = await definitionAt(tx, await visible(c, tx, p, id), v);
      if (!def) throw notFound();
      return def;
    });
    return reply(c, deps, 200, out, DEFINITION);
  });

  app.get("/v1/workflows/:id/versions/:v/sop", async (c) => {
    const id = idParam(c);
    const v = versionParam(c);
    const format = c.req.query("format") ?? "md";
    if (format !== "md" && format !== "pdf") throw invalid("format must be md or pdf");
    const md = await tenantTx(c, deps, async (tx, p) => {
      const w = await visible(c, tx, p, id);
      if (!isRole(w.state)) throw conflict("only a promoted workflow has an SOP");
      const versions = await roleVersions(tx, id);
      const ver = versions.find((x) => x.version === v);
      if (!ver) throw notFound();
      const [jr] = await tx`select j.name as job_role, d.name as department from job_roles j
        join departments d on d.tenant_id = j.tenant_id and d.id = j.department_id where j.id = ${w.jobRoleId}`;
      const [dept] = await tx`select name from departments where id = ${w.departmentId}`;
      return renderSop({
        workflow: { id: w.id, name: w.name, state: w.state, latestVersion: w.latestVersion },
        jobRole: { name: (jr?.job_role as string | undefined) ?? "Unknown job role" },
        department: { name: (dept?.name as string | undefined) ?? "Unknown department" },
        version: v,
        definition: ver.definition,
        history: versions.map((x) => ({ version: x.version, definitionHash: x.definitionHash, createdAt: x.createdAt })),
      });
    });
    if (format === "pdf") {
      // SPEC S2-06: 501 until a PDF dependency is approved. error.schema.json has no not_implemented code, so the
      // reason travels in details.
      throw new HttpError(501, "server_error", "not_implemented: PDF export needs an approved PDF dependency; use format=md", {
        reason: "not_implemented",
      });
    }
    return c.body(md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  app.post("/v1/workflows/:id/promote", async (c) => {
    const id = idParam(c);
    const input = await body<PromoteRequest>(c, deps, PROMOTE);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const w = await visible(c, tx, p, id, true);
      if (scopeOf(c) === "Dp" && !p.departmentScope.includes(input.departmentId)) {
        throw forbidden("a dept_lead promotes only into a department they lead");
      }
      if (w.state !== "proposed") throw conflict(`workflow is ${w.state}, not a pending proposal`);
      if (input.fromVersion !== 1 || !w.proposal) throw notFound(`no proposal version ${input.fromVersion}`);
      const [jr] = await tx`select department_id from job_roles where id = ${input.jobRoleId}`;
      if (!jr || jr.department_id !== input.departmentId) throw invalid("jobRoleId must be a job role of departmentId");
      const { kept, rows, disabled } = await resolvePromotion(tx, w.proposal.steps, input.bindings);
      const now = deps.clock.now();
      const def = versionObject(stripDefinition({ ...w.proposal, steps: kept, workflowId: id, version: 1 }), now);
      await insertVersion(tx, id, def, false, p.personId, rows);
      await tx`update workflows set state = 'role', name = ${def.name}, job_role_id = ${input.jobRoleId},
          department_id = ${input.departmentId}, latest_version = 1, promoted_by = ${p.personId}, promoted_at_ms = ${now}
        where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "workflow.promoted",
        subjectPersonId: w.proposedBy,
        resource: { type: "workflow", id },
        detail: {
          fromVersion: 1,
          version: 1,
          jobRoleId: input.jobRoleId,
          departmentId: input.departmentId,
          definitionHash: def.definitionHash,
          disabledSteps: disabled,
        },
      });
      return dto(tx, (await findVisible(tx, "T", p, id))!);
    });
    return reply(c, deps, 200, out, WORKFLOW);
  });

  app.post("/v1/workflows/:id/decline", async (c) => {
    const id = idParam(c);
    const reason = await declineBody(c, deps);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const w = await visible(c, tx, p, id, true);
      if (w.state !== "proposed") throw conflict(`workflow is ${w.state}, not a pending proposal`);
      const now = deps.clock.now();
      await tx`insert into proposals_declined (tenant_id, workflow_id, reason, declined_by, declined_at_ms)
        values (current_setting('app.tenant_id')::uuid, ${id}, ${reason}, ${p.personId}, ${now})`;
      await tx`update workflows set state = 'declined' where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "workflow.declined",
        subjectPersonId: w.proposedBy,
        resource: { type: "workflow", id },
        detail: { reason },
      });
      return dto(tx, { ...w, state: "declined" });
    });
    return reply(c, deps, 200, out, WORKFLOW);
  });

  app.post("/v1/workflows/:id/versions", async (c) => {
    const id = idParam(c);
    const input = await body<DefinitionObject>(c, deps, DEFINITION);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const w = await visible(c, tx, p, id, true);
      if (input.workflowId !== null && input.workflowId !== id) throw invalid("workflowId is another workflow's");
      if (w.state !== "role") throw conflict(`workflow is ${w.state}: only a role workflow gets new versions`);
      const next = w.latestVersion + 1;
      if (input.version !== null && input.version !== next) throw conflict(`the next version is ${next}`);
      if (definitionHash(input) !== input.definitionHash) {
        throw new HttpError(409, "hash_mismatch", "definitionHash does not match the definition");
      }
      const { kept, rows } = await resolveVersion(tx, input.steps);
      const now = deps.clock.now();
      const def = versionObject(stripDefinition({ ...input, steps: kept, workflowId: id, version: next }), now);
      const prev = await roleVersion(tx, id, w.latestVersion);
      const carryOver = prev !== null && capabilities(prev.definition.steps) === capabilities(def.steps);
      await insertVersion(tx, id, def, carryOver, p.personId, rows);
      await tx`update workflows set latest_version = ${next}, name = ${def.name} where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "workflow.versioned",
        subjectPersonId: null,
        resource: { type: "workflow", id },
        detail: { version: next, definitionHash: def.definitionHash, baselineCarryOver: carryOver },
      });
      return dto(tx, { ...w, name: def.name, latestVersion: next });
    });
    return reply(c, deps, 200, out, WORKFLOW);
  });

  app.post("/v1/workflows/:id/retire", async (c) => {
    const id = idParam(c);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const w = await visible(c, tx, p, id, true);
      if (w.state !== "role") throw conflict(`workflow is ${w.state}: only a role workflow can be retired`);
      const now = deps.clock.now();
      await tx`update workflows set state = 'retired', retired_at_ms = ${now} where id = ${id}`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "workflow.retired",
        subjectPersonId: null,
        resource: { type: "workflow", id },
        detail: { latestVersion: w.latestVersion },
      });
      return dto(tx, { ...w, state: "retired" });
    });
    return reply(c, deps, 200, out, WORKFLOW);
  });
}
