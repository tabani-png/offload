import type { Principal } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import type { Scope } from "../../rbac/permissions.ts";
import type { DefinitionObject, WorkflowDto, WorkflowState } from "./types.ts";

export interface WorkflowRow {
  id: string;
  name: string;
  state: WorkflowState;
  jobRoleId: string | null;
  departmentId: string | null;
  latestVersion: number;
  proposedBy: string | null;
  proposerDepartmentId: string | null;
  proposalHash: string | null;
  proposal: DefinitionObject | null;
  proposedAt: number | null;
  promotedBy: string | null;
  promotedAt: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowOf(r: Record<string, unknown>): WorkflowRow {
  return {
    id: r.id as string,
    name: r.name as string,
    state: r.state as WorkflowState,
    jobRoleId: r.job_role_id as string | null,
    departmentId: r.department_id as string | null,
    latestVersion: Number(r.latest_version),
    proposedBy: r.proposed_by as string | null,
    proposerDepartmentId: r.proposer_department_id as string | null,
    proposalHash: r.proposal_hash as string | null,
    proposal: r.proposal_definition as DefinitionObject | null,
    proposedAt: num(r.proposed_at_ms),
    promotedBy: r.promoted_by as string | null,
    promotedAt: num(r.promoted_at_ms),
  };
}

const COLS = (tx: Tx) => tx`w.id, w.name, w.state, w.job_role_id, w.department_id, w.latest_version, w.proposed_by,
  w.proposer_department_id, w.proposal_hash, w.proposal_definition, w.proposed_at_ms, w.promoted_by, w.promoted_at_ms`;

export const isRole = (s: WorkflowState): boolean => s === "role" || s === "retired";

/**
 * Who sees a workflow (API.md "Workflow registry"): T everything; Dp role workflows owned by, and proposals made from,
 * the lead's departments; S role workflows of the person's job roles and the person's own proposals.
 */
export function visibleWhere(tx: Tx, scope: Scope, p: Principal) {
  if (scope === "T") return tx`true`;
  if (scope === "Dp") {
    return tx`(case when w.state in ('role', 'retired') then w.department_id else w.proposer_department_id end)
      in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid)`;
  }
  return tx`(case when w.state in ('role', 'retired')
      then w.job_role_id in (select h.job_role_id from job_role_holders h where h.person_id = ${p.personId})
      else w.proposed_by = ${p.personId} end)`;
}

/** The workflow if the caller may see it; `lock` takes a row lock for a mutation. */
export async function findVisible(tx: Tx, scope: Scope, p: Principal, id: string, lock = false): Promise<WorkflowRow | null> {
  const [r] = lock
    ? await tx`select ${COLS(tx)} from workflows w where w.id = ${id} and ${visibleWhere(tx, scope, p)} for update`
    : await tx`select ${COLS(tx)} from workflows w where w.id = ${id} and ${visibleWhere(tx, scope, p)}`;
  return r ? rowOf(r) : null;
}

export interface ListFilter {
  after: string | null;
  state: WorkflowState | null;
  jobRoleId: string | null;
  departmentId: string | null;
  limit: number;
}

export async function listVisible(tx: Tx, scope: Scope, p: Principal, f: ListFilter): Promise<WorkflowRow[]> {
  const rows: Array<Record<string, unknown>> = await tx`select ${COLS(tx)} from workflows w
    where (${f.after}::uuid is null or w.id > ${f.after}::uuid)
      and (${f.state}::text is null or w.state = ${f.state}::text)
      and (${f.jobRoleId}::uuid is null or w.job_role_id = ${f.jobRoleId}::uuid)
      and (${f.departmentId}::uuid is null or w.department_id = ${f.departmentId}::uuid)
      and ${visibleWhere(tx, scope, p)}
    order by w.id limit ${f.limit}`;
  return rows.map(rowOf);
}

export interface VersionRow {
  version: number;
  definition: DefinitionObject;
  definitionHash: string;
  baselineCarryOver: boolean;
  createdBy: string;
  createdAt: number;
}

function versionOf(r: Record<string, unknown>): VersionRow {
  return {
    version: Number(r.version),
    definition: r.definition as DefinitionObject,
    definitionHash: r.definition_hash as string,
    baselineCarryOver: r.baseline_carry_over as boolean,
    createdBy: r.created_by as string,
    createdAt: Number(r.created_at_ms),
  };
}

export async function roleVersions(tx: Tx, workflowId: string): Promise<VersionRow[]> {
  const rows: Array<Record<string, unknown>> = await tx`select version, definition, definition_hash, baseline_carry_over,
      created_by, created_at_ms
    from workflow_versions where workflow_id = ${workflowId} order by version`;
  return rows.map(versionOf);
}

export async function roleVersion(tx: Tx, workflowId: string, version: number): Promise<VersionRow | null> {
  const [r] = await tx`select version, definition, definition_hash, baseline_carry_over, created_by, created_at_ms
    from workflow_versions where workflow_id = ${workflowId} and version = ${version}`;
  return r ? versionOf(r) : null;
}

/** The definition object served for version `v`: a role version, or for a proposal its single version 1. */
export async function definitionAt(tx: Tx, w: WorkflowRow, v: number): Promise<DefinitionObject | null> {
  if (isRole(w.state)) return (await roleVersion(tx, w.id, v))?.definition ?? null;
  return v === 1 ? w.proposal : null;
}

/** workflow.schema.json for a row. A proposal shows its proposal as version 1; a role workflow its role versions. */
export async function dto(tx: Tx, w: WorkflowRow): Promise<WorkflowDto> {
  const versions = isRole(w.state)
    ? (await roleVersions(tx, w.id)).map((v) => ({ version: v.version, definitionHash: v.definitionHash, createdAt: v.createdAt, createdBy: v.createdBy }))
    : [{ version: 1, definitionHash: w.proposalHash!, createdAt: w.proposedAt!, createdBy: w.proposedBy! }];
  return {
    id: w.id,
    name: w.name,
    state: w.state,
    jobRoleId: w.jobRoleId,
    departmentId: w.departmentId,
    latestVersion: isRole(w.state) ? w.latestVersion : 1,
    proposedBy: w.proposedBy,
    promotedBy: w.promotedBy,
    promotedAt: w.promotedAt,
    // Grades are S2-05's (ADR 0109); the registry only stores the carry-over flag per version.
    baselineGrade: null,
    versions,
  };
}

export async function dtos(tx: Tx, rows: WorkflowRow[]): Promise<WorkflowDto[]> {
  const out: WorkflowDto[] = [];
  for (const r of rows) out.push(await dto(tx, r));
  return out;
}

export interface ConnectionRow {
  id: string;
  kind: string;
  ownership: string;
  label: string;
}

export async function connectionById(tx: Tx, id: string): Promise<ConnectionRow | null> {
  const [c] = await tx`select id, kind, ownership, label from connections where id = ${id}`;
  return c ? { id: c.id as string, kind: c.kind as string, ownership: c.ownership as string, label: c.label as string } : null;
}

export interface BindingInsert {
  stepId: string;
  stepClass: string;
  capability: string;
  connectionId: string | null;
  ownership: string | null;
  disabled: boolean;
}

/** Inserts an immutable version and one binding row per step (position = order in the source definition). */
export async function insertVersion(
  tx: Tx,
  workflowId: string,
  def: DefinitionObject,
  carryOver: boolean,
  createdBy: string,
  bindings: BindingInsert[],
): Promise<void> {
  await tx`insert into workflow_versions (tenant_id, workflow_id, version, definition, definition_hash, baseline_carry_over,
      created_by, created_at_ms)
    values (current_setting('app.tenant_id')::uuid, ${workflowId}, ${def.version}, ${def}::jsonb,
      ${def.definitionHash}, ${carryOver}, ${createdBy}, ${def.createdAt})`;
  for (const [position, b] of bindings.entries()) {
    await tx`insert into version_bindings (tenant_id, workflow_id, version, position, step_id, step_class, capability,
        connection_id, ownership, disabled)
      values (current_setting('app.tenant_id')::uuid, ${workflowId}, ${def.version}, ${position}, ${b.stepId}, ${b.stepClass},
        ${b.capability}, ${b.connectionId}, ${b.ownership}, ${b.disabled})`;
  }
}
