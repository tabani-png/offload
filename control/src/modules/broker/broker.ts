/**
 * The commit broker (ADR 0105 §3, ADR 0106): the only component that commits. Stage 1 gate semantics, server-side:
 *   - batchHash is the brain's (stage1.ts); every read re-derives it from the stored items, so a changed item can
 *     never be approved or sent (Stage 1 `intact`).
 *   - approval mints a one-use token for one hash (sha256 at rest, 24 h); edits make a new hash, the old batch becomes
 *     `rejected` (reason `edited`).
 *   - the deterministic executor builds each call from the approved item; the call's full canonical arguments must
 *     hash like the approved item's (brain `canonicalArgs` / `expectedHash`) or the item is `failed_before_send`.
 *   - journal: `sending` and the contacted ledger are committed before the call; a throw, a non-success or a crash
 *     after that is `unknown`, which is never retried; only a person's `release` frees the recipient again.
 *   - kill switches (tenant, person, workflow) block approval and execution and revoke unspent tokens.
 *   - overnight policies (evaluateOvernight) mint the same token a person would, with approverKind "policy".
 * No model is in the loop anywhere below.
 */
import type { Deps, Principal } from "../../app.ts";
import { actorOf } from "../../app.ts";
import type { AuditInput } from "../../audit/audit.ts";
import type { Tx } from "../../db/pool.ts";
import { ms, msNN } from "../../db/pool.ts";
import { isUuid, withTenant } from "../../db/tenant.ts";
import { HttpError, conflict, forbidden, invalid, notFound, type ErrorCode } from "../../schema/http.ts";
import { jcs, randomToken, sha256Hex } from "../../schema/encoding.ts";
import type { BrokerPort } from "../../ports.ts";
import {
  evaluateOvernight,
  inWindow,
  isTimezone,
  nextWindowStart,
  nightOf,
  recipientAllowed,
  windowTimezone,
  type OvernightDecision,
  type OvernightPolicy,
} from "../policies/evaluate.ts";
import { overnightById, rolePolicyOf, type RolePolicy } from "../policies/repo.ts";
import { scrubLogText } from "../../../../brain/src/log.ts";
import type { CommitCall, CommitTarget, Executor } from "./executors.ts";
import {
  checkCall,
  fromStage1,
  itemHashOf,
  itemRef,
  methodOf,
  normaliseAddress,
  policyForItem,
  recipientOf,
  stage1Hash,
  toStage1,
  type BatchItem,
  type CrmSheet,
  type Field,
  type Method,
  type Stage2Item,
  type ToolPolicy,
} from "./stage1.ts";

export const TOKEN_TTL_MS = 24 * 3600_000;
export const BATCH_TTL_MS = 24 * 3600_000;
/** A `sending` item older than this with no result is `unknown` (the process died during the call). */
export const SENDING_STALE_MS = 10 * 60_000;

export type BatchState = "pending" | "approved" | "sending" | "done" | "rejected" | "expired";
export type ItemState = "pending" | "sending" | "sent" | "failed_before_send" | "unknown" | "rejected";

/** What the orchestrator (S2-09) or the Mac run hands over with `offload_propose_batch`. Trusted code fills it, never
 * the model: recipients the run may write to, the template it drafted with and the connection it commits through. */
export interface ProposeRun {
  runId: string;
  workflowId: string;
  version: number;
  jobRoleId: string;
  runtime: "mac" | "cloud";
  identity: { type: "person" | "role_identity"; id: string };
  /** The person who runs (or owns) the run: the "runner" approver. */
  runnerPersonId: string;
  connectionId: string;
  overnight?: boolean;
  overnightPolicyId?: string;
  /** The run's input set (ADR 0105 §7). When given, a recipient outside it and outside the overnight allowlist is
   * `recipient_not_allowed` and trips the policy. */
  inputRecipients?: string[];
  templateHash?: string | null;
  recipientTimezones?: Record<string, string>;
  threadsStartedByIdentity?: string[];
  crmSheet?: CrmSheet;
}

export type ProposeResult =
  | { ok: true; batchHash: string; state: BatchState; overnightEvaluation: OvernightEvaluation | null; autoApproved: number }
  | { ok: false; code: ErrorCode; message: string; tripped: string | null; item?: string };

export interface OvernightEvaluation {
  policyId: string;
  result: "allow" | "queue" | "trip";
  reason: string | null;
}

export interface ApprovalRequest {
  batchHash: string;
  itemKeys: string[] | null;
  edits: Array<{ key: string; fields: Field[] }>;
}

export interface ApprovalResponse {
  batchHash: string;
  state: "approved" | "sending";
  approverKind: "person" | "policy";
  approvedBy: string;
  tokenExpiresAt: number;
}

export interface CommitSummary {
  batchHash: string;
  scheduled: number;
  sent: number;
  unknown: number;
  failedBeforeSend: number;
  waiting: number;
}

export interface BatchDto {
  batchHash: string;
  workflowId: string;
  version: number;
  runId: string;
  runtime: "mac" | "cloud";
  identity: { type: "person" | "role_identity"; id: string };
  state: BatchState;
  createdAt: number;
  expiresAt: number;
  items: Array<{ key: string; capability: string; fields: Field[]; itemHash: string; state: ItemState }>;
  overnightEvaluation: OvernightEvaluation | null;
}

export interface Executors {
  composio?: Executor;
  mcp?: Executor;
  api?: Executor;
}

/** The full broker. The frozen `BrokerPort` (ports.ts) is a subset; S2-09/S2-10 reach the rest via `brokerOf(ports)`. */
export interface Broker extends BrokerPort {
  readonly isFullBroker: true;
  configure(o: { executors?: Executors }): void;
  proposeBatch(tenantId: string, run: ProposeRun, items: Stage2Item[]): Promise<ProposeResult>;
  approve(tx: Tx, p: Principal, hash: string, req: ApprovalRequest): Promise<{ response: ApprovalResponse; token: string }>;
  reject(tx: Tx, p: Principal, hash: string, reason: string): Promise<BatchDto>;
  release(tx: Tx, p: Principal, hash: string, keys: string[]): Promise<BatchDto>;
  commitApproved(tenantId: string, hash: string, token: string): Promise<CommitSummary>;
  runDue(tenantId: string, hash?: string): Promise<CommitSummary>;
  reconcile(tenantId: string, staleMs?: number): Promise<number>;
  revokeTokensFor(tx: Tx, personId: string): Promise<number>;
  /** Is the tenant-wide kill switch on? */
  tenantKilled(tx: Tx): Promise<boolean>;
  stopRunsFor(tx: Tx, personId: string): Promise<{ tokens: number; policies: number; workers: number }>;
  revokeForKill(tx: Tx, scope: "tenant" | "person" | "workflow", targetId: string | null, reason: string): Promise<number>;
  reportNightSignals(tenantId: string, policyId: string, s: { sends?: number; bounces?: number; negativeReplies?: number; costCents?: number }): Promise<string | null>;
  reportRunResult(tenantId: string, policyId: string, ok: boolean): Promise<string | null>;
  /** After a policy edit (policies module): a narrowing edit unlinks what the policy approved and has not sent; a
   * widening edit makes the rest of tonight a dry run (ADR 0112 §1-2). */
  policyChanged(tx: Tx, policyId: string, change: { narrowed: boolean; widened: boolean }): Promise<number>;
  /** Background commits started by approvals and policies; tests await it. */
  idle(): Promise<void>;
  dispatch(tenantId: string, hash: string, token: string): void;
  visibility(tx: Tx, p: Principal, b: BatchRow): Promise<{ visible: boolean; approver: boolean; fields: boolean }>;
  loadBatch(tx: Tx, hash: string, lock?: boolean): Promise<BatchRow | null>;
  dto(tx: Tx, b: BatchRow, fields: boolean): Promise<BatchDto>;
}

export function brokerOf(ports: { broker: BrokerPort }): Broker {
  const b = ports.broker as Partial<Broker>;
  if (b.isFullBroker !== true) throw new Error("the S2-07 broker module is not loaded");
  return b as Broker;
}

export interface BatchRow {
  hash: string;
  workflowId: string;
  version: number;
  runId: string;
  runtime: "mac" | "cloud";
  identityType: "person" | "role_identity";
  identityId: string;
  jobRoleId: string;
  departmentId: string;
  runnerPersonId: string;
  connectionId: string;
  crmSheet: CrmSheet | null;
  state: BatchState;
  rejectedReason: string | null;
  overnightPolicyId: string | null;
  overnightEval: OvernightEvaluation | null;
  createdAt: number;
  expiresAt: number;
}

interface ItemRow {
  key: string;
  position: number;
  capability: string;
  fields: Field[];
  itemHash: string;
  recipient: string;
  recipientTz: string | null;
  state: ItemState;
  tokenId: string | null;
  scheduledFor: number | null;
}

const SERVICE: AuditInput["actor"] = { type: "service", id: null, accessRole: "service" };

function batchRow(r: Record<string, unknown>): BatchRow {
  return {
    hash: r.hash as string,
    workflowId: r.workflow_id as string,
    version: Number(r.version),
    runId: r.run_id as string,
    runtime: r.runtime as BatchRow["runtime"],
    identityType: r.identity_type as BatchRow["identityType"],
    identityId: r.identity_id as string,
    jobRoleId: r.job_role_id as string,
    departmentId: r.department_id as string,
    runnerPersonId: r.runner_person_id as string,
    connectionId: r.connection_id as string,
    crmSheet: (r.crm_sheet as CrmSheet | null) ?? null,
    state: r.state as BatchState,
    rejectedReason: (r.rejected_reason as string | null) ?? null,
    overnightPolicyId: (r.overnight_policy_id as string | null) ?? null,
    overnightEval: (r.overnight_eval as OvernightEvaluation | null) ?? null,
    createdAt: msNN(r.created_at as Date),
    expiresAt: msNN(r.expires_at as Date),
  };
}

function itemRow(r: Record<string, unknown>): ItemRow {
  return {
    key: r.key as string,
    position: Number(r.position),
    capability: r.capability as string,
    fields: r.fields as Field[],
    itemHash: r.item_hash as string,
    recipient: r.recipient as string,
    recipientTz: (r.recipient_tz as string | null) ?? null,
    state: r.state as ItemState,
    tokenId: (r.token_id as string | null) ?? null,
    scheduledFor: ms(r.scheduled_for as Date | null),
  };
}

async function itemsOf(tx: Tx, hash: string): Promise<ItemRow[]> {
  return (await tx`select * from batch_items where batch_hash = ${hash} order by position`).map(itemRow);
}

/** Stage 1 items of stored rows, or null when a stored row no longer parses (tampered). */
function stage1Items(rows: ItemRow[]): BatchItem[] | null {
  const out: BatchItem[] = [];
  for (const r of rows) {
    const s = toStage1({ key: r.key, capability: r.capability, fields: r.fields });
    if ("reason" in s) return null;
    out.push(s.item);
  }
  return out;
}

/** Stage 1 `intact`: the stored items still hash to the batch's hash. */
function intact(b: BatchRow, rows: ItemRow[]): boolean {
  const items = stage1Items(rows);
  return items !== null && stage1Hash(b.workflowId, items) === b.hash;
}

const hasAttachments = (i: BatchItem) => (i.commit?.fields ?? []).some(([l, v]) => /^attachment/i.test(l) && v.trim() !== "");

const reject = (code: ErrorCode, message: string, tripped: string | null = null, item?: string): ProposeResult => ({
  ok: false,
  code,
  message,
  tripped,
  ...(item === undefined ? {} : { item }),
});

/**
 * Free text bound for the audit log or the item journal (ADR 0111 §6: owner, admin and auditor read the audit log and
 * are not approvers). The brain's `scrubLogText` drops addresses and quoted text; the recipients the text may name,
 * and their domains, go too (a provider error or an allowlist reason quotes them, and a bare domain is no address).
 */
export function scrubFor(text: string, recipients: readonly string[]): string {
  let s = text;
  const swap = (needle: string, by: string) => {
    if (needle.length < 3) return;
    s = s.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), by);
  };
  for (const r of recipients) swap(r.trim(), "<address>");
  for (const r of recipients) {
    const at = r.lastIndexOf("@");
    if (at >= 0) swap(r.slice(at + 1).trim(), "<domain>");
  }
  return scrubLogText(s);
}

interface Validated {
  items: BatchItem[];
  hash: string;
  conn: ConnRow;
  policy: RolePolicy;
}

interface ConnRow {
  id: string;
  kind: string;
  ownership: string;
  provider: string;
  externalRef: string;
  ownerPersonId: string | null;
  jobRoleId: string | null;
}

async function connectionOf(tx: Tx, id: string): Promise<ConnRow | null> {
  const [c] = await tx`select * from connections where id = ${id}`;
  if (!c) return null;
  return {
    id: c.id as string,
    kind: c.kind as string,
    ownership: c.ownership as string,
    provider: c.provider as string,
    externalRef: c.external_ref as string,
    ownerPersonId: (c.owner_person_id as string | null) ?? null,
    jobRoleId: (c.job_role_id as string | null) ?? null,
  };
}

/**
 * What an approval binds besides the items (N2): the batch's sending identity, runner, job role and CRM sheet, and the
 * connection's account as it was at approval. Stored with the token and re-derived before every call, so a re-linked
 * mailbox or a re-pointed batch no longer matches.
 */
function bindingHash(b: BatchRow, c: ConnRow): string {
  return sha256Hex(
    jcs({
      v: 1,
      batch: b.hash,
      identity: [b.identityType, b.identityId],
      runner: b.runnerPersonId,
      jobRole: b.jobRoleId,
      crmSheet: b.crmSheet,
      connection: [c.id, c.kind, c.ownership, c.provider, c.externalRef, c.ownerPersonId, c.jobRoleId],
    }),
  );
}

/** The binding rules that hold at propose and again before every call. */
function bindingRefusal(conn: ConnRow): string | null {
  if (conn.kind === "linkedin_personal") return "a personal LinkedIn account is never automated";
  if (conn.ownership === "personal-forbidden") return "this connection is personal-forbidden for workflows";
  if (methodOf(conn.provider) === null) return "this connection holds read credentials only";
  return null;
}

export function createBroker(deps: Deps): Broker {
  const now = () => deps.clock.now();
  const audit = (tx: Tx, e: AuditInput) => deps.ports.audit.write(tx, e);
  let executors: Executors = {};
  const inflight = new Set<Promise<unknown>>();
  const service = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
    withTenant(deps.db, { tenantId, principalId: null, principalPersonId: null, accessRole: "service" }, fn);

  // ---------- kill switches ----------

  async function killActive(tx: Tx, target: { personIds?: string[]; workflowId?: string }): Promise<boolean> {
    const persons = (target.personIds ?? []).filter(isUuid);
    const wf = target.workflowId && isUuid(target.workflowId) ? target.workflowId : null;
    const [r] = await tx`select 1 from kill_switches where active and (scope = 'tenant'
        or (scope = 'person' and target_id in (select jsonb_array_elements_text(${persons}::jsonb)::uuid))
        or (scope = 'workflow' and target_id = ${wf}::uuid)) limit 1`;
    return r !== undefined;
  }
  const batchKilled = (tx: Tx, b: BatchRow) =>
    killActive(tx, { personIds: [b.runnerPersonId, ...(b.identityType === "person" ? [b.identityId] : [])], workflowId: b.workflowId });

  // ---------- state ----------

  /** Expired, never-used tokens no longer authorise their items. */
  async function sweepTokens(tx: Tx, hash: string): Promise<void> {
    await tx`update batch_items set token_id = null, scheduled_for = null, updated_at = ${new Date(now())}
      where batch_hash = ${hash} and state = 'pending' and token_id in (select id from approval_tokens
        where batch_hash = ${hash} and used_at is null and (revoked_at is not null or expires_at <= ${new Date(now())}))`;
  }

  async function recompute(tx: Tx, hash: string): Promise<BatchState> {
    const [b] = await tx`select state, expires_at from batches where hash = ${hash} for update`;
    if (!b) throw notFound();
    let state = b.state as BatchState;
    if (state === "rejected" || state === "expired") return state;
    await sweepTokens(tx, hash);
    const [c] = await tx`select
        count(*) filter (where i.state = 'sending')::int as sending,
        count(*) filter (where i.state = 'pending' and i.token_id is not null)::int as authorised,
        count(*) filter (where i.state = 'pending' and i.token_id is null)::int as open
      from batch_items i where i.batch_hash = ${hash}`;
    if (Number(c!.sending) > 0) state = "sending";
    else if (Number(c!.authorised) > 0) state = "approved";
    else if (Number(c!.open) > 0) state = msNN(b.expires_at as Date) <= now() ? "expired" : "pending";
    else state = "done";
    await tx`update batches set state = ${state}, updated_at = ${new Date(now())} where hash = ${hash}`;
    return state;
  }

  async function loadBatch(tx: Tx, hash: string, lock = false): Promise<BatchRow | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const [r] = lock ? await tx`select * from batches where hash = ${hash} for update` : await tx`select * from batches where hash = ${hash}`;
    return r ? batchRow(r) : null;
  }

  async function dto(tx: Tx, b: BatchRow, fields: boolean): Promise<BatchDto> {
    const rows = await itemsOf(tx, b.hash);
    return {
      batchHash: b.hash,
      workflowId: b.workflowId,
      version: b.version,
      runId: b.runId,
      runtime: b.runtime,
      identity: { type: b.identityType, id: b.identityId },
      state: b.state,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
      // ADR 0111 §6: without the right to see fields, the key (a recipient) becomes the content-free Stage 1 itemRef.
      items: rows.map((r) => ({
        key: fields ? r.key : itemRef(b.workflowId, r.key),
        capability: r.capability,
        fields: fields ? r.fields : [],
        itemHash: r.itemHash,
        state: r.state,
      })),
      overnightEvaluation: b.overnightEval,
    };
  }

  // ---------- who may approve and see ----------

  async function visibility(tx: Tx, p: Principal, b: BatchRow) {
    const policy = await rolePolicyOf(tx, b.jobRoleId);
    const runner = p.personId === b.runnerPersonId;
    const lead = p.accessRole === "dept_lead" && p.departmentScope.includes(b.departmentId);
    const approver =
      policy !== null &&
      ((runner && (policy.approvers === "runner" || policy.approvers === "runner_or_dept_lead")) ||
        (lead && (policy.approvers === "dept_lead" || policy.approvers === "runner_or_dept_lead")));
    const visible = runner || approver || p.accessRole === "owner" || p.accessRole === "admin" || lead;
    // ADR 0111 §6: only an approver sees recipients and bodies; a runner who may not approve sees the batch without them.
    return { visible, approver, fields: approver };
  }

  async function mustApprove(tx: Tx, p: Principal, b: BatchRow): Promise<void> {
    const v = await visibility(tx, p, b);
    if (!v.visible) throw notFound();
    if (!v.approver) throw forbidden("You are not an approver for this batch");
  }

  // ---------- validation shared by propose and edit ----------

  async function validate(
    tx: Tx,
    run: Pick<ProposeRun, "workflowId" | "jobRoleId" | "identity" | "runnerPersonId" | "connectionId" | "crmSheet">,
    input: Stage2Item[],
  ): Promise<{ ok: true; v: Validated } | { ok: false; r: ProposeResult }> {
    const policy = await rolePolicyOf(tx, run.jobRoleId);
    if (!policy) return { ok: false, r: reject("forbidden", "this job role has no role policy: nothing can be committed") };
    if (input.length === 0) return { ok: false, r: reject("validation_failed", "a batch needs at least one item") };
    if (input.length > policy.maxItemsPerBatch) {
      return { ok: false, r: reject("validation_failed", `the role policy allows at most ${policy.maxItemsPerBatch} items per batch`) };
    }
    const conn = await connectionOf(tx, run.connectionId);
    if (!conn) return { ok: false, r: reject("validation_failed", "unknown connection") };
    const refusal = bindingRefusal(conn);
    if (refusal) return { ok: false, r: reject("forbidden_binding", refusal) };
    // Identity: never send as anyone else (ADR 0106 §6, ADR 0107).
    if (run.identity.type === "person") {
      if (run.identity.id !== run.runnerPersonId) return { ok: false, r: reject("forbidden_binding", "a run sends only as its own runner") };
      const [person] = await tx`select state from people where id = ${run.identity.id}`;
      if (!person || !["active", "leaving"].includes(person.state as string)) {
        return { ok: false, r: reject("forbidden_binding", "the sending person is not active") };
      }
      if (conn.ownership === "personal-allowed" && conn.ownerPersonId !== run.identity.id) {
        return { ok: false, r: reject("forbidden_binding", "a personal connection sends only as its owner") };
      }
    } else {
      const [ri] = await tx`select job_role_id, connection_id from role_identities where id = ${run.identity.id}`;
      if (!ri || ri.job_role_id !== run.jobRoleId || ri.connection_id !== conn.id || conn.ownership !== "company") {
        return { ok: false, r: reject("forbidden_binding", "a role identity sends only through its own company connection") };
      }
    }
    const items: BatchItem[] = [];
    const keys = new Set<string>();
    const ref = (key: string) => itemRef(run.workflowId, key);
    for (const it of input) {
      const s = toStage1(it);
      if ("reason" in s) return { ok: false, r: reject("validation_failed", s.reason, null, typeof it.key === "string" ? ref(it.key) : undefined) };
      // The same recipient twice, however it is spelled (trim, case, NFC, punycode: the brain's normaliseAddress).
      const same = normaliseAddress(s.item.to) ?? s.item.to.normalize("NFC").trim().toLowerCase();
      if (keys.has(s.item.key) || keys.has(same)) return { ok: false, r: reject("validation_failed", "two items for the same recipient", null, ref(s.item.key)) };
      keys.add(s.item.key);
      keys.add(same);
      if (!policy.allowedCapabilities.includes(it.capability)) {
        return { ok: false, r: reject("forbidden", `capability ${it.capability} is not allowed for this job role`, null, ref(s.item.key)) };
      }
      items.push(s.item);
    }
    const hash = stage1Hash(run.workflowId, items);
    const method = methodOf(conn.provider)!;
    for (let i = 0; i < items.length; i++) {
      const pr = policyForItem(input[i]!.capability, items[i]!, { kind: conn.kind, method }, { batchHash: hash, ...(run.crmSheet ? { crmSheet: run.crmSheet } : {}) });
      if ("reason" in pr) return { ok: false, r: reject("forbidden", pr.reason, null, ref(items[i]!.key)) };
    }
    // Stage 1: an `unknown` item counts as contacted until a person releases it; it is never drafted again before.
    for (const item of items) {
      const [u] = await tx`select 1 from contacted_ledger where workflow_id = ${run.workflowId} and recipient = ${recipientOf(item)}
        and outcome in ('sending', 'unknown') and released_at is null limit 1`;
      if (u) return { ok: false, r: reject("conflict", "a recipient in this batch may already have been sent to: release it before a new batch", null, ref(item.key)) };
    }
    return { ok: true, v: { items, hash, conn, policy } };
  }

  async function insertBatch(
    tx: Tx,
    run: ProposeRun,
    v: Validated,
    input: Stage2Item[],
    overnightPolicyId: string | null,
    recipientTzs?: Record<string, string>,
  ): Promise<void> {
    const [jr] = await tx`select department_id from job_roles where id = ${run.jobRoleId}`;
    if (!jr) throw invalid("unknown job role");
    const t = now();
    await tx`insert into batches (tenant_id, hash, workflow_id, version, run_id, runtime, identity_type, identity_id, job_role_id,
        department_id, runner_person_id, connection_id, crm_sheet, state, overnight_policy_id, created_at, expires_at, updated_at)
      values (current_setting('app.tenant_id')::uuid, ${v.hash}, ${run.workflowId}, ${run.version}, ${run.runId}, ${run.runtime},
        ${run.identity.type}, ${run.identity.id}, ${run.jobRoleId}, ${jr.department_id}, ${run.runnerPersonId}, ${run.connectionId},
        ${run.crmSheet ?? null}::jsonb, 'pending', ${overnightPolicyId}, ${new Date(t)},
        ${new Date(t + BATCH_TTL_MS)}, ${new Date(t)})`;
    for (let i = 0; i < v.items.length; i++) {
      const item = v.items[i]!;
      const tz = recipientTzs?.[recipientOf(item)] ?? recipientTzs?.[item.key] ?? null;
      await tx`insert into batch_items (tenant_id, batch_hash, key, position, capability, fields, item_hash, recipient, recipient_tz,
          state, updated_at)
        values (current_setting('app.tenant_id')::uuid, ${v.hash}, ${item.key}, ${i}, ${input[i]!.capability},
          ${fromStage1(item)}::jsonb, ${itemHashOf(run.workflowId, item)}, ${recipientOf(item)},
          ${tz !== null && isTimezone(tz) ? tz : null}, 'pending', ${new Date(t)})`;
    }
  }

  async function mintToken(
    tx: Tx,
    hash: string,
    keys: string[],
    kind: "person" | "policy",
    approvedBy: string,
    policyId: string | null,
  ): Promise<{ token: string; expiresAt: number }> {
    const token = randomToken(32);
    const t = now();
    const b = await loadBatch(tx, hash);
    const conn = b ? await connectionOf(tx, b.connectionId) : null;
    if (!b || !conn) throw notFound();
    const [row] = await tx`insert into approval_tokens (tenant_id, token_hash, batch_hash, item_keys, approver_kind, approved_by,
        policy_id, created_at, expires_at, binding_hash)
      values (current_setting('app.tenant_id')::uuid, ${sha256Hex(token)}, ${hash}, ${keys}::jsonb, ${kind},
        ${approvedBy}, ${policyId}, ${new Date(t)}, ${new Date(t + TOKEN_TTL_MS)}, ${bindingHash(b, conn)}) returning id`;
    await tx`update batch_items set token_id = ${row!.id}, updated_at = ${new Date(t)}
      where batch_hash = ${hash} and key in (select jsonb_array_elements_text(${keys}::jsonb))`;
    return { token, expiresAt: t + TOKEN_TTL_MS };
  }

  /** Revokes unspent tokens of a batch and un-schedules its approved, unsent items (they need a new approval). */
  async function revokeBatch(tx: Tx, hash: string, reason: string): Promise<number> {
    const t = new Date(now());
    const r = await tx`update approval_tokens set revoked_at = ${t}, revoked_reason = ${reason}
      where batch_hash = ${hash} and used_at is null and revoked_at is null`;
    await tx`update batch_items set token_id = null, scheduled_for = null, updated_at = ${t}
      where batch_hash = ${hash} and state = 'pending' and token_id is not null`;
    await recompute(tx, hash);
    return r.count;
  }

  // ---------- overnight ----------

  async function tenantTimezone(tx: Tx): Promise<string> {
    const [t] = await tx`select reporting_timezone from tenants where id = current_setting('app.tenant_id')::uuid`;
    const tz = (t?.reporting_timezone as string | undefined) ?? "UTC";
    return isTimezone(tz) ? tz : "UTC";
  }

  async function tripPolicy(tx: Tx, policyId: string, reason: string, hash: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    const t = now();
    const [p] = await tx`update overnight_policies set state = 'tripped', tripped_reason = ${reason}, updated_at = ${new Date(t)}
      where id = ${policyId} returning owner_person_id`;
    if (!p) return;
    await tx`insert into breaker_trips (tenant_id, policy_id, reason, batch_hash, at, detail)
      values (current_setting('app.tenant_id')::uuid, ${policyId}, ${reason}, ${hash}, ${new Date(t)}, ${detail}::jsonb)`;
    // "pause the policy and queue the rest": unspent policy tokens are revoked, their unsent items go back to a person.
    await unlinkPolicy(tx, policyId, "breaker: " + reason);
    // Only a night that did not trip counts as a dry-run night (ADR 0106 "successful" nights; ADR 0112 §3).
    const night = nightOf(t, await tenantTimezone(tx));
    const [c] = await tx`select counted from overnight_counters where policy_id = ${policyId} and night = ${night}::date for update`;
    await tx`update overnight_counters set tripped = true, counted = false where policy_id = ${policyId} and night = ${night}::date`;
    if (c?.counted === true) {
      await tx`update overnight_policies set dry_run_nights_done = greatest(0, dry_run_nights_done - 1) where id = ${policyId}`;
    }
    await audit(tx, {
      actor: SERVICE,
      action: "overnight.trip",
      subjectPersonId: p.owner_person_id as string,
      resource: { type: "overnight_policy", id: policyId },
      detail: { reason, batchHash: hash, ...detail },
    });
  }

  /** Unspent approvals of a policy are revoked and its approved, unsent items go back to a person (no token, not
   * scheduled). Used by a trip, a narrowing edit and execute's fail-closed check. Returns the batches touched. */
  async function unlinkPolicy(tx: Tx, policyId: string, reason: string): Promise<number> {
    const t = new Date(now());
    const open = await tx`select distinct t.batch_hash from approval_tokens t where t.policy_id = ${policyId} and t.revoked_at is null
        and (t.used_at is null or exists (select 1 from batch_items i
          where i.tenant_id = t.tenant_id and i.token_id = t.id and i.state = 'pending'))`;
    for (const o of open) {
      await tx`update approval_tokens set revoked_at = ${t}, revoked_reason = ${reason.slice(0, 200)}
        where batch_hash = ${o.batch_hash} and policy_id = ${policyId} and used_at is null and revoked_at is null`;
      await tx`update batch_items set token_id = null, scheduled_for = null, updated_at = ${t}
        where batch_hash = ${o.batch_hash} and state = 'pending'
          and token_id in (select id from approval_tokens where policy_id = ${policyId})`;
      await recompute(tx, o.batch_hash as string);
    }
    return open.length;
  }

  async function policyChanged(tx: Tx, policyId: string, change: { narrowed: boolean; widened: boolean }): Promise<number> {
    // A widening edit restarts the dry-run nights (when the policy has any): what it approved before is not trusted
    // through them either, so it goes back to a person like a narrowing edit's (Codex P1).
    const [o] = await tx`select dry_run_nights from overnight_policies where id = ${policyId}`;
    const restarts = change.widened && Number(o?.dry_run_nights ?? 0) > 0;
    const n = change.narrowed || restarts ? await unlinkPolicy(tx, policyId, change.narrowed ? "policy changed" : "dry-run nights restarted") : 0;
    if (change.widened) {
      // Tonight already started under the old policy: the rest of it is a dry run, and it does not count.
      const night = nightOf(now(), await tenantTimezone(tx));
      await tx`update overnight_counters set dry_run = true, counted = false, evaluated = true
        where policy_id = ${policyId} and night = ${night}::date
          and exists (select 1 from overnight_policies o where o.id = ${policyId} and o.dry_run_nights > 0)`;
    }
    return n;
  }

  /** The night's counters row; the first evaluation of a night decides whether it is a dry-run night (a row a signal
   * report wrote first is not evaluated yet). */
  async function nightRow(tx: Tx, policy: OvernightPolicy, night: string): Promise<{ dryRun: boolean; budget: number }> {
    const [existing] = await tx`select dry_run, budget_cents, evaluated from overnight_counters
      where policy_id = ${policy.id} and night = ${night}::date for update`;
    if (existing?.evaluated === true) return { dryRun: existing.dry_run as boolean, budget: Number(existing.budget_cents) };
    const budget = existing ? Number(existing.budget_cents) : 0;
    const counts = policy.mode === "preapproved" && policy.state === "active";
    const dryRun = counts && policy.dryRunNightsDone < policy.dryRunNights;
    if (!counts) return { dryRun: false, budget };
    if (existing) {
      await tx`update overnight_counters set dry_run = ${dryRun}, evaluated = true, counted = ${dryRun}
        where policy_id = ${policy.id} and night = ${night}::date`;
    } else {
      await tx`insert into overnight_counters (tenant_id, policy_id, night, dry_run, evaluated, counted)
        values (current_setting('app.tenant_id')::uuid, ${policy.id}, ${night}::date, ${dryRun}, true, ${dryRun})`;
    }
    if (dryRun) await tx`update overnight_policies set dry_run_nights_done = dry_run_nights_done + 1 where id = ${policy.id}`;
    return { dryRun, budget };
  }

  async function evaluateBatch(
    tx: Tx,
    run: ProposeRun,
    policy: OvernightPolicy,
    v: Validated,
  ): Promise<{ evaluation: OvernightEvaluation; allowed: Array<{ key: string; scheduledFor: number }>; trip: string | null }> {
    const t = now();
    const ownerTz = await tenantTimezone(tx);
    const night = nightOf(t, ownerTz);
    // A changed commit connection (re-linked account, new owner) trips the breaker (ADR 0106 §3).
    const fp = `${v.conn.id}:${v.conn.externalRef}:${v.conn.ownership}:${v.conn.kind}`;
    const [pf] = await tx`select connection_fingerprint from overnight_policies where id = ${policy.id}`;
    const prior = (pf?.connection_fingerprint as string | null) ?? null;
    if (prior !== null && prior !== fp && policy.state === "active") {
      return { evaluation: { policyId: policy.id, result: "trip", reason: "connection_auth_change" }, allowed: [], trip: "connection_auth_change" };
    }
    if (prior === null) await tx`update overnight_policies set connection_fingerprint = ${fp} where id = ${policy.id}`;
    const nr = await nightRow(tx, policy, night);
    // The role policy's daily budget caps the night's, whatever the policy says (N1).
    const stored = (await overnightById(tx, policy.id))!;
    const fresh = { ...stored, budgetCentsPerNight: Math.min(stored.budgetCentsPerNight, v.policy.dailyBudgetCents) };
    const [tonight] = await tx`select count(*)::int as n from batch_items i join batches b on b.tenant_id = i.tenant_id and b.hash = i.batch_hash
      where b.overnight_policy_id = ${policy.id} and i.policy_night = ${night}::date and i.state not in ('failed_before_send', 'rejected')`;
    let commits = Number(tonight!.n);
    const perRecipient = new Map<string, number>();
    const killed = await killActive(tx, { personIds: [run.runnerPersonId, ...(run.identity.type === "person" ? [run.identity.id] : [])], workflowId: run.workflowId });
    const threads = new Set((run.threadsStartedByIdentity ?? []).map((x) => normaliseAddress(x) ?? x.toLowerCase()));
    const decisions: Array<{ key: string; d: OvernightDecision }> = [];
    for (const item of v.items) {
      const recipient = recipientOf(item);
      let week = perRecipient.get(recipient);
      if (week === undefined) {
        const [w] = await tx`select count(*)::int as n from batch_items i join batches b on b.tenant_id = i.tenant_id and b.hash = i.batch_hash
          where b.overnight_policy_id = ${policy.id} and i.recipient = ${recipient} and i.policy_allowed_at > ${new Date(t - 7 * 24 * 3600_000)}
            and i.state not in ('failed_before_send', 'rejected') and i.released_at is null`;
        week = Number(w!.n);
      }
      const tz = run.recipientTimezones?.[recipient] ?? run.recipientTimezones?.[item.key] ?? null;
      const d = evaluateOvernight(
        fresh,
        { recipient, recipientTimezone: tz, hasAttachments: hasAttachments(item), templateHash: run.templateHash ?? null, replyToIdentityThread: threads.has(recipient) },
        { dryRunNight: nr.dryRun, commitsTonight: commits, recipientThisWeek: week, budgetCentsTonight: nr.budget, killSwitch: killed },
        { now: t, ownerTimezone: ownerTz },
      );
      decisions.push({ key: item.key, d });
      if (d.result === "allow") {
        commits += 1;
        perRecipient.set(recipient, week + 1);
      } else perRecipient.set(recipient, week);
    }
    const trip = decisions.find((x) => x.d.result === "trip");
    if (trip) return { evaluation: { policyId: policy.id, result: "trip", reason: trip.d.reason }, allowed: [], trip: trip.d.reason };
    const allowed = decisions.flatMap((x) => (x.d.result === "allow" ? [{ key: x.key, scheduledFor: x.d.scheduledFor }] : []));
    const queued = decisions.find((x) => x.d.result === "queue");
    const evaluation: OvernightEvaluation =
      queued === undefined
        ? { policyId: policy.id, result: "allow", reason: null }
        : { policyId: policy.id, result: "queue", reason: allowed.length > 0 ? `partial: ${queued.d.reason}` : queued.d.reason };
    return { evaluation, allowed, trip: null };
  }

  // ---------- propose ----------

  async function proposeBatch(tenantId: string, run: ProposeRun, input: Stage2Item[]): Promise<ProposeResult> {
    if (!isUuid(run.workflowId) || !isUuid(run.jobRoleId) || !isUuid(run.runnerPersonId) || !isUuid(run.connectionId) || !isUuid(run.identity.id)) {
      return reject("validation_failed", "run ids must be uuids");
    }
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(run.runId) || !Number.isInteger(run.version) || run.version < 1) {
      return reject("validation_failed", "run id must be a ULID and version a positive integer");
    }
    let policyToken: string | null = null;
    const result = await service(tenantId, async (tx): Promise<ProposeResult> => {
      const named = input.flatMap((i) => [typeof i?.key === "string" ? i.key : "", ...(Array.isArray(i?.fields) ? i.fields.filter((f) => Array.isArray(f) && f[0] === "to").map((f) => String(f[1])) : [])]);
      const auditReject = async (r0: ProposeResult) => {
        if (r0.ok) return r0;
        // The reason may quote a recipient (brain allowlist messages do): scrubbed for the run and for the log.
        const r = { ...r0, message: scrubFor(r0.message, named) };
        await audit(tx, {
          actor: SERVICE,
          action: "batch.propose_rejected",
          subjectPersonId: run.runnerPersonId,
          resource: { type: "workflow", id: run.workflowId },
          detail: { runId: run.runId, code: r.code, reason: r.message, tripped: r.tripped, item: r.item ?? null },
        });
        return r;
      };
      // The overnight policy this run is under (only one that matches its workflow version and identity).
      let policy: OvernightPolicy | null = null;
      if (run.overnight === true && run.overnightPolicyId && isUuid(run.overnightPolicyId)) {
        const p = await overnightById(tx, run.overnightPolicyId, true);
        // The policy is the runner's own (N1): a person run sends as its runner, and a role-identity run uses only a
        // policy its runner owns, never another person's for the same workflow version.
        if (p && p.workflowId === run.workflowId && p.version === run.version && p.ownerPersonId === run.runnerPersonId) policy = p;
      }
      const checked = await validate(tx, run, input);
      if (!checked.ok) return auditReject(checked.r);
      const v = checked.v;
      // ADR 0105 §7: a recipient outside the run's input set and outside the overnight allowlist.
      if (run.inputRecipients !== undefined) {
        const set = new Set(run.inputRecipients.map((x) => normaliseAddress(x) ?? x.trim().toLowerCase()));
        const threads = new Set((run.threadsStartedByIdentity ?? []).map((x) => normaliseAddress(x) ?? x.toLowerCase()));
        const outside = v.items.find((i) => {
          const r = recipientOf(i);
          return !set.has(r) && !(policy !== null && recipientAllowed(policy, { recipient: r, replyToIdentityThread: threads.has(r) }));
        });
        if (outside) {
          if (policy !== null && policy.state === "active") await tripPolicy(tx, policy.id, "recipient_not_allowed", null, { runId: run.runId });
          return auditReject(reject("recipient_not_allowed", "a proposed recipient is not in the run's input set or the overnight allowlist", policy?.state === "active" ? "recipient_not_allowed" : null));
        }
      }
      const existing = await loadBatch(tx, v.hash, true);
      if (existing) {
        if (existing.runId === run.runId && ["pending", "approved", "sending"].includes(existing.state)) {
          return { ok: true, batchHash: existing.hash, state: existing.state, overnightEvaluation: existing.overnightEval, autoApproved: 0 };
        }
        return auditReject(reject("conflict", "this exact batch was proposed before"));
      }
      await insertBatch(tx, run, v, input, policy?.id ?? null, run.recipientTimezones);
      let evaluation: OvernightEvaluation | null = null;
      let autoApproved = 0;
      if (policy !== null) {
        const e = await evaluateBatch(tx, run, policy, v);
        evaluation = e.evaluation;
        await tx`update batches set overnight_eval = ${evaluation}::jsonb where hash = ${v.hash}`;
        if (e.trip !== null) {
          await tripPolicy(tx, policy.id, e.trip, v.hash, { runId: run.runId });
        } else if (e.allowed.length > 0) {
          const night = nightOf(now(), await tenantTimezone(tx));
          const minted = await mintToken(tx, v.hash, e.allowed.map((a) => a.key), "policy", policy.id, policy.id);
          for (const a of e.allowed) {
            await tx`update batch_items set policy_allowed_at = ${new Date(now())}, policy_night = ${night}::date,
                scheduled_for = ${new Date(Number.isFinite(a.scheduledFor) ? a.scheduledFor : now())}
              where batch_hash = ${v.hash} and key = ${a.key}`;
          }
          policyToken = minted.token;
          autoApproved = e.allowed.length;
          await audit(tx, {
            actor: SERVICE,
            action: "batch.approve",
            subjectPersonId: run.runnerPersonId,
            resource: { type: "batch", id: v.hash },
            detail: { approverKind: "policy", policyId: policy.id, items: autoApproved, templateHash: policy.templateHash },
          });
        }
      }
      const state = await recompute(tx, v.hash);
      await audit(tx, {
        actor: SERVICE,
        action: "batch.propose",
        subjectPersonId: run.runnerPersonId,
        resource: { type: "batch", id: v.hash },
        detail: { runId: run.runId, workflowId: run.workflowId, items: v.items.length, overnight: evaluation },
      });
      return { ok: true, batchHash: v.hash, state, overnightEvaluation: evaluation, autoApproved };
    });
    if (result.ok && policyToken !== null) dispatch(tenantId, result.batchHash, policyToken);
    return result;
  }

  // ---------- approve / reject / release ----------

  async function approve(tx: Tx, p: Principal, hash: string, req: ApprovalRequest) {
    if (req.batchHash !== hash) throw new HttpError(409, "hash_mismatch", "the body names a different batch");
    let b = await loadBatch(tx, hash, true);
    if (!b) throw notFound();
    await mustApprove(tx, p, b);
    if (await batchKilled(tx, b)) throw new HttpError(409, "kill_switch_active", "a kill switch stops this batch");
    b.state = await recompute(tx, hash);
    if (b.state === "rejected") throw conflict(b.rejectedReason === "edited" ? "this batch was edited: approve the new one" : "this batch was rejected");
    if (b.state === "expired") throw conflict("this batch expired");
    let rows = await itemsOf(tx, hash);
    if (!intact(b, rows)) throw new HttpError(409, "hash_mismatch", "the batch changed after it was proposed");
    let edited = false;
    if (req.edits.length > 0) {
      if (rows.some((r) => r.state !== "pending" || r.tokenId !== null)) throw conflict("only a batch with nothing approved or sent can be edited");
      const byKey = new Map(rows.map((r) => [r.key, r]));
      const edits = new Map<string, Field[]>();
      for (const e of req.edits) {
        if (!byKey.has(e.key) || edits.has(e.key)) throw invalid(`no item ${e.key} to edit`);
        edits.set(e.key, e.fields);
      }
      const input: Stage2Item[] = rows.map((r) => {
        const f = edits.get(r.key);
        if (f === undefined) return { key: r.key, capability: r.capability, fields: r.fields };
        const to = f.find(([l]) => l === "to")?.[1];
        return { key: (to ?? "").toLowerCase(), capability: r.capability, fields: f };
      });
      const run: ProposeRun = {
        runId: b.runId,
        workflowId: b.workflowId,
        version: b.version,
        jobRoleId: b.jobRoleId,
        runtime: b.runtime,
        identity: { type: b.identityType, id: b.identityId },
        runnerPersonId: b.runnerPersonId,
        connectionId: b.connectionId,
        ...(b.crmSheet ? { crmSheet: b.crmSheet } : {}),
      };
      const checked = await validate(tx, run, input);
      if (!checked.ok) {
        const r = checked.r as Extract<ProposeResult, { ok: false }>;
        throw new HttpError(r.code === "validation_failed" ? 400 : r.code === "forbidden" ? 403 : 409, r.code, r.message);
      }
      if (checked.v.hash !== hash) {
        if (await loadBatch(tx, checked.v.hash)) throw conflict("an identical batch already exists");
        const tzs = Object.fromEntries(rows.filter((r) => r.recipientTz !== null).map((r) => [r.recipient, r.recipientTz!]));
        await insertBatch(tx, run, checked.v, input, b.overnightPolicyId, tzs);
        await tx`update batches set state = 'rejected', rejected_reason = 'edited', replaced_by = ${checked.v.hash}, updated_at = ${new Date(now())}
          where hash = ${hash}`;
        await tx`update batch_items set state = 'rejected', updated_at = ${new Date(now())} where batch_hash = ${hash} and state = 'pending'`;
        await audit(tx, {
          actor: actorOf(p),
          action: "batch.edit",
          subjectPersonId: b.runnerPersonId,
          resource: { type: "batch", id: hash },
          detail: { newBatchHash: checked.v.hash, editedItems: edits.size },
        });
        const oldToNew = new Map(req.edits.map((e) => [e.key, (e.fields.find(([l]) => l === "to")?.[1] ?? "").toLowerCase()]));
        if (req.itemKeys !== null) req = { ...req, itemKeys: req.itemKeys.map((k) => oldToNew.get(k) ?? k) };
        b = (await loadBatch(tx, checked.v.hash, true))!;
        hash = b.hash;
        rows = await itemsOf(tx, hash);
        edited = true;
      }
    }
    const open = rows.filter((r) => r.state === "pending" && r.tokenId === null);
    let keys: string[];
    if (req.itemKeys === null) keys = open.map((r) => r.key);
    else {
      const known = new Map(rows.map((r) => [r.key, r]));
      for (const k of req.itemKeys) {
        const r = known.get(k);
        if (!r) throw invalid(`no item ${k} in this batch`);
        if (r.state !== "pending" || r.tokenId !== null) throw new HttpError(409, "token_used", `${k} is already approved or done`);
      }
      keys = [...new Set(req.itemKeys)];
    }
    if (keys.length === 0) throw new HttpError(409, "token_used", "this batch was already approved");
    const minted = await mintToken(tx, hash, keys, "person", p.personId, null);
    const state = await recompute(tx, hash);
    await audit(tx, {
      actor: actorOf(p),
      action: "batch.approve",
      subjectPersonId: b.runnerPersonId,
      resource: { type: "batch", id: hash },
      detail: { approverKind: "person", items: keys.length, edited },
    });
    const response: ApprovalResponse = {
      batchHash: hash,
      state: state === "sending" ? "sending" : "approved",
      approverKind: "person",
      approvedBy: p.personId,
      tokenExpiresAt: minted.expiresAt,
    };
    return { response, token: minted.token };
  }

  async function rejectBatch(tx: Tx, p: Principal, hash: string, reason0: string): Promise<BatchDto> {
    const b = await loadBatch(tx, hash, true);
    if (!b) throw notFound();
    await mustApprove(tx, p, b);
    const reason = scrubFor(reason0, (await itemsOf(tx, hash)).flatMap((r) => [r.key, r.recipient]));
    if (b.state === "rejected" || b.state === "expired" || b.state === "done") throw conflict(`this batch is ${b.state}`);
    await revokeBatch(tx, hash, "rejected");
    await tx`update batch_items set state = 'rejected', updated_at = ${new Date(now())} where batch_hash = ${hash} and state = 'pending'`;
    const [c] = await tx`select count(*) filter (where state <> 'rejected')::int as n from batch_items where batch_hash = ${hash}`;
    if (Number(c!.n) === 0) {
      await tx`update batches set state = 'rejected', rejected_reason = ${reason.slice(0, 200)}, updated_at = ${new Date(now())} where hash = ${hash}`;
    } else await recompute(tx, hash);
    await audit(tx, {
      actor: actorOf(p),
      action: "batch.reject",
      subjectPersonId: b.runnerPersonId,
      resource: { type: "batch", id: hash },
      detail: { reason: reason.slice(0, 200) },
    });
    return dto(tx, (await loadBatch(tx, hash))!, true);
  }

  async function release(tx: Tx, p: Principal, hash: string, keys: string[]): Promise<BatchDto> {
    const b = await loadBatch(tx, hash, true);
    if (!b) throw notFound();
    await mustApprove(tx, p, b);
    const rows = new Map((await itemsOf(tx, hash)).map((r) => [r.key, r]));
    const t = new Date(now());
    for (const k of new Set(keys)) {
      const r = rows.get(k);
      if (!r) throw invalid(`no item ${k} in this batch`);
      if (r.state !== "unknown") throw conflict(`${k} is ${r.state}: only unknown items are released`);
      const u = await tx`update batch_items set released_at = ${t}, released_by = ${p.personId}, updated_at = ${t}
        where batch_hash = ${hash} and key = ${k} and released_at is null`;
      if (u.count === 0) throw conflict(`${k} was already released`);
      await tx`update contacted_ledger set released_at = ${t} where batch_hash = ${hash} and item_key = ${k}`;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "batch.release",
      subjectPersonId: b.runnerPersonId,
      resource: { type: "batch", id: hash },
      detail: { items: new Set(keys).size },
    });
    return dto(tx, b, true);
  }

  // ---------- commit ----------

  async function commitApproved(tenantId: string, hash: string, token: string): Promise<CommitSummary> {
    const scheduled = await service(tenantId, async (tx): Promise<number | HttpError> => {
      const [tk] = await tx`select * from approval_tokens where token_hash = ${sha256Hex(token)} for update`;
      if (!tk) throw forbidden("not an approval token");
      if (tk.batch_hash !== hash) throw new HttpError(409, "hash_mismatch", "this approval is for a different batch");
      if (tk.used_at !== null) throw new HttpError(409, "token_used", "this approval was already used");
      if (tk.revoked_at !== null) throw new HttpError(409, "token_used", "this approval was revoked");
      const b = await loadBatch(tx, hash, true);
      if (!b) throw notFound();
      if (msNN(tk.expires_at as Date) <= now()) {
        await recompute(tx, hash);
        return conflict("this approval expired");
      }
      if (b.state === "rejected" || b.state === "expired") throw conflict(`this batch is ${b.state}`);
      const rows = await itemsOf(tx, hash);
      if (!intact(b, rows)) {
        await revokeBatch(tx, hash, "tampered");
        await audit(tx, { actor: SERVICE, action: "batch.tamper_detected", subjectPersonId: b.runnerPersonId, resource: { type: "batch", id: hash }, detail: {} });
        return new HttpError(409, "hash_mismatch", "the batch changed after it was approved");
      }
      if (await batchKilled(tx, b)) {
        await revokeBatch(tx, hash, "kill switch");
        return new HttpError(409, "kill_switch_active", "a kill switch stops this batch");
      }
      await tx`update approval_tokens set used_at = ${new Date(now())} where id = ${tk.id}`;
      const mine = rows.filter((r) => r.tokenId === tk.id && r.state === "pending");
      const policy = b.overnightPolicyId ? await overnightById(tx, b.overnightPolicyId) : null;
      const ownerTz = await tenantTimezone(tx);
      for (const r of mine) {
        let at = r.scheduledFor ?? now();
        if (policy !== null) at = Math.max(at, nextWindowStart(policy.sendWindow, windowTimezone(policy.sendWindow, r.recipientTz, ownerTz), now()));
        if (!Number.isFinite(at)) at = now();
        await tx`update batch_items set scheduled_for = ${new Date(at)}, updated_at = ${new Date(now())} where batch_hash = ${hash} and key = ${r.key}`;
      }
      await recompute(tx, hash);
      await audit(tx, {
        actor: SERVICE,
        action: "batch.commit_started",
        subjectPersonId: b.runnerPersonId,
        resource: { type: "batch", id: hash },
        detail: { items: mine.length, approverKind: tk.approver_kind, policyId: tk.policy_id ?? null },
      });
      return mine.length;
    });
    // Revocations above are committed before the refusal is raised.
    if (scheduled instanceof HttpError) throw scheduled;
    const s = await runDue(tenantId, hash);
    return { ...s, scheduled };
  }

  async function runDue(tenantId: string, hash?: string): Promise<CommitSummary> {
    const summary: CommitSummary = { batchHash: hash ?? "", scheduled: 0, sent: 0, unknown: 0, failedBeforeSend: 0, waiting: 0 };
    const due = await service(tenantId, async (tx) =>
      tx`select i.batch_hash, i.key from batch_items i join approval_tokens t on t.tenant_id = i.tenant_id and t.id = i.token_id
        where i.state = 'pending' and t.used_at is not null and t.revoked_at is null
          and (${hash ?? null}::text is null or i.batch_hash = ${hash ?? null})
        order by i.batch_hash, i.position`,
    );
    for (const d of due) {
      const r = await executeItem(tenantId, d.batch_hash as string, d.key as string);
      if (r === "sent") summary.sent++;
      else if (r === "unknown") summary.unknown++;
      else if (r === "failed_before_send") summary.failedBeforeSend++;
      else summary.waiting++;
    }
    return summary;
  }

  /** Does the job role's current policy still allow the capability and, for a person's approval, name its approver? */
  async function roleStillAllows(tx: Tx, b: BatchRow, capability: string, approvedBy: string | null): Promise<boolean> {
    const rp = await rolePolicyOf(tx, b.jobRoleId);
    if (!rp || !rp.allowedCapabilities.includes(capability)) return false;
    if (approvedBy === null) return true;
    if (approvedBy === b.runnerPersonId && (rp.approvers === "runner" || rp.approvers === "runner_or_dept_lead")) return true;
    if (rp.approvers === "runner") return false;
    const [lead] = await tx`select 1 from people where id = ${approvedBy} and access_role = 'dept_lead'
      and dept_lead_of @> ${[b.departmentId]}::jsonb and state in ('active', 'leaving')`;
    return lead !== undefined;
  }

  /** One item through the gate and the journal. Returns what became of it. */
  async function executeItem(tenantId: string, hash: string, key: string): Promise<"sent" | "unknown" | "failed_before_send" | "waiting"> {
    let named: string[] = [key];
    const failBefore = async (tx: Tx, b: BatchRow, code: string, reason0: string, tool: string | null = null) => {
      const reason = scrubFor(reason0, named);
      await tx`update batch_items set state = 'failed_before_send', error = ${reason.slice(0, 500)}, tool = ${tool}, updated_at = ${new Date(now())}
        where batch_hash = ${hash} and key = ${key} and state = 'pending'`;
      await recompute(tx, hash);
      await audit(tx, { actor: SERVICE, action: "batch.item_denied", subjectPersonId: b.runnerPersonId, resource: { type: "batch", id: hash }, detail: { item: itemRef(b.workflowId, key), code, reason: reason.slice(0, 200) } });
      return "failed_before_send" as const;
    };
    type Prepared =
      | { done: "failed_before_send" | "waiting" }
      | { call: CommitCall; executor: Executor; target: CommitTarget; policy: ToolPolicy; b: BatchRow; policyId: string | null; recipient: string };
    const prepared = await service(tenantId, async (tx): Promise<Prepared> => {
      const b = await loadBatch(tx, hash, true);
      if (!b) return { done: "waiting" as const };
      const [raw] = await tx`select * from batch_items where batch_hash = ${hash} and key = ${key} for update`;
      if (!raw) return { done: "waiting" as const };
      const row = itemRow(raw);
      named = [key, row.recipient];
      if (row.state !== "pending" || row.tokenId === null) return { done: "waiting" as const };
      const [tk] = await tx`select used_at, revoked_at, approver_kind, approved_by, policy_id, binding_hash from approval_tokens where id = ${row.tokenId}`;
      if (!tk || tk.used_at === null || tk.revoked_at !== null) return { done: "waiting" as const };
      // A policy approval holds only while its policy is active (ADR 0112 §1): paused, tripped or gone fails closed and
      // the policy's unsent items go back to a person.
      if (tk.policy_id !== null) {
        const pol = await overnightById(tx, tk.policy_id as string);
        if (pol?.state !== "active") {
          await unlinkPolicy(tx, tk.policy_id as string, `policy ${pol?.state ?? "gone"}`);
          return { done: "waiting" as const };
        }
        // Nothing a policy approved goes out while it is in its dry-run nights, or on a night (tonight's or the one it
        // was approved on) that is a dry run: the evaluator's decision is not the only guard (Codex P1).
        const night = nightOf(now(), await tenantTimezone(tx));
        const [dry] = await tx`select 1 from overnight_counters c where c.policy_id = ${pol.id} and c.dry_run
          and (c.night = ${night}::date or c.night = (select i.policy_night from batch_items i where i.batch_hash = ${hash} and i.key = ${key}))
          limit 1`;
        if (pol.dryRunNightsDone < pol.dryRunNights || dry) {
          await unlinkPolicy(tx, pol.id, "dry-run night");
          return { done: "waiting" as const };
        }
      }
      if (row.scheduledFor !== null && row.scheduledFor > now()) return { done: "waiting" as const };
      if (await batchKilled(tx, b)) {
        await revokeBatch(tx, hash, "kill switch");
        return { done: "waiting" as const };
      }
      const rows = await itemsOf(tx, hash);
      if (!intact(b, rows)) {
        await revokeBatch(tx, hash, "tampered");
        await audit(tx, { actor: SERVICE, action: "batch.tamper_detected", subjectPersonId: b.runnerPersonId, resource: { type: "batch", id: hash }, detail: {} });
        return { done: "waiting" as const };
      }
      // The role policy as it is now (N4): a capability taken away, or an approver no longer named, takes the approval back.
      if (!(await roleStillAllows(tx, b, row.capability, tk.approver_kind === "person" ? (tk.approved_by as string) : null))) {
        await revokeBatch(tx, hash, "role policy changed");
        return { done: "waiting" as const };
      }
      // Send window: never outside it; a late item is moved to the next opening.
      if (b.overnightPolicyId !== null) {
        const pol = await overnightById(tx, b.overnightPolicyId);
        if (pol) {
          const tz = windowTimezone(pol.sendWindow, row.recipientTz, await tenantTimezone(tx));
          if (!inWindow(pol.sendWindow, tz, now())) {
            const next = nextWindowStart(pol.sendWindow, tz, now());
            await tx`update batch_items set scheduled_for = ${new Date(Number.isFinite(next) ? next : now() + 24 * 3600_000)}
              where batch_hash = ${hash} and key = ${key}`;
            return { done: "waiting" as const };
          }
        }
      }
      // Stage 1: an unreleased `sending` or `unknown` to this recipient in another batch of the workflow holds this
      // one, whenever it was approved (the propose-time check cannot see a batch that went unknown later). The lock
      // makes the check and the journal below one step per (workflow, recipient).
      await tx`select pg_advisory_xact_lock(hashtextextended(${`s207:${b.workflowId}:${row.recipient}`}, 0))`;
      const [held] = await tx`select 1 from contacted_ledger where workflow_id = ${b.workflowId} and recipient = ${row.recipient}
        and outcome in ('sending', 'unknown') and released_at is null and batch_hash <> ${hash} limit 1`;
      if (held) return { done: "waiting" as const };
      const item = stage1Items([row])![0]!;
      const conn = await connectionOf(tx, b.connectionId);
      if (!conn) return { done: await failBefore(tx, b, "connection_gone", "the connection is gone") };
      // The approval was for this account, identity and runner (N2): anything re-linked or re-pointed since needs a new one.
      if (tk.binding_hash !== bindingHash(b, conn)) {
        await revokeBatch(tx, hash, "binding changed");
        await audit(tx, { actor: SERVICE, action: "batch.binding_changed", subjectPersonId: b.runnerPersonId, resource: { type: "batch", id: hash }, detail: { item: itemRef(b.workflowId, key) } });
        return { done: "waiting" as const };
      }
      const refusal = bindingRefusal(conn);
      if (refusal) return { done: await failBefore(tx, b, "binding_refused", refusal) };
      const method = methodOf(conn.provider)! as Method;
      const executor = executors[method];
      if (!executor) return { done: await failBefore(tx, b, "no_executor", `no ${method} executor is configured`) };
      const ctx = { batchHash: hash, ...(b.crmSheet ? { crmSheet: b.crmSheet } : {}) };
      const pr = policyForItem(row.capability, item, { kind: conn.kind, method }, ctx);
      if ("reason" in pr) return { done: await failBefore(tx, b, "no_allowlisted_tool", pr.reason) };
      const call = executor.build(pr.policy, item, ctx);
      if (call === null) return { done: await failBefore(tx, b, "not_expressible", "the executor cannot express this item", pr.policy.tool) };
      if (call.tool !== pr.policy.tool) return { done: await failBefore(tx, b, "wrong_tool", `${call.tool} is not the approved tool`, call.tool) };
      const gate = checkCall(pr.policy, item, call.args, ctx);
      if (!gate.ok) return { done: await failBefore(tx, b, "arguments_differ", gate.reason, call.tool) };
      // Journal before the call: sending + the contacted ledger, committed with this transaction.
      const u = await tx`update batch_items set state = 'sending', tool = ${call.tool}, updated_at = ${new Date(now())}
        where batch_hash = ${hash} and key = ${key} and state = 'pending' returning key`;
      if (u.length === 0) return { done: "waiting" as const };
      await tx`insert into contacted_ledger (tenant_id, workflow_id, batch_hash, item_key, recipient, policy_id, at, outcome)
        values (current_setting('app.tenant_id')::uuid, ${b.workflowId}, ${hash}, ${key}, ${row.recipient}, ${tk.policy_id ?? null},
          ${new Date(now())}, 'sending')`;
      await recompute(tx, hash);
      const target: CommitTarget = { connectionId: conn.id, kind: conn.kind, externalRef: conn.externalRef };
      return { call, executor, target, policy: pr.policy as ToolPolicy, b, policyId: (tk.policy_id as string | null) ?? null, recipient: row.recipient };
    });
    if ("done" in prepared) return prepared.done;
    let ok = false;
    let error: string | null = null;
    try {
      const r = await prepared.executor.call(prepared.call, prepared.target);
      ok = r.ok;
      error = r.ok ? null : (r.error ?? "the call did not succeed");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // A provider's error text may quote the recipient: the journal keeps it without the address or its domain.
    if (error !== null) error = scrubFor(error, [key, prepared.recipient]);
    const state = ok ? "sent" : "unknown";
    await service(tenantId, async (tx) => {
      const t = new Date(now());
      await tx`update batch_items set state = ${state}, error = ${error === null ? null : error.slice(0, 500)},
          sent_at = ${ok ? t : null}, updated_at = ${t}
        where batch_hash = ${hash} and key = ${key} and state = 'sending'`;
      await tx`update contacted_ledger set outcome = ${state} where batch_hash = ${hash} and item_key = ${key}`;
      if (ok && prepared.policyId !== null) {
        const night = nightOf(now(), await tenantTimezone(tx));
        await tx`update overnight_counters set sends = sends + 1 where policy_id = ${prepared.policyId} and night = ${night}::date`;
      }
      await recompute(tx, hash);
      await audit(tx, {
        actor: SERVICE,
        action: ok ? "batch.item_sent" : "batch.item_unknown",
        subjectPersonId: prepared.b.runnerPersonId,
        resource: { type: "batch", id: hash },
        detail: { item: itemRef(prepared.b.workflowId, key), tool: prepared.call.tool },
      });
    });
    return state;
  }

  async function reconcile(tenantId: string, staleMs = SENDING_STALE_MS): Promise<number> {
    return service(tenantId, async (tx) => {
      const t = new Date(now());
      const rows = await tx`update batch_items set state = 'unknown', error = 'no result: the broker stopped during the call', updated_at = ${t}
        where state = 'sending' and updated_at <= ${new Date(now() - staleMs)} returning batch_hash, key`;
      for (const r of rows) {
        await tx`update contacted_ledger set outcome = 'unknown' where batch_hash = ${r.batch_hash} and item_key = ${r.key}`;
        await recompute(tx, r.batch_hash as string);
      }
      return rows.length;
    });
  }

  function dispatch(tenantId: string, hash: string, token: string): void {
    const p = commitApproved(tenantId, hash, token)
      .catch((err) => {
        // The approval stays recorded; the reason is in the audit log or the item journal.
        if (!(err instanceof HttpError)) console.error("broker: commit failed:", err instanceof Error ? err.message : err);
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  // ---------- revocation ----------

  async function revokeTokensFor(tx: Tx, personId: string): Promise<number> {
    const hashes = await tx`select distinct t.batch_hash from approval_tokens t join batches b on b.tenant_id = t.tenant_id and b.hash = t.batch_hash
      where (t.approved_by = ${personId} or b.runner_person_id = ${personId} or (b.identity_type = 'person' and b.identity_id = ${personId}))
        and t.revoked_at is null and (t.used_at is null or exists (select 1 from batch_items i
          where i.tenant_id = t.tenant_id and i.batch_hash = t.batch_hash and i.state = 'pending' and i.token_id = t.id))`;
    let n = 0;
    for (const h of hashes) n += await revokeBatch(tx, h.batch_hash as string, "person");
    if (hashes.length > 0) {
      await audit(tx, { actor: SERVICE, action: "token.revoke", subjectPersonId: personId, resource: { type: "person", id: personId }, detail: { tokens: n, batches: hashes.length } });
    }
    return n;
  }

  async function revokeForKill(tx: Tx, scope: "tenant" | "person" | "workflow", targetId: string | null, reason: string): Promise<number> {
    const hashes =
      scope === "tenant"
        ? await tx`select hash from batches where state in ('pending', 'approved', 'sending')`
        : scope === "person"
          ? await tx`select hash from batches where state in ('pending', 'approved', 'sending')
              and (runner_person_id = ${targetId} or (identity_type = 'person' and identity_id = ${targetId}))`
          : await tx`select hash from batches where state in ('pending', 'approved', 'sending') and workflow_id = ${targetId}`;
    let n = 0;
    for (const h of hashes) n += await revokeBatch(tx, h.hash as string, reason);
    return n;
  }

  // ---------- breaker signals ----------

  async function reportNightSignals(tenantId: string, policyId: string, s: { sends?: number; bounces?: number; negativeReplies?: number; costCents?: number }) {
    return service(tenantId, async (tx) => {
      const policy = await overnightById(tx, policyId, true);
      if (!policy) throw notFound();
      const night = nightOf(now(), await tenantTimezone(tx));
      // Not evaluated: the night's first batch still decides whether this is a dry-run night.
      await tx`insert into overnight_counters (tenant_id, policy_id, night, dry_run, evaluated)
        values (current_setting('app.tenant_id')::uuid, ${policyId}, ${night}::date, false, false) on conflict do nothing`;
      const [c] = await tx`update overnight_counters set sends = sends + ${s.sends ?? 0}, bounces = bounces + ${s.bounces ?? 0},
          negative_replies = negative_replies + ${s.negativeReplies ?? 0}, budget_cents = budget_cents + ${s.costCents ?? 0}
        where policy_id = ${policyId} and night = ${night}::date returning sends, bounces, negative_replies`;
      const sends = Number(c!.sends);
      const bounces = Number(c!.bounces);
      let reason: string | null = null;
      if (sends > 0 && (bounces * 100) / sends > policy.circuitBreakers.bounceRatePct) reason = "bounce_rate";
      else if (Number(c!.negative_replies) >= policy.circuitBreakers.negativeReplySpike) reason = "negative_reply_spike";
      if (reason !== null && policy.state === "active") {
        await tripPolicy(tx, policyId, reason, null, { night, sends, bounces, negativeReplies: Number(c!.negative_replies) });
        return reason;
      }
      return null;
    });
  }

  async function reportRunResult(tenantId: string, policyId: string, ok: boolean) {
    return service(tenantId, async (tx) => {
      const [p] = ok
        ? await tx`update overnight_policies set consecutive_failures = 0 where id = ${policyId} returning consecutive_failures, state, circuit_breakers`
        : await tx`update overnight_policies set consecutive_failures = consecutive_failures + 1 where id = ${policyId}
            returning consecutive_failures, state, circuit_breakers`;
      if (!p) throw notFound();
      const limit = (p.circuit_breakers as OvernightPolicy["circuitBreakers"]).consecutiveFailures;
      if (!ok && Number(p.consecutive_failures) >= limit && p.state === "active") {
        await tripPolicy(tx, policyId, "consecutive_failures", null, { failures: Number(p.consecutive_failures) });
        return "consecutive_failures";
      }
      return null;
    });
  }

  return {
    isFullBroker: true,
    configure(o) {
      if (o.executors) executors = { ...o.executors };
    },
    // A question that names neither a person nor a workflow cannot be answered "go": it fails closed, like the core
    // default. Callers name what they are about to run; `tenantKilled` asks about the tenant switch alone.
    killSwitchActive: async (tx, target) =>
      target.personId === undefined && target.workflowId === undefined
        ? true
        : killActive(tx, { ...(target.personId ? { personIds: [target.personId] } : {}), ...(target.workflowId ? { workflowId: target.workflowId } : {}) }),
    tenantKilled: (tx) => killActive(tx, {}),
    revokeTokensOf: revokeTokensFor,
    revokeTokensFor,
    async stopRunsFor(tx, personId) {
      const tokens = await revokeTokensFor(tx, personId);
      const pol = await tx`update overnight_policies set state = 'paused', updated_at = ${new Date(now())}
        where owner_person_id = ${personId} and state = 'active'`;
      const workers = await deps.ports.workers.pauseFor(tx, personId);
      return { tokens, policies: pol.count, workers };
    },
    revokeForKill,
    proposeBatch,
    approve,
    reject: rejectBatch,
    release,
    commitApproved,
    runDue,
    reconcile,
    reportNightSignals,
    reportRunResult,
    policyChanged,
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    dispatch,
    visibility,
    loadBatch,
    dto,
  };
}
