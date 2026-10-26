// S2-10 test world: the real app (every module), two seeded tenants, two promoted SDR role workflows, a finance
// workflow, a role identity per job role, personal connections of the leaver, and a WorkersPort spy that records
// whether each call could already see the committed freeze. Only public interfaces: the registry's sync handler and
// HTTP API, the role-identity and policy APIs, the broker and registry ports. Nothing reaches a real account.
import type { Principal } from "../../src/app.ts";
import { withTenant } from "../../src/db/tenant.ts";
import type { Tx } from "../../src/db/pool.ts";
import type { WorkersPort } from "../../src/ports.ts";
import { ulid } from "../../src/schema/encoding.ts";
import registry from "../../src/modules/registry/index.ts";
import { definitionHash } from "../../src/modules/registry/hash.ts";
import type { Definition } from "../../src/modules/registry/types.ts";
import { brokerOf, type Broker, type ProposeRun } from "../../src/modules/broker/broker.ts";
import type { Stage2Item } from "../../src/modules/broker/stage1.ts";
import { continuityOf, type Continuity } from "../../src/modules/continuity/index.ts";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";
import { createSession, type PersonKey, type SeededTenant } from "../helpers/seed.ts";

/** Records every pauseFor call and whether the person's freeze was already committed (seen from another connection). */
export class PauseSpy implements WorkersPort {
  calls: Array<{ personId: string; committedState: string | null }> = [];
  /** Fail the calls made once the freeze is committed (the workers service is down at follow-up time). The S2-07
   * broker also calls pauseFor inside the freeze transaction (stopRunsFor); that call is left alone. */
  failAfterCommit = false;
  constructor(private readonly seen: () => Harness | null) {}
  async pauseFor(_tx: Tx, personId: string): Promise<number> {
    const h = this.seen();
    const [p] = h ? await h.db.migrator`select state from people where id = ${personId}` : [];
    this.calls.push({ personId, committedState: (p?.state as string | undefined) ?? null });
    if (this.failAfterCommit && p?.state === "frozen") throw new Error("workers unavailable");
    return 1;
  }
  /** Calls made once the freeze was committed. */
  afterCommit(personId: string) {
    return this.calls.filter((c) => c.personId === personId && c.committedState === "frozen");
  }
}

export interface Extra {
  /** A second SDR in sales (holds the SDR job role): the natural successor. */
  rep2: string;
  /** A sales member without the SDR job role. */
  rep3: string;
}

export interface World {
  h: Harness;
  t: SeededTenant;
  workers: PauseSpy;
  broker: Broker;
  continuity: Continuity;
  extra: Extra;
  /** Two SDR role workflows (sales) and one AP workflow (finance). */
  wf: { sdr1: string; sdr2: string; ap: string };
  /** The member's still-unpromoted proposal. */
  proposalId: string;
  identities: { sdr: string; ap: string };
  /** The leaver's (member's) personal connections. */
  personal: { gmail: string; linkedin: string; forbidden: string };
  /** rep2's own personal Gmail (must survive the member's freeze). */
  rep2Gmail: string;
  as(who: PersonKey | "rep2" | "rep3"): Promise<Client>;
  close(): Promise<void>;
}

let seq = 0;

/** A proposal as the Mac shares it: draft + a commit step on a personal Gmail. */
export function proposal(name: string, createdAt: number): Definition & { id: string; kind: "workflow_proposal"; createdAt: number; definitionHash: string } {
  const def: Definition = {
    localWorkflowId: `wf_s210_${++seq}`,
    workflowId: null,
    version: null,
    name,
    description: "Write one short follow-up per new lead and send it after review.",
    trigger: { type: "cron", cron: "0 9 * * 1", timezone: "America/Toronto" },
    steps: [
      { id: "draft_intro", title: "Draft the intro", detail: "Draft one email per lead.", class: "draft", capability: "text.draft", connection: null, gate: "none" },
      {
        id: "send_intro",
        title: "Send the intro",
        detail: "Send each approved email exactly as approved.",
        class: "commit",
        capability: "mail.send",
        connection: { kind: "gmail", ownership: "personal-allowed", connectionId: null, label: "Gmail" },
        gate: "approval",
      },
    ],
    skillMd: "# Follow-up\n\n## Steps\n1. Draft the intro.\n2. Send the intro.\n",
    factsKeys: [],
    limits: { maxItemsPerRun: 20, maxRunsPerDay: 1 },
  };
  return { id: ulid(createdAt), kind: "workflow_proposal", createdAt, ...def, definitionHash: definitionHash(def) };
}

/** Shares a proposal from `personId`'s Mac (the registry's sync handler, as ingest calls it). Returns the workflow id. */
export async function share(h: Harness, t: SeededTenant, personId: string, role: Principal["accessRole"], name: string): Promise<string> {
  const obj = proposal(name, h.clock.now());
  const principal: Principal = { kind: "device", tenantId: t.id, personId, deviceId: crypto.randomUUID(), accessRole: role, departmentScope: [], jurisdiction: "CA-ON" };
  await withTenant(h.db.app, { tenantId: t.id, principalId: principal.deviceId, principalPersonId: personId, accessRole: role }, (tx) =>
    registry.syncHandlers!.workflow_proposal!(tx, obj, { principal, deps: h.deps }),
  );
  const [r] = await h.db.migrator`select id from workflows where tenant_id = ${t.id} and proposal_hash = ${obj.definitionHash}`;
  return r!.id as string;
}

export async function promote(admin: Client, workflowId: string, jobRoleId: string, departmentId: string, connectionId: string): Promise<void> {
  const r = await admin.post(`/v1/workflows/${workflowId}/promote`, {
    jobRoleId,
    departmentId,
    fromVersion: 1,
    bindings: [{ stepId: "send_intro", connectionId, disable: false }],
  });
  if (r.status !== 200) throw new Error(`promote ${r.status} ${JSON.stringify(r.json)}`);
}

export async function world(): Promise<World> {
  let hh: Harness | null = null;
  const workers = new PauseSpy(() => hh);
  const h = await createHarness({ ports: { workers } });
  hh = h;
  const t = h.a;
  const db = h.db.migrator;
  const person = async (key: string, departmentId: string) =>
    ((await db`insert into people (tenant_id, email, display_name, access_role, department_id, jurisdiction, source)
      values (${t.id}, ${`${key}@${t.id.slice(0, 8)}.example.com`}, ${key}, 'member', ${departmentId}, 'CA-ON', 'manual') returning id`)[0]!.id as string);
  const extra: Extra = { rep2: await person("rep2", t.departments.sales), rep3: await person("rep3", t.departments.sales) };
  const hold = (jobRoleId: string, personId: string) =>
    db`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${t.id}, ${jobRoleId}, ${personId})`;
  await hold(t.jobRoles.sdr, t.people.member.id);
  await hold(t.jobRoles.sdr, extra.rep2);
  await hold(t.jobRoles.ap, t.people.member2.id);

  const conn = async (kind: string, ownership: string, owner: string | null, label: string) =>
    ((await db`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
      values (${t.id}, ${kind}, ${ownership}, ${label}, ${owner}, 'composio', ${`acct_${kind}_${++seq}`}) returning id`)[0]!.id as string);
  const member = t.people.member.id;
  const personal = {
    gmail: await conn("gmail", "personal-allowed", member, "Member Gmail"),
    linkedin: await conn("linkedin_personal", "personal-forbidden", member, "Member LinkedIn"),
    forbidden: await conn("gmail", "personal-forbidden", member, "Member private Gmail"),
  };
  const rep2Gmail = await conn("gmail", "personal-allowed", extra.rep2, "Rep2 Gmail");
  const apMailbox = await conn("m365_shared_mailbox", "company", null, "AP mailbox");

  const as = async (who: PersonKey | "rep2" | "rep3"): Promise<Client> => {
    if (who !== "rep2" && who !== "rep3") return asPrincipal(h, who);
    const personId = extra[who];
    const cred = await createSession(db, t.id, personId, h.clock.now());
    const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      h.request(method, path, { ...(body !== undefined ? { body } : {}), headers: { Cookie: cred.cookie, "X-CSRF-Token": cred.csrf, ...headers } });
    return {
      cred,
      personId,
      send,
      get: (p, hd) => send("GET", p, undefined, hd),
      post: (p, b = {}, hd) => send("POST", p, b, hd),
      patch: (p, b = {}, hd) => send("PATCH", p, b, hd),
      put: (p, b = {}, hd) => send("PUT", p, b, hd),
      del: (p, hd) => send("DELETE", p, undefined, hd),
    };
  };
  const admin = await as("admin");

  const sdr1 = await share(h, t, member, "member", "Lead follow-up");
  const sdr2 = await share(h, t, member, "member", "Meeting reminder");
  const ap = await share(h, t, t.people.member2.id, "member", "Invoice chaser");
  const proposalId = await share(h, t, member, "member", "Unpromoted idea");
  await promote(admin, sdr1, t.jobRoles.sdr, t.departments.sales, t.connections.company);
  await promote(admin, sdr2, t.jobRoles.sdr, t.departments.sales, t.connections.company);
  await promote(admin, ap, t.jobRoles.ap, t.departments.finance, apMailbox);

  const identity = async (jobRoleId: string, connectionId: string, label: string) => {
    const r = await admin.post("/v1/role-identities", { jobRoleId, label, address: `${label.toLowerCase()}@acme.example.com`, connectionId, signature: `-- ${label} team` });
    if (r.status !== 201) throw new Error(`role identity ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.id as string;
  };
  const identities = { sdr: await identity(t.jobRoles.sdr, t.connections.company, "Sales"), ap: await identity(t.jobRoles.ap, apMailbox, "Payables") };

  for (const jr of [t.jobRoles.sdr, t.jobRoles.ap]) {
    const r = await admin.put(`/v1/policies/job-roles/${jr}`, {
      jobRoleId: jr,
      allowedCapabilities: ["mail.send"],
      approvers: "runner_or_dept_lead",
      sessionBudgetCents: 500,
      dailyBudgetCents: 2000,
      maxItemsPerBatch: 5,
      models: { design: "claude-opus-5-5", steps: "claude-sonnet-5-5" },
      updatedAt: h.clock.now(),
      updatedBy: t.people.admin.id,
    });
    if (r.status !== 200) throw new Error(`role policy ${r.status} ${JSON.stringify(r.json)}`);
  }

  const broker = brokerOf(h.deps.ports);
  return {
    h,
    t,
    workers,
    broker,
    continuity: continuityOf(h.deps.ports),
    extra,
    wf: { sdr1, sdr2, ap },
    proposalId,
    identities,
    personal,
    rep2Gmail,
    as,
    async close() {
      await continuityOf(h.deps.ports).idle();
      await broker.idle();
      await h.close();
    },
  };
}

export const email = (to: string): Stage2Item => ({
  key: to.toLowerCase(),
  capability: "mail.send",
  fields: [["to", to], ["subject", "Follow-up"], ["body", `Hi,\nshort note for ${to}.`]],
});

let mail = 0;
export const to = () => `lead${++mail}@prospect.example.com`;

/** A run of `workflowId` as a person (through `connectionId`) or as a role identity (through its connection). */
export function run(w: World, workflowId: string, identity: ProposeRun["identity"], runnerPersonId: string, connectionId: string, jobRoleId = w.t.jobRoles.sdr): ProposeRun {
  return { runId: ulid(w.h.clock.now() + ++mail), workflowId, version: 1, jobRoleId, runtime: "cloud", identity, runnerPersonId, connectionId };
}

export function tx<T>(w: World, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant(w.h.db.app, { tenantId: w.t.id, accessRole: "system" }, fn);
}

/** Admin offboarding through the API; effectiveOn defaults to today (freeze now). */
export async function offboard(w: World, personId: string, over: Partial<{ effectiveOn: string; reason: string; note: string }> = {}, who: PersonKey = "admin") {
  const c = await w.as(who);
  const r = await c.post(`/v1/people/${personId}/offboard`, { effectiveOn: today(w), reason: "admin", note: "", ...over });
  await w.continuity.idle();
  return r;
}

export function today(w: World, plusDays = 0): string {
  return new Date(w.h.clock.now() + plusDays * 86_400_000).toISOString().slice(0, 10);
}

export async function handoversOf(w: World, personId: string) {
  return (await w.h.db.migrator`select id, workflow_id, state, successor_type, successor_person_id, successor_role_identity_id,
      accepted_at, in_flight, inbox_step, removed_connections, message_reviewed_at
    from handovers where tenant_id = ${w.t.id} and person_id = ${personId} order by workflow_id`) as Array<Record<string, any>>;
}

export async function handoverFor(w: World, personId: string, workflowId: string): Promise<string> {
  const [r] = await w.h.db.migrator`select id from handovers where tenant_id = ${w.t.id} and person_id = ${personId} and workflow_id = ${workflowId}`;
  if (!r) throw new Error("no hand-over");
  return r.id as string;
}

export async function audits(w: World, action: string) {
  return (await w.h.db.migrator`select actor_type, actor_id, action, subject_person_id, resource_type, resource_id, detail
    from audit_events where tenant_id = ${w.t.id} and action = ${action} order by seq`) as Array<Record<string, any>>;
}

export async function stateOf(w: World, personId: string): Promise<string> {
  const [p] = await w.h.db.migrator`select state from people where id = ${personId}`;
  return p!.state as string;
}

export const runnable = (w: World, workflowId: string, runner: { personId: string } | { identityId: string }) =>
  tx(w, (t) => (w.h.deps.ports.registry as unknown as { isRunnableBy(tx: Tx, id: string, v: number, r: typeof runner): Promise<boolean> }).isRunnableBy(t, workflowId, 1, runner));

/** The in-process principal of a seeded person (for broker calls the HTTP layer would make). */
export async function principal(w: World, who: PersonKey): Promise<Principal> {
  const [p] = await w.h.db.migrator`select access_role, dept_lead_of, jurisdiction from people where id = ${w.t.people[who].id}`;
  return {
    kind: "person",
    tenantId: w.t.id,
    personId: w.t.people[who].id,
    accessRole: p!.access_role as Principal["accessRole"],
    departmentScope: p!.dept_lead_of as string[],
    jurisdiction: p!.jurisdiction as string,
    sessionId: "test",
    csrfToken: "test",
  };
}
