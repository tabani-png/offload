import type { Db } from "../../src/db/pool.ts";
import { randomToken, sha256Hex } from "../../src/schema/encoding.ts";
import { SESSION_ABSOLUTE_MS } from "../../src/config.ts";

export type PersonKey = "owner" | "admin" | "lead" | "member" | "member2" | "auditor";

export interface SeededTenant {
  id: string;
  name: string;
  workosOrgId: string;
  directoryId: string;
  departments: { sales: string; finance: string };
  people: Record<PersonKey, { id: string; email: string; role: string; departmentId: string | null }>;
  jobRoles: { sdr: string; ap: string };
  connections: { company: string; personal: string };
}

let n = 0;

/**
 * Seeds one tenant through the migrator (owner) connection: two departments (sales, finance), one person per
 * access role (lead leads sales; member in sales; member2 in finance), a job role per department and two connections.
 */
export async function seedTenant(db: Db, name = `Tenant ${++n}`): Promise<SeededTenant> {
  const workosOrgId = `org_${randomToken(8)}`;
  const directoryId = `directory_${randomToken(8)}`;
  const [t] = await db`insert into tenants (name, workos_org_id, workos_directory_id) values (${name}, ${workosOrgId}, ${directoryId}) returning id`;
  const tenantId = t!.id as string;
  const dept = async (dn: string) =>
    ((await db`insert into departments (tenant_id, name) values (${tenantId}, ${dn}) returning id`)[0]!.id as string);
  const sales = await dept("Sales");
  const finance = await dept("Finance");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const person = async (key: PersonKey, role: string, departmentId: string | null, leadOf: string[] = []) => {
    const email = `${key}@${slug}.example.com`;
    const [p] = await db`insert into people (tenant_id, email, display_name, access_role, department_id, dept_lead_of,
        jurisdiction, source)
      values (${tenantId}, ${email}, ${key}, ${role}, ${departmentId}, ${leadOf}::jsonb, 'CA-ON', 'manual') returning id`;
    return { id: p!.id as string, email, role, departmentId };
  };
  const people = {
    owner: await person("owner", "owner", null),
    admin: await person("admin", "admin", null),
    lead: await person("lead", "dept_lead", sales, [sales]),
    member: await person("member", "member", sales),
    member2: await person("member2", "member", finance),
    auditor: await person("auditor", "auditor", null),
  };
  const jr = async (jn: string, d: string) =>
    ((await db`insert into job_roles (tenant_id, name, department_id) values (${tenantId}, ${jn}, ${d}) returning id`)[0]!
      .id as string);
  const jobRoles = { sdr: await jr("SDR", sales), ap: await jr("AP clerk", finance) };
  const conn = async (ownership: string, kind: string) =>
    ((await db`insert into connections (tenant_id, kind, ownership, label, provider, external_ref)
      values (${tenantId}, ${kind}, ${ownership}, ${kind}, 'composio', ${`ref_${randomToken(6)}`}) returning id`)[0]!.id as string);
  const connections = {
    company: await conn("company", "m365_shared_mailbox"),
    personal: await conn("personal-allowed", "gmail"),
  };
  return { id: tenantId, name, workosOrgId, directoryId, departments: { sales, finance }, people, jobRoles, connections };
}

export interface SessionCred {
  cookie: string;
  csrf: string;
  sessionId: string;
}

/** Inserts a live web session directly (what /auth/callback would create). */
export async function createSession(db: Db, tenantId: string, personId: string, now: number): Promise<SessionCred> {
  const secret = randomToken(32);
  const csrf = randomToken(24);
  const [s] = await db`insert into sessions (tenant_id, person_id, token_hash, csrf_token, created_at, last_seen_at, expires_at)
    values (${tenantId}, ${personId}, ${sha256Hex(secret)}, ${csrf}, ${new Date(now)}, ${new Date(now)},
      ${new Date(now + SESSION_ABSOLUTE_MS)}) returning id`;
  return { cookie: `__Host-offload_session=${tenantId}.${secret}`, csrf, sessionId: s!.id as string };
}
