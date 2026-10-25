// In-memory mock of the control plane API (plan/stage-2/API.md), built only from schemas/stage2 shapes.
// Every GET in API.md has a route here (tests/schema.test.ts checks that and validates each response).

import { ApiError, type ApiClient, type ErrorCode } from "../client.ts";
import type {
  AccessRole, ApprovalRequest, AuditEvent, FeatureEnableRequest, FeatureEnablement, Handover, Person, PromoteRequest,
  Scope, SelfView, SensitiveFeature,
} from "../types.ts";
import * as fx from "./fixtures.ts";
import { hex64, ulid, uuid } from "./ids.ts";
import { adoption, evidence, hoursSavedReport, workingTime } from "./metrics.ts";

/** What a route returns, for schema validation in tests. Ids are schemas/stage2 file names (+ optional pointer). */
export type ResponseShape =
  | { kind: "schema"; ref: string }
  | { kind: "array"; ref: string }
  | { kind: "inline"; schema: Record<string, unknown> }
  | { kind: "text" }
  | { kind: "redirect" };

export interface MockOptions {
  /** Sensitive features enabled (and effective) for the tenant. Default: none, as ADR 0108 requires. */
  features?: SensitiveFeature[];
  /** Force an error for a route key such as "GET /v1/people". */
  failures?: Record<string, ErrorCode>;
  /** Access role of the signed-in person. Default owner. */
  role?: AccessRole;
}

interface Req {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface State {
  workflows: typeof fx.workflows;
  batches: typeof fx.batches;
  handovers: typeof fx.handovers;
  notices: typeof fx.notices;
  killSwitches: typeof fx.killSwitches;
  auditLog: typeof fx.auditLog;
  people: typeof fx.people;
  features: FeatureEnablement[];
  me: Person;
}

export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  response: ResponseShape;
  /** Schema the request body must match (tests check mutations the screens send). */
  request?: ResponseShape;
  handle(req: Req, s: State, o: Required<MockOptions>): unknown;
}

const schema = (ref: string): ResponseShape => ({ kind: "schema", ref });
const array = (ref: string): ResponseShape => ({ kind: "array", ref });
const inline = (s: Record<string, unknown>): ResponseShape => ({ kind: "inline", schema: s });
const notFound = (): never => {
  throw new ApiError("not_found", 404);
};
const fail = (code: ErrorCode, status: number): never => {
  throw new ApiError(code, status);
};

function enablement(feature: SensitiveFeature, me: string): FeatureEnablement {
  return {
    feature, jurisdictions: ["CA-ON", "GB"], legalBasis: "legitimate_interest",
    dpiaAttestation: { completedOn: "2026-09-30", documentHash: hex64(`dpia:${feature}`), documentName: "DPIA per-person views 2026-09.pdf", signerName: "Maya Okafor", signerTitle: "Chief Operating Officer" },
    noticeVersionId: uuid(703), noticePeriodDays: 14, worksAgreementRef: null, quebecActivationAck: false,
    purposeLock: "process_improvement", enabledBy: me, enabledAt: fx.NOW - 20 * fx.DAY_MS, effectiveAt: fx.NOW - 6 * fx.DAY_MS, disabledAt: null,
  };
}

const featureOn = (s: State, f: SensitiveFeature) =>
  s.features.some((e) => e.feature === f && e.disabledAt === null && e.effectiveAt <= fx.NOW);

function parseScope(raw: string | null): Scope {
  if (!raw || raw === "company") return { type: "company", id: null };
  const [type, id] = raw.split(":");
  if ((type === "department" || type === "job_role" || type === "person") && id) return { type, id };
  return fail("validation_failed", 400);
}

function period(q: URLSearchParams) {
  return { from: q.get("from") ?? "2026-10-01", to: q.get("to") ?? "2026-10-26" };
}

function audit(s: State, action: string, resource: { type: string; id: string | null }, subjectPersonId: string | null, detail: Record<string, unknown> = {}) {
  const prev = s.auditLog[s.auditLog.length - 1]?.hash ?? null;
  const ev: AuditEvent = {
    id: ulid(7000 + s.auditLog.length), at: fx.NOW + s.auditLog.length * 1000,
    actor: { type: "person", id: s.me.id, accessRole: s.me.accessRole }, action, subjectPersonId, resource, detail,
    prevHash: prev, hash: hex64(`audit:${s.auditLog.length}:${prev ?? "genesis"}:${action}`),
  };
  s.auditLog.push(ev);
}

function selfView(s: State): SelfView {
  const me = s.me;
  const runs = fx.workerRuns.slice(0, 5).map((r, i) => ({
    id: ulid(60_000 + i), kind: "run_outcome" as const, createdAt: r.startedAt, runId: r.id, workflowId: uuid(305), version: 4,
    runtime: "mac" as const, startedAt: r.startedAt, endedAt: r.endedAt ?? r.startedAt + 600_000,
    outcome: i === 3 ? ("failed" as const) : ("success" as const),
    items: { total: 1, sent: i === 3 ? 0 : 1, failedBeforeSend: i === 3 ? 1 : 0, unknown: 0, pending: 0 },
    batchHash: hex64(`self-batch:${i}`), approverKind: "person" as const, overnightPolicyId: null, costCents: 0,
    errorCode: i === 3 ? "connection_failed" : null, overnight: false,
  }));
  return {
    person: me,
    features: { workflow_metrics: true, per_person_views: featureOn(s, "per_person_views"), working_time: featureOn(s, "working_time") },
    acks: [{ id: ulid(65_000), kind: "notice_ack", createdAt: Date.UTC(2026, 6, 2), noticeVersionId: uuid(702), acknowledgedAt: Date.UTC(2026, 6, 2, 14, 3), jurisdiction: me.jurisdiction, features: ["workflow_metrics"], channel: "mac_app" }],
    devices: fx.devices.filter((d) => d.personId === me.id),
    hoursSaved: hoursSavedReport({ type: "person", id: me.id }, "2026-10-01", "2026-10-26"),
    dailyAggregates: Array.from({ length: 7 }, (_, i) => ({
      id: ulid(66_000 + i), kind: "daily_aggregate" as const, createdAt: fx.NOW - i * fx.DAY_MS,
      day: `2026-10-${String(24 - i).padStart(2, "0")}`, activeWorkflows: 1,
      workflows: [{ workflowId: uuid(305), version: 4, runs: i % 7 === 5 ? 1 : 0, successes: i % 7 === 5 ? 1 : 0, savedSecondsDevice: i % 7 === 5 ? 2160 : 0 }],
    })),
    workingTime: [],
    runs,
    accessLog: s.auditLog.filter((e) => e.subjectPersonId === me.id),
    retention: { perPersonDays: fx.tenant.retention.perPersonDays, workingTimeDays: fx.tenant.retention.workingTimeDays },
  };
}

/** A request body made of some top-level properties of a schema (all required, nothing else allowed). */
function pick(ref: string, fields: string[]): ResponseShape {
  return inline({
    type: "object", additionalProperties: false, required: fields,
    properties: Object.fromEntries(fields.map((f) => [f, { $ref: `${ref}#/properties/${f}` }])),
  });
}

const ENABLE_FIELDS = ["feature", "jurisdictions", "legalBasis", "dpiaAttestation", "noticeVersionId", "noticePeriodDays",
  "worksAgreementRef", "quebecActivationAck", "purposeLock"];

const ACK_ROWS = inline({ type: "array", items: { type: "object", additionalProperties: false, required: ["personId", "acknowledgedAt"], properties: { personId: { $ref: "common.schema.json#/$defs/uuid" }, acknowledgedAt: { $ref: "common.schema.json#/$defs/tsMs" } } } });

export const ROUTES: Route[] = [
  // Auth
  { method: "GET", path: "/auth/login", response: { kind: "redirect" }, handle: () => ({ redirect: "https://auth.workos.example/authorize" }) },
  { method: "GET", path: "/auth/callback", response: { kind: "redirect" }, handle: () => ({ redirect: "/" }) },
  {
    method: "GET", path: "/auth/session",
    response: inline({ type: "object", additionalProperties: false, required: ["person", "csrfToken"], properties: { person: { $ref: "person.schema.json" }, csrfToken: { type: "string", minLength: 16 } } }),
    handle: (_r, s) => ({ person: s.me, csrfToken: "mock-csrf-0123456789abcdef" }),
  },
  { method: "POST", path: "/auth/logout", response: inline({ type: "object" }), handle: () => ({}) },

  // Devices and sync
  { method: "GET", path: "/v1/devices", response: array("device-enrollment.schema.json#/$defs/device"), handle: () => fx.devices },
  {
    method: "GET", path: "/v1/sync/config", response: schema("device-config.schema.json"),
    handle: (_r, s) => ({
      personId: s.me.id, tenantId: fx.tenant.id, jurisdiction: s.me.jurisdiction, requiredNotice: null,
      allowedKinds: ["notice_ack", "run_outcome", "review_event", "baseline_sample", "daily_aggregate", "workflow_proposal"],
      features: { workflow_metrics: true, per_person_views: featureOn(s, "per_person_views"), working_time: featureOn(s, "working_time") },
      workingTimeStartsAt: null, killSwitch: false, minAppVersion: "1.4.0", flushSeconds: 900,
    }),
  },

  // Self-view
  { method: "GET", path: "/v1/me/data", response: schema("self-view.schema.json"), handle: (_r, s) => selfView(s) },
  { method: "GET", path: "/v1/me/access-log", response: array("audit-event.schema.json"), handle: (_r, s) => s.auditLog.filter((e) => e.subjectPersonId === s.me.id) },
  {
    method: "GET", path: "/v1/me/export", response: schema("self-view.schema.json"),
    handle: (_r, s) => {
      audit(s, "self.export", { type: "self_view", id: null }, s.me.id);
      return selfView(s);
    },
  },
  {
    method: "GET", path: "/v1/me/digest", response: schema("digest.schema.json"),
    handle: (r, s) => ({
      personId: s.me.id, day: r.query.get("day") ?? fx.TODAY,
      ran: fx.workerRuns.filter((w) => w.endedAt !== null && w.endedAt > fx.NOW - fx.DAY_MS * 1.2).map((w, i) => ({
        runId: w.id, workflowId: fx.workers.find((k) => k.id === w.workerId)!.workflowId,
        outcome: w.state === "done" ? ("success" as const) : w.state === "capped" ? ("capped" as const) : ("failed" as const),
        drafts: 4 + i, costCents: w.costCents,
      })),
      waiting: s.batches.filter((b) => b.state === "pending").map((b) => ({ batchHash: b.batchHash, workflowId: b.workflowId, items: b.items.length })),
      autoCommitted: [{ batchHash: hex64("batch:auto"), policyId: uuid(901), items: 9 }],
      trips: fx.overnightPolicies.filter((p) => p.state === "tripped").map((p) => ({ policyId: p.id, reason: p.trippedReason ?? "" })),
      suggestions: [
        { title: "Reconcile the weekly carrier invoices", class: "draft", estimatedMinutes: 45, label: "estimated" },
        { title: "Send delivery confirmations to key accounts", class: "commit", estimatedMinutes: 20, label: "estimated" },
      ],
      totalCostCents: fx.workerRuns.filter((w) => w.endedAt !== null && w.endedAt > fx.NOW - fx.DAY_MS * 1.2).reduce((a, w) => a + w.costCents, 0),
    }),
  },
  { method: "POST", path: "/v1/me/correction-requests", response: inline({ type: "object", required: ["id"] }), handle: () => ({ id: ulid(99_001) }) },

  // Org
  { method: "GET", path: "/v1/tenant", response: schema("tenant.schema.json"), handle: () => fx.tenant },
  { method: "GET", path: "/v1/departments", response: array("department.schema.json"), handle: () => fx.departments },
  {
    method: "GET", path: "/v1/people", response: array("person.schema.json"),
    handle: (_r, s) => [...s.people].sort((a, b) => a.displayName.localeCompare(b.displayName)), // directory order: by name
  },
  {
    method: "GET", path: "/v1/people/:id", response: schema("person.schema.json"),
    handle: (r, s) => {
      const p = s.people.find((x) => x.id === r.params.id) ?? notFound();
      audit(s, "person.read", { type: "person", id: p.id }, p.id);
      return p;
    },
  },
  { method: "GET", path: "/v1/job-roles", response: array("job-role.schema.json"), handle: () => fx.jobRoles },
  { method: "GET", path: "/v1/role-identities", response: array("role-identity.schema.json"), handle: () => fx.roleIdentities },

  // Connections and policies
  { method: "GET", path: "/v1/connections", response: array("connection.schema.json"), handle: () => fx.connections },
  {
    method: "GET", path: "/v1/policies/job-roles/:id", response: schema("role-policy.schema.json"),
    handle: (r) => (fx.jobRoles.some((j) => j.id === r.params.id) ? fx.rolePolicyFor(r.params.id!) : notFound()),
  },
  {
    method: "GET", path: "/v1/overnight-policies", response: array("overnight-policy.schema.json"),
    handle: (r) => fx.overnightPolicies.filter((p) => !r.query.get("workflowId") || p.workflowId === r.query.get("workflowId")),
  },

  // Registry
  {
    method: "GET", path: "/v1/workflows", response: array("workflow.schema.json"),
    handle: (r, s) => s.workflows.filter((w) =>
      (!r.query.get("state") || w.state === r.query.get("state"))
      && (!r.query.get("jobRoleId") || w.jobRoleId === r.query.get("jobRoleId"))
      && (!r.query.get("departmentId") || w.departmentId === r.query.get("departmentId"))),
  },
  { method: "GET", path: "/v1/workflows/:id", response: schema("workflow.schema.json"), handle: (r, s) => s.workflows.find((w) => w.id === r.params.id) ?? notFound() },
  {
    method: "GET", path: "/v1/workflows/:id/versions/:v", response: schema("workflow-definition.schema.json"),
    handle: (r) => fx.definitionFor(r.params.id!, Number(r.params.v)) ?? notFound(),
  },
  {
    method: "GET", path: "/v1/workflows/:id/versions/:v/sop", response: { kind: "text" },
    handle: (r) => fx.sopMarkdown(r.params.id!, Number(r.params.v)) ?? notFound(),
  },
  {
    method: "POST", path: "/v1/workflows/:id/promote", request: schema("promote-request.schema.json"), response: schema("workflow.schema.json"),
    handle: (r, s) => {
      const w = s.workflows.find((x) => x.id === r.params.id) ?? notFound();
      const body = r.body as PromoteRequest;
      const def = fx.definitionFor(w.id, body.fromVersion) ?? notFound();
      for (const step of def.steps) {
        const b = body.bindings.find((x) => x.stepId === step.id);
        const kind = b?.connectionId ? fx.connections.find((c) => c.id === b.connectionId)?.kind : step.connection?.kind;
        // Never automate a personal LinkedIn: a commit step on linkedin_personal must be disabled (ADR 0104, 0107).
        if (step.class === "commit" && kind === "linkedin_personal" && !b?.disable) fail("forbidden_binding", 409);
      }
      w.state = "role";
      w.jobRoleId = body.jobRoleId;
      w.departmentId = body.departmentId;
      w.promotedBy = s.me.id;
      w.promotedAt = fx.NOW;
      w.latestVersion += 1;
      w.versions.push({ version: w.latestVersion, definitionHash: hex64(`def:promoted:${w.id}:${w.latestVersion}`), createdAt: fx.NOW, createdBy: s.me.id });
      audit(s, "workflow.promote", { type: "workflow", id: w.id }, null, { version: w.latestVersion });
      return w;
    },
  },
  {
    method: "POST", path: "/v1/workflows/:id/decline", response: schema("workflow.schema.json"),
    handle: (r, s) => {
      const w = s.workflows.find((x) => x.id === r.params.id) ?? notFound();
      w.state = "declined";
      audit(s, "workflow.decline", { type: "workflow", id: w.id }, null);
      return w;
    },
  },

  // Broker
  {
    method: "GET", path: "/v1/batches", response: array("batch.schema.json"),
    handle: (r, s) => s.batches.filter((b) => !r.query.get("state") || b.state === r.query.get("state")),
  },
  {
    method: "GET", path: "/v1/batches/:hash", response: schema("batch.schema.json"),
    handle: (r, s) => {
      const b = s.batches.find((x) => x.batchHash === r.params.hash) ?? notFound();
      audit(s, "batch.view", { type: "batch", id: b.batchHash.slice(0, 16) }, null);
      return b;
    },
  },
  {
    method: "POST", path: "/v1/batches/:hash/approve", request: schema("approval.schema.json#/$defs/request"), response: schema("approval.schema.json#/$defs/response"),
    handle: (r, s) => {
      const b = s.batches.find((x) => x.batchHash === r.params.hash) ?? notFound();
      const body = r.body as ApprovalRequest;
      if (body.batchHash !== b.batchHash) fail("hash_mismatch", 409);
      if (b.state !== "pending") fail("token_used", 409);
      if (s.killSwitches.some((k) => k.active && (k.scope === "tenant" || k.targetId === b.workflowId))) fail("kill_switch_active", 409);
      b.state = "approved";
      audit(s, "batch.approve", { type: "batch", id: b.batchHash.slice(0, 16) }, null, { items: b.items.length });
      return { batchHash: b.batchHash, state: "approved", approverKind: "person", approvedBy: s.me.id, tokenExpiresAt: fx.NOW + 15 * 60_000 };
    },
  },
  {
    method: "POST", path: "/v1/batches/:hash/reject", response: schema("batch.schema.json"),
    handle: (r, s) => {
      const b = s.batches.find((x) => x.batchHash === r.params.hash) ?? notFound();
      b.state = "rejected";
      for (const i of b.items) i.state = "rejected";
      audit(s, "batch.reject", { type: "batch", id: b.batchHash.slice(0, 16) }, null);
      return b;
    },
  },
  { method: "GET", path: "/v1/kill-switches", response: array("kill-switch.schema.json"), handle: (_r, s) => s.killSwitches },
  {
    method: "POST", path: "/v1/kill-switches", response: schema("kill-switch.schema.json"),
    handle: (r, s) => {
      const body = r.body as { scope: "tenant" | "person" | "workflow"; targetId: string | null; reason: string };
      const k = { scope: body.scope, targetId: body.targetId, active: true, setBy: s.me.id, setAt: fx.NOW, reason: body.reason };
      s.killSwitches.push(k);
      audit(s, "kill_switch.set", { type: body.scope, id: body.targetId }, null);
      return k;
    },
  },

  // Cloud workers
  { method: "GET", path: "/v1/workers", response: array("worker.schema.json"), handle: () => fx.workers },
  {
    method: "GET", path: "/v1/workers/:id/runs", response: array("worker-run.schema.json"),
    handle: (r) => (fx.workers.some((w) => w.id === r.params.id) ? fx.workerRuns.filter((x) => x.workerId === r.params.id) : notFound()),
  },
  { method: "GET", path: "/v1/worker-runs/:id", response: schema("worker-run.schema.json"), handle: (r) => fx.workerRuns.find((x) => x.id === r.params.id) ?? notFound() },

  // Metrics
  {
    method: "GET", path: "/v1/metrics/hours-saved", response: schema("hours-saved-report.schema.json"),
    handle: (r, s) => {
      const scope = parseScope(r.query.get("scope"));
      if (scope.type === "person" && scope.id !== s.me.id) {
        if (!featureOn(s, "per_person_views")) fail("feature_disabled", 403);
        audit(s, "person.read", { type: "hours_saved", id: scope.id }, scope.id);
      }
      const { from, to } = period(r.query);
      return hoursSavedReport(scope, from, to);
    },
  },
  {
    method: "GET", path: "/v1/metrics/hours-saved/evidence", response: schema("hours-saved-evidence.schema.json"),
    handle: (r) => evidence(r.query.get("workflowId") ?? "", Number(r.query.get("version") ?? "1")) ?? notFound(),
  },
  {
    method: "GET", path: "/v1/metrics/adoption", response: schema("adoption-report.schema.json"),
    handle: (r) => {
      const { from, to } = period(r.query);
      return adoption(parseScope(r.query.get("scope")), from, to);
    },
  },
  {
    method: "GET", path: "/v1/metrics/working-time", response: schema("working-time-report.schema.json"),
    handle: (r, s) => {
      if (!featureOn(s, "working_time")) fail("feature_disabled", 403);
      const scope = parseScope(r.query.get("scope"));
      if (scope.type === "person" && scope.id !== s.me.id && !featureOn(s, "per_person_views")) fail("feature_disabled", 403);
      const { from, to } = period(r.query);
      return workingTime(scope, from, to);
    },
  },

  // Continuity
  {
    method: "GET", path: "/v1/handovers", response: array("handover.schema.json"),
    handle: (r, s) => s.handovers.filter((x) => !r.query.get("state") || x.state === r.query.get("state")),
  },
  {
    method: "POST", path: "/v1/handovers/:id/assign", response: schema("handover.schema.json"),
    request: pick("handover.schema.json", ["successor", "inFlight", "inboxStep"]),
    handle: (r, s) => {
      const hv = s.handovers.find((x) => x.id === r.params.id) ?? notFound();
      const body = r.body as Pick<Handover, "successor" | "inFlight" | "inboxStep">;
      if (body.successor?.type === "person") {
        const succ = body.successor.personId;
        const wf = s.workflows.find((w) => w.id === hv.workflowId);
        const role = fx.jobRoles.find((j) => j.id === wf?.jobRoleId);
        if (!role?.holderPersonIds.includes(succ) || succ === hv.personId) fail("forbidden_binding", 409);
      }
      Object.assign(hv, { successor: body.successor, inFlight: body.inFlight, inboxStep: body.inboxStep, state: "assigned", assignedBy: s.me.id, assignedAt: fx.NOW });
      audit(s, "handover.assign", { type: "handover", id: hv.id }, hv.personId);
      return hv;
    },
  },

  // Compliance
  { method: "GET", path: "/v1/compliance/features", response: array("feature-enablement.schema.json"), handle: (_r, s) => s.features },
  {
    method: "POST", path: "/v1/compliance/features/:feature/enable", request: pick("feature-enablement.schema.json", ENABLE_FIELDS), response: schema("feature-enablement.schema.json"),
    handle: (r, s, o) => {
      if (o.role !== "owner") fail("forbidden", 403);
      const body = r.body as FeatureEnableRequest;
      const e: FeatureEnablement = { ...body, enabledBy: s.me.id, enabledAt: fx.NOW, effectiveAt: fx.NOW + body.noticePeriodDays * fx.DAY_MS, disabledAt: null };
      s.features = [...s.features.filter((x) => x.feature !== body.feature), e];
      audit(s, "feature.enable", { type: "feature", id: body.feature }, null, { jurisdictions: body.jurisdictions });
      return e;
    },
  },
  {
    method: "POST", path: "/v1/compliance/features/:feature/disable", response: schema("feature-enablement.schema.json"),
    handle: (r, s, o) => {
      if (o.role !== "owner" && o.role !== "admin") fail("forbidden", 403);
      const e = s.features.find((x) => x.feature === r.params.feature && x.disabledAt === null) ?? notFound();
      e.disabledAt = fx.NOW;
      audit(s, "feature.disable", { type: "feature", id: e.feature }, null);
      return e;
    },
  },
  { method: "GET", path: "/v1/compliance/notices", response: array("notice.schema.json"), handle: (_r, s) => s.notices },
  {
    method: "GET", path: "/v1/compliance/notices/:id/acks", response: ACK_ROWS,
    handle: (r, s) => {
      const n = s.notices.find((x) => x.id === r.params.id) ?? notFound();
      return s.people.filter((p) => p.noticeAckVersionId === n.id).map((p, i) => ({ personId: p.id, acknowledgedAt: (n.publishedAt ?? fx.NOW) + (i + 1) * 3_600_000 }));
    },
  },
  {
    method: "POST", path: "/v1/compliance/notices/:id/publish", response: schema("notice.schema.json"),
    handle: (r, s) => {
      const n = s.notices.find((x) => x.id === r.params.id) ?? notFound();
      n.publishedAt = fx.NOW;
      audit(s, "notice.publish", { type: "notice", id: n.id }, null);
      return n;
    },
  },
  {
    method: "GET", path: "/v1/compliance/templates",
    response: inline({ type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "jurisdictions"], properties: { id: { type: "string" }, title: { type: "string" }, jurisdictions: { type: "array", items: { $ref: "common.schema.json#/$defs/jurisdiction" } } } } }),
    handle: () => fx.templates,
  },
  {
    method: "GET", path: "/v1/audit-log", response: array("audit-event.schema.json"),
    handle: (r, s) => [...s.auditLog].reverse().filter((e) =>
      (!r.query.get("action") || e.action === r.query.get("action"))
      && (!r.query.get("subjectPersonId") || e.subjectPersonId === r.query.get("subjectPersonId"))),
  },
  {
    method: "GET", path: "/v1/audit-log/verify",
    response: inline({ type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" }, brokenAt: { type: "string" } } }),
    handle: (_r, s) => {
      for (let i = 1; i < s.auditLog.length; i++) if (s.auditLog[i]!.prevHash !== s.auditLog[i - 1]!.hash) return { ok: false, brokenAt: s.auditLog[i]!.id };
      return { ok: true };
    },
  },
];

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export function findRoute(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = match(route.path, path);
    if (params) return { route, params };
  }
  return undefined;
}

export interface MockClient extends ApiClient {
  /** Calls made so far, for tests ("GET /v1/people"). */
  readonly calls: string[];
}

/** A fresh mock with its own state; mutations never leak between clients. */
export function createMockClient(options: MockOptions = {}): MockClient {
  const o: Required<MockOptions> = { features: options.features ?? [], failures: options.failures ?? {}, role: options.role ?? "owner" };
  const people = structuredClone(fx.people);
  const me = people.find((p) => p.id === fx.ME.id)!;
  me.accessRole = o.role;
  const s: State = {
    workflows: structuredClone(fx.workflows), batches: structuredClone(fx.batches), handovers: structuredClone(fx.handovers),
    notices: structuredClone(fx.notices), killSwitches: structuredClone(fx.killSwitches), auditLog: structuredClone(fx.auditLog),
    people, me, features: o.features.map((f) => enablement(f, me.id)),
  };
  const calls: string[] = [];

  async function call(method: Route["method"], url: string, body?: unknown): Promise<unknown> {
    const [path, qs] = url.split("?") as [string, string | undefined];
    const key = `${method} ${path}`;
    calls.push(key);
    const found = findRoute(method, path);
    if (!found) throw new ApiError("not_found", 404);
    const forced = o.failures[`${method} ${found.route.path}`];
    if (forced) throw new ApiError(forced, forced === "feature_disabled" || forced === "forbidden" ? 403 : 500);
    const result = found.route.handle({ params: found.params, query: new URLSearchParams(qs ?? ""), body }, s, o);
    return structuredClone(result);
  }

  return {
    calls,
    get: <T>(p: string) => call("GET", p) as Promise<T>,
    getText: (p: string) => call("GET", p) as Promise<string>,
    post: <T>(p: string, b?: unknown) => call("POST", p, b ?? {}) as Promise<T>,
    patch: <T>(p: string, b: unknown) => call("PATCH", p, b) as Promise<T>,
    delete: <T>(p: string) => call("DELETE", p) as Promise<T>,
  };
}
