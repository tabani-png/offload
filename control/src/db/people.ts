import type { Tx } from "./pool.ts";

/**
 * The tenant's owners lock: every change that can leave a tenant without an active owner (role change, offboarding,
 * directory deactivation) takes it FIRST, before any row lock, then re-counts owners. One key, one hash function.
 */
export async function lockOwners(tx: Tx): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('owners:' || current_setting('app.tenant_id'), 0))`;
}

/** Person DTO (schemas/stage2/person.schema.json). */
export interface PersonDto {
  id: string;
  email: string;
  displayName: string;
  accessRole: "owner" | "admin" | "dept_lead" | "member" | "auditor";
  departmentId: string | null;
  deptLeadOf: string[];
  jobRoleIds: string[];
  jurisdiction: string;
  state: "active" | "leaving" | "frozen" | "departed";
  leavingOn: string | null;
  source: "directory" | "invite" | "manual";
  noticeAckVersionId: string | null;
}

/** What a department lead sees about a person in scope (schemas/stage2/person-summary.schema.json, ADR 0111 §2). */
export type PersonSummaryDto = Pick<PersonDto, "id" | "displayName" | "departmentId" | "jobRoleIds" | "state">;

export function personSummary(p: PersonDto): PersonSummaryDto {
  return { id: p.id, displayName: p.displayName, departmentId: p.departmentId, jobRoleIds: p.jobRoleIds, state: p.state };
}

export interface PersonRow {
  id: string;
  email: string;
  display_name: string;
  access_role: PersonDto["accessRole"];
  department_id: string | null;
  dept_lead_of: string[];
  jurisdiction: string;
  state: PersonDto["state"];
  leaving_on: string | null;
  source: PersonDto["source"];
  notice_ack_version_id: string | null;
  job_role_ids: string[] | null;
}

/** Selects people with their job role ids; `where` is a fragment built with the same tx. */
export async function selectPeople(tx: Tx, where: unknown, limit = 1000): Promise<PersonDto[]> {
  const rows = (await tx`select p.id, p.email, p.display_name, p.access_role, p.department_id, p.dept_lead_of,
      p.jurisdiction, p.state, to_char(p.leaving_on, 'YYYY-MM-DD') as leaving_on, p.source, p.notice_ack_version_id,
      coalesce((select jsonb_agg(h.job_role_id order by h.job_role_id) from job_role_holders h
        where h.tenant_id = p.tenant_id and h.person_id = p.id), '[]'::jsonb) as job_role_ids
    from people p where ${where} order by p.id limit ${limit}`) as PersonRow[];
  return rows.map(personDto);
}

export function personDto(r: PersonRow): PersonDto {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    accessRole: r.access_role,
    departmentId: r.department_id,
    deptLeadOf: r.dept_lead_of,
    jobRoleIds: r.job_role_ids ?? [],
    jurisdiction: r.jurisdiction,
    state: r.state,
    leavingOn: r.leaving_on,
    source: r.source,
    noticeAckVersionId: r.notice_ack_version_id,
  };
}

export async function personById(tx: Tx, id: string): Promise<PersonDto | null> {
  const [p] = await selectPeople(tx, tx`p.id = ${id}`, 1);
  return p ?? null;
}
