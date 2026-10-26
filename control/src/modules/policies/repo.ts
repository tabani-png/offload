/** Role policies and overnight policies: rows ↔ DTOs (schemas/stage2/role-policy, overnight-policy). */
import type { Tx } from "../../db/pool.ts";
import { msNN } from "../../db/pool.ts";
import type { OvernightPolicy } from "./evaluate.ts";

export interface RolePolicy {
  jobRoleId: string;
  allowedCapabilities: string[];
  approvers: "runner" | "dept_lead" | "runner_or_dept_lead";
  sessionBudgetCents: number;
  dailyBudgetCents: number;
  maxItemsPerBatch: number;
  models: { design: "claude-opus-5-5" | "claude-sonnet-5-5"; steps: "claude-opus-5-5" | "claude-sonnet-5-5" };
  updatedAt: number;
  updatedBy: string;
}

export const ROLE_POLICY = "offload/stage2/role-policy.schema.json";
export const OVERNIGHT_POLICY = "offload/stage2/overnight-policy.schema.json";

type Row = Record<string, unknown>;

export function rolePolicyDto(r: Row): RolePolicy {
  return {
    jobRoleId: r.job_role_id as string,
    allowedCapabilities: r.allowed_capabilities as string[],
    approvers: r.approvers as RolePolicy["approvers"],
    sessionBudgetCents: Number(r.session_budget_cents),
    dailyBudgetCents: Number(r.daily_budget_cents),
    maxItemsPerBatch: Number(r.max_items_per_batch),
    models: { design: r.model_design as RolePolicy["models"]["design"], steps: r.model_steps as RolePolicy["models"]["steps"] },
    updatedAt: msNN(r.updated_at as Date),
    updatedBy: r.updated_by as string,
  };
}

export async function rolePolicyOf(tx: Tx, jobRoleId: string): Promise<RolePolicy | null> {
  const [r] = await tx`select * from role_policies where job_role_id = ${jobRoleId}`;
  return r ? rolePolicyDto(r) : null;
}

export async function putRolePolicy(tx: Tx, p: RolePolicy): Promise<RolePolicy> {
  const [r] = await tx`insert into role_policies (tenant_id, job_role_id, allowed_capabilities, approvers, session_budget_cents,
      daily_budget_cents, max_items_per_batch, model_design, model_steps, updated_at, updated_by)
    values (current_setting('app.tenant_id')::uuid, ${p.jobRoleId}, ${p.allowedCapabilities}::jsonb, ${p.approvers},
      ${p.sessionBudgetCents}, ${p.dailyBudgetCents}, ${p.maxItemsPerBatch}, ${p.models.design}, ${p.models.steps},
      ${new Date(p.updatedAt)}, ${p.updatedBy})
    on conflict (tenant_id, job_role_id) do update set allowed_capabilities = excluded.allowed_capabilities,
      approvers = excluded.approvers, session_budget_cents = excluded.session_budget_cents,
      daily_budget_cents = excluded.daily_budget_cents, max_items_per_batch = excluded.max_items_per_batch,
      model_design = excluded.model_design, model_steps = excluded.model_steps, updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
    returning *`;
  return rolePolicyDto(r!);
}

export function overnightDto(r: Row): OvernightPolicy {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    version: Number(r.version),
    mode: r.mode as OvernightPolicy["mode"],
    recipients: r.recipients as OvernightPolicy["recipients"],
    templateHash: (r.template_hash as string | null) ?? null,
    maxCommitsPerNight: Number(r.max_commits_per_night),
    maxPerRecipientPerWeek: Number(r.max_per_recipient_per_week),
    sendWindow: r.send_window as OvernightPolicy["sendWindow"],
    attachmentsAllowed: r.attachments_allowed as boolean,
    budgetCentsPerNight: Number(r.budget_cents_per_night),
    dryRunNights: Number(r.dry_run_nights),
    dryRunNightsDone: Number(r.dry_run_nights_done),
    circuitBreakers: r.circuit_breakers as OvernightPolicy["circuitBreakers"],
    state: r.state as OvernightPolicy["state"],
    trippedReason: (r.tripped_reason as string | null) ?? null,
    ownerPersonId: r.owner_person_id as string,
  };
}

/** `lock` takes the policy row FOR NO KEY UPDATE (broker.ts lock order, step 2): exclusive against other writers, never
 * against the FK KEY SHARE an insert referencing the policy takes. */
export async function overnightById(tx: Tx, id: string, lock = false): Promise<OvernightPolicy | null> {
  const [r] = lock
    ? await tx`select * from overnight_policies where id = ${id} for no key update`
    : await tx`select * from overnight_policies where id = ${id}`;
  return r ? overnightDto(r) : null;
}

export async function insertOvernight(tx: Tx, p: OvernightPolicy, now: number): Promise<OvernightPolicy> {
  const [r] = await tx`insert into overnight_policies (tenant_id, id, workflow_id, version, mode, recipients, template_hash,
      max_commits_per_night, max_per_recipient_per_week, send_window, attachments_allowed, budget_cents_per_night,
      dry_run_nights, dry_run_nights_done, circuit_breakers, state, tripped_reason, owner_person_id, created_at, updated_at)
    values (current_setting('app.tenant_id')::uuid, ${p.id}, ${p.workflowId}, ${p.version}, ${p.mode},
      ${p.recipients}::jsonb, ${p.templateHash}, ${p.maxCommitsPerNight}, ${p.maxPerRecipientPerWeek},
      ${p.sendWindow}::jsonb, ${p.attachmentsAllowed}, ${p.budgetCentsPerNight}, ${p.dryRunNights},
      ${p.dryRunNightsDone}, ${p.circuitBreakers}::jsonb, ${p.state}, ${p.trippedReason},
      ${p.ownerPersonId}, ${new Date(now)}, ${new Date(now)})
    returning *`;
  return overnightDto(r!);
}

export async function updateOvernight(tx: Tx, p: OvernightPolicy, now: number, resetFailures = false): Promise<OvernightPolicy> {
  const [r] = await tx`update overnight_policies set mode = ${p.mode}, recipients = ${p.recipients}::jsonb,
      template_hash = ${p.templateHash}, max_commits_per_night = ${p.maxCommitsPerNight},
      max_per_recipient_per_week = ${p.maxPerRecipientPerWeek}, send_window = ${p.sendWindow}::jsonb,
      attachments_allowed = ${p.attachmentsAllowed}, budget_cents_per_night = ${p.budgetCentsPerNight},
      dry_run_nights = ${p.dryRunNights}, dry_run_nights_done = ${p.dryRunNightsDone},
      circuit_breakers = ${p.circuitBreakers}::jsonb, state = ${p.state}, tripped_reason = ${p.trippedReason},
      consecutive_failures = case when ${resetFailures} then 0 else consecutive_failures end,
      updated_at = ${new Date(now)}
    where id = ${p.id} returning *`;
  return overnightDto(r!);
}
