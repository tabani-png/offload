/** Rows of migrations/0900_workers.sql ↔ the worker and worker-run DTOs (schemas/stage2/worker, worker-run). */
import type { Tx } from "../../db/pool.ts";
import { ms, msNN } from "../../db/pool.ts";
import { nextRun } from "./cron.ts";
import type { McpServer } from "./tools.ts";

type Row = Record<string, unknown>;

export type WorkerState = "provisioning" | "ready" | "paused" | "failed" | "retired";
export type RunState = "running" | "waiting_approval" | "idle" | "done" | "failed" | "capped" | "interrupted";
export type StopReason = "end_turn" | "requires_action" | "budget_reached" | "error";

export interface WorkerRow {
  id: string;
  workflowId: string;
  version: number;
  jobRoleId: string;
  departmentId: string;
  identityType: "person" | "role_identity";
  identityId: string;
  ownerPersonId: string;
  commitConnectionId: string | null;
  state: WorkerState;
  sessionBudgetCents: number;
  agentId: string | null;
  agentVersion: number | null;
  environmentId: string | null;
  vaultId: string | null;
  mcpServers: Record<string, McpServer>;
  templateHash: string;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: number;
}

export interface DeploymentRow {
  workerId: string;
  cron: string;
  timezone: string;
  deploymentId: string | null;
  desired: "active" | "paused" | "archived";
  remote: "none" | "active" | "paused" | "archived";
  stale: string[];
  lastRunSeenAt: string | null;
  /** A remote create was started with this key and its answer not recorded (migration 0902). */
  createKey: string | null;
  createAlertedAt: number | null;
}

export interface RunRow {
  id: string;
  workerId: string;
  trigger: "manual" | "schedule";
  runnerPersonId: string;
  inputRecipients: string[] | null;
  overnight: boolean;
  overnightPolicyId: string | null;
  startedAt: number;
  endedAt: number | null;
  state: RunState;
  stopReason: StopReason | null;
  errorCode: string | null;
  costCents: number;
  budgetCents: number;
  summary: string | null;
  questions: string[];
  sessionRef: string;
  deploymentRunRef: string | null;
  interruptSentAt: number | null;
  outcomeSeq: number;
}

export function workerRow(r: Row): WorkerRow {
  return {
    id: r.id as string,
    workflowId: r.workflow_id as string,
    version: Number(r.version),
    jobRoleId: r.job_role_id as string,
    departmentId: r.department_id as string,
    identityType: r.identity_type as WorkerRow["identityType"],
    identityId: r.identity_id as string,
    ownerPersonId: r.owner_person_id as string,
    commitConnectionId: (r.commit_connection_id as string | null) ?? null,
    state: r.state as WorkerState,
    sessionBudgetCents: Number(r.session_budget_cents),
    agentId: (r.agent_id as string | null) ?? null,
    agentVersion: r.agent_version === null || r.agent_version === undefined ? null : Number(r.agent_version),
    environmentId: (r.environment_id as string | null) ?? null,
    vaultId: (r.vault_id as string | null) ?? null,
    mcpServers: (r.mcp_servers as Record<string, McpServer>) ?? {},
    templateHash: r.template_hash as string,
    consecutiveFailures: Number(r.consecutive_failures),
    createdBy: r.created_by as string,
    createdAt: msNN(r.created_at as Date),
  };
}

export function deploymentRow(r: Row): DeploymentRow {
  return {
    workerId: r.worker_id as string,
    cron: r.cron as string,
    timezone: r.timezone as string,
    deploymentId: (r.deployment_id as string | null) ?? null,
    desired: r.desired_status as DeploymentRow["desired"],
    remote: r.remote_status as DeploymentRow["remote"],
    stale: (r.stale_deployment_ids as string[]) ?? [],
    lastRunSeenAt: (r.last_run_seen_at as string | null) ?? null,
    createKey: (r.create_key as string | null) ?? null,
    createAlertedAt: r.create_alerted_at ? (r.create_alerted_at as Date).getTime() : null,
  };
}

export function runRow(r: Row): RunRow {
  return {
    id: r.id as string,
    workerId: r.worker_id as string,
    trigger: r.trigger as RunRow["trigger"],
    runnerPersonId: r.runner_person_id as string,
    inputRecipients: (r.input_recipients as string[] | null) ?? null,
    overnight: r.overnight as boolean,
    overnightPolicyId: (r.overnight_policy_id as string | null) ?? null,
    startedAt: msNN(r.started_at as Date),
    endedAt: ms(r.ended_at as Date | null),
    state: r.state as RunState,
    stopReason: (r.stop_reason as StopReason | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    costCents: Number(r.cost_cents),
    budgetCents: Number(r.budget_cents),
    summary: (r.summary as string | null) ?? null,
    questions: (r.questions as string[]) ?? [],
    sessionRef: r.session_ref as string,
    deploymentRunRef: (r.deployment_run_ref as string | null) ?? null,
    interruptSentAt: ms(r.interrupt_sent_at as Date | null),
    outcomeSeq: Number(r.outcome_seq),
  };
}

export async function loadWorker(tx: Tx, id: string, lock = false): Promise<WorkerRow | null> {
  const [r] = lock ? await tx`select * from workers where id = ${id} for update` : await tx`select * from workers where id = ${id}`;
  return r ? workerRow(r) : null;
}

export async function loadDeployment(tx: Tx, workerId: string): Promise<DeploymentRow | null> {
  const [r] = await tx`select * from deployments where worker_id = ${workerId}`;
  return r ? deploymentRow(r) : null;
}

export async function loadRun(tx: Tx, id: string, lock = false): Promise<RunRow | null> {
  const [r] = lock ? await tx`select * from worker_runs where id = ${id} for update` : await tx`select * from worker_runs where id = ${id}`;
  return r ? runRow(r) : null;
}

export function workerDto(w: WorkerRow, d: DeploymentRow | null, now: number) {
  const scheduled = d !== null && d.desired !== "archived";
  return {
    id: w.id,
    workflowId: w.workflowId,
    version: w.version,
    jobRoleId: w.jobRoleId,
    identityId: w.identityId,
    state: w.state,
    schedule: scheduled
      ? { cron: d.cron, timezone: d.timezone, nextRunAt: w.state === "ready" && d.desired === "active" ? nextRun(d.cron, d.timezone, now) : null }
      : null,
    sessionBudgetCents: w.sessionBudgetCents,
    // ADR 0112 §4: placeholders until provisioning has created the agent and environment.
    externalRefs: {
      agentId: w.agentId ?? "",
      agentVersion: w.agentVersion ?? 1,
      environmentId: w.environmentId ?? "",
      deploymentId: scheduled ? d.deploymentId : null,
    },
    createdAt: w.createdAt,
  };
}

export async function runDto(tx: Tx, r: RunRow) {
  const hashes = await tx`select batch_hash from worker_run_batches where run_id = ${r.id} order by at, batch_hash`;
  return {
    id: r.id,
    workerId: r.workerId,
    trigger: r.trigger,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    state: r.state,
    stopReason: r.stopReason,
    costCents: r.costCents,
    batchHashes: hashes.map((h: { batch_hash: string }) => h.batch_hash).slice(0, 50),
    summary: r.summary,
    sessionRef: r.sessionRef,
  };
}
