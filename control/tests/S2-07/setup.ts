// S2-07 test world: the real app (every module), two seeded tenants, extra connections, a role policy, fake
// executors. Nothing here can reach a real tool: the Composio runner, MCP client and API transport are in-memory.
import type { Principal } from "../../src/app.ts";
import { withTenant } from "../../src/db/tenant.ts";
import type { Tx } from "../../src/db/pool.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { brokerOf, type Broker, type ProposeRun } from "../../src/modules/broker/broker.ts";
import { ApiExecutor, ComposioCliExecutor, McpExecutor, type ComposioRunner, type Executor, type RunResult } from "../../src/modules/broker/executors.ts";
import type { Stage2Item } from "../../src/modules/broker/stage1.ts";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";
import type { PersonKey, SeededTenant } from "../helpers/seed.ts";

export const TPL = "c".repeat(64);
export const WF = "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab";
export const WF2 = "1b6c2f1e-9a3d-4c1b-8e7f-1234567890ab";

export interface Conns {
  memberGmail: string;
  memberLinkedin: string;
  forbidden: string;
  vault: string;
  mcp: string;
  api: string;
  org: string;
  roleIdentity: string;
}

/** Records every argv; answers as told. `during` runs inside the call (to look at the journal mid-call). */
export class FakeComposio implements ComposioRunner {
  calls: string[][] = [];
  mode: "ok" | "fail" | "throw" | "hang" = "ok";
  during: (() => Promise<void>) | null = null;
  private hung: Array<(r: RunResult) => void> = [];
  async run(argv: string[]): Promise<RunResult> {
    this.calls.push(argv);
    if (this.during) await this.during();
    if (this.mode === "throw") throw new Error("connection reset by peer");
    if (this.mode === "fail") return { code: 1, stdout: JSON.stringify({ successful: false, error: "rate limited" }) };
    if (this.mode === "hang") return new Promise((resolve) => this.hung.push(resolve));
    return { code: 0, stdout: JSON.stringify({ successful: true, data: { id: `msg_${this.calls.length}` } }) };
  }
  /** Lets every hung call finish successfully (the late answer after a crash). */
  finishHung() {
    for (const r of this.hung.splice(0)) r({ code: 0, stdout: JSON.stringify({ successful: true }) });
  }
  /** Parsed `-d` arguments of every call. */
  args(): Array<Record<string, unknown>> {
    return this.calls.filter((a) => a[1] === "execute").map((a) => JSON.parse(a[a.indexOf("-d") + 1]!) as Record<string, unknown>);
  }
  tools(): string[] {
    return this.calls.filter((a) => a[1] === "execute").map((a) => a[2]!);
  }
}

export class FakeMcp {
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  async callTool(server: string, tool: string, args: Record<string, unknown>) {
    this.calls.push({ server, tool, args });
    return {};
  }
}

export class FakeApi {
  calls: Array<{ connectionRef: string; operation: string; body: Record<string, unknown> }> = [];
  async send(req: { connectionRef: string; operation: string; body: Record<string, unknown> }) {
    this.calls.push(req);
    return { status: 200 };
  }
}

export interface World {
  h: Harness;
  t: SeededTenant;
  broker: Broker;
  conns: Conns;
  composio: FakeComposio;
  mcp: FakeMcp;
  api: FakeApi;
  /** Swaps the Composio executor (undefined: none configured); `restore` puts the defaults back. */
  useComposio(e: Executor | undefined): void;
  restore(): void;
  close(): Promise<void>;
}

export async function world(): Promise<World> {
  const h = await createHarness();
  const t = h.a;
  const db = h.db.migrator;
  const conn = async (kind: string, ownership: string, provider: string, owner: string | null, ref: string, jobRoleId: string | null = null) =>
    ((await db`insert into connections (tenant_id, kind, ownership, label, owner_person_id, job_role_id, provider, external_ref)
      values (${t.id}, ${kind}, ${ownership}, ${kind}, ${owner}, ${jobRoleId}, ${provider}, ${ref}) returning id`)[0]!.id as string);
  const member = t.people.member.id;
  const conns: Conns = {
    memberGmail: await conn("gmail", "personal-allowed", "composio", member, "acct_member_gmail"),
    memberLinkedin: await conn("linkedin_personal", "personal-allowed", "composio", member, "acct_member_li"),
    forbidden: await conn("gmail", "personal-forbidden", "composio", member, "acct_member_private"),
    vault: await conn("company_mcp", "company", "managed_agents_vault", null, "vault_sales"),
    mcp: await conn("company_mcp", "company", "mcp", null, "mcp_sales_gmail"),
    api: await conn("api", "company", "api", null, "api_sales"),
    org: await conn("composio_org", "company", "composio", null, "acct_org"),
    roleIdentity: "",
  };
  const [ri] = await db`insert into role_identities (tenant_id, job_role_id, label, address, connection_id)
    values (${t.id}, ${t.jobRoles.sdr}, 'Sales inbox', 'sales@acme.example.com', ${t.connections.company}) returning id`;
  conns.roleIdentity = ri!.id as string;
  await db`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${t.id}, ${t.jobRoles.sdr}, ${member})`;
  await setRolePolicy(h, t, t.jobRoles.sdr, {});
  const broker = brokerOf(h.deps.ports);
  const composio = new FakeComposio();
  const mcp = new FakeMcp();
  const api = new FakeApi();
  const defaults = { composio: new ComposioCliExecutor(composio), mcp: new McpExecutor(mcp), api: new ApiExecutor(api) };
  broker.configure({ executors: defaults });
  return {
    h,
    t,
    broker,
    conns,
    composio,
    mcp,
    api,
    useComposio(e) {
      const { composio: _c, ...rest } = defaults;
      broker.configure({ executors: e === undefined ? rest : { ...rest, composio: e } });
    },
    restore() {
      broker.configure({ executors: defaults });
    },
    async close() {
      composio.finishHung();
      await broker.idle();
      await h.close();
    },
  };
}

export async function setRolePolicy(
  h: Harness,
  t: SeededTenant,
  jobRoleId: string,
  over: { allowed?: string[]; approvers?: string; maxItems?: number },
): Promise<void> {
  await h.db.migrator`insert into role_policies (tenant_id, job_role_id, allowed_capabilities, approvers, session_budget_cents,
      daily_budget_cents, max_items_per_batch, model_design, model_steps, updated_at, updated_by)
    values (${t.id}, ${jobRoleId}, ${over.allowed ?? ["mail.send", "crm.note", "chat.post", "outreach.add_lead"]}::jsonb,
      ${over.approvers ?? "runner_or_dept_lead"}, 500, 2000, ${over.maxItems ?? 5}, 'claude-opus-5-5', 'claude-sonnet-5-5', now(), ${t.people.admin.id})
    on conflict (tenant_id, job_role_id) do update set allowed_capabilities = excluded.allowed_capabilities,
      approvers = excluded.approvers, max_items_per_batch = excluded.max_items_per_batch`;
}

export const email = (to: string, subject = "Seed round follow-up", body = `Hi,\nshort note for ${to}.\nSam`): Stage2Item => ({
  key: to.toLowerCase(),
  capability: "mail.send",
  fields: [["to", to], ["subject", subject], ["body", body]],
});

/** A run of the member through their own Gmail (personal-allowed), unless overridden. */
export function memberRun(w: World, over: Partial<ProposeRun> = {}): ProposeRun {
  return {
    runId: ulid(w.h.clock.now()),
    workflowId: WF,
    version: 1,
    jobRoleId: w.t.jobRoles.sdr,
    runtime: "cloud",
    identity: { type: "person", id: w.t.people.member.id },
    runnerPersonId: w.t.people.member.id,
    connectionId: w.conns.memberGmail,
    ...over,
  };
}

export async function propose(w: World, items: Stage2Item[], over: Partial<ProposeRun> = {}) {
  const r = await w.broker.proposeBatch(w.t.id, memberRun(w, over), items);
  return r;
}

/** Proposes and returns the hash, failing the test on a rejection. */
export async function proposeOk(w: World, items: Stage2Item[], over: Partial<ProposeRun> = {}): Promise<string> {
  const r = await propose(w, items, over);
  if (!r.ok) throw new Error(`propose rejected: ${r.code} ${r.message}`);
  return r.batchHash;
}

export async function principal(w: World, who: PersonKey, t: SeededTenant = w.t): Promise<Principal> {
  const [p] = await w.h.db.migrator`select access_role, dept_lead_of, jurisdiction from people where id = ${t.people[who].id}`;
  return {
    kind: "person",
    tenantId: t.id,
    personId: t.people[who].id,
    accessRole: p!.access_role as Principal["accessRole"],
    departmentScope: p!.dept_lead_of as string[],
    jurisdiction: p!.jurisdiction as string,
    sessionId: "test",
    csrfToken: "test",
  };
}

export function tx<T>(w: World, fn: (tx: Tx) => Promise<T>, t: SeededTenant = w.t): Promise<T> {
  return withTenant(w.h.db.app, { tenantId: t.id, accessRole: "system" }, fn);
}

/** Approves in-process (returns the token, which HTTP never shows). */
export async function approveToken(w: World, who: PersonKey, hash: string, edits: Array<{ key: string; fields: Array<[string, string]> }> = [], itemKeys: string[] | null = null) {
  const p = await principal(w, who);
  return withTenant(w.h.db.app, { tenantId: w.t.id, principalPersonId: p.personId, accessRole: p.accessRole }, (t) =>
    w.broker.approve(t, p, hash, { batchHash: hash, itemKeys, edits }),
  );
}

export async function client(w: World, who: PersonKey, t: SeededTenant = w.t): Promise<Client> {
  return asPrincipal(w.h, who, t);
}

export async function approveHttp(w: World, who: PersonKey, hash: string, body: Record<string, unknown> = {}) {
  const c = await client(w, who);
  const r = await c.post(`/v1/batches/${hash}/approve`, { batchHash: hash, itemKeys: null, edits: [], ...body });
  await w.broker.idle();
  return r;
}

export interface ItemView {
  key: string;
  state: string;
  token_id: string | null;
  scheduled_for: Date | null;
  error: string | null;
  tool: string | null;
  released_at: Date | null;
}

export async function items(w: World, hash: string): Promise<ItemView[]> {
  return (await w.h.db.migrator`select key, state, token_id, scheduled_for, error, tool, released_at from batch_items
    where tenant_id = ${w.t.id} and batch_hash = ${hash} order by position`) as ItemView[];
}

export async function batchState(w: World, hash: string): Promise<string> {
  const [b] = await w.h.db.migrator`select state from batches where tenant_id = ${w.t.id} and hash = ${hash}`;
  return b!.state as string;
}

export async function auditActions(w: World, t: SeededTenant = w.t): Promise<string[]> {
  return (await w.h.db.migrator`select action from audit_events where tenant_id = ${t.id} order by seq`).map((r: Record<string, unknown>) => r.action as string);
}

export async function overnightPolicy(w: World, over: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const body = {
    id,
    workflowId: WF,
    version: 1,
    mode: "preapproved",
    recipients: { emails: ["ana@fund.com", "bo@fund.com", "cy@fund.com"], domains: ["northzone.com"], repliesToThreadsStartedByIdentity: false },
    templateHash: TPL,
    maxCommitsPerNight: 10,
    maxPerRecipientPerWeek: 1,
    sendWindow: { startHour: 0, endHour: 24, days: [1, 2, 3, 4, 5, 6, 7], recipientTimezone: true },
    attachmentsAllowed: false,
    budgetCentsPerNight: 500,
    dryRunNights: 0,
    dryRunNightsDone: 0,
    circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 2 },
    state: "active",
    trippedReason: null,
    ownerPersonId: w.t.people.member.id,
    ...over,
  };
  const r = await (await client(w, "member")).post("/v1/overnight-policies", body);
  if (r.status !== 201) throw new Error(`policy create ${r.status} ${JSON.stringify(r.json)}`);
  return id;
}

export const overnightRun = (policyId: string, over: Partial<ProposeRun> = {}): Partial<ProposeRun> => ({
  overnight: true,
  overnightPolicyId: policyId,
  templateHash: TPL,
  ...over,
});
