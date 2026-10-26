// S2-09 test world: the real app with every module, two seeded tenants, a role workflow promoted through the registry's
// public interfaces (its workflow_proposal sync handler + POST promote), a role policy and overnight policies through
// the policies API, the broker with an in-memory Composio runner, and Managed Agents faked at the HTTP boundary
// (FakeManagedAgents behind the real SDK client). Nothing here can reach a network or a real account.
import { withTenant } from "../../src/db/tenant.ts";
import type { Tx } from "../../src/db/pool.ts";
import { jcs, sha256Hex, ulid } from "../../src/schema/encoding.ts";
import registry from "../../src/modules/registry/index.ts";
import { ComposioCliExecutor, brokerOf, type Broker } from "../../src/modules/broker/index.ts";
import { workersOf, type Workers } from "../../src/modules/workers/index.ts";
import { FakeManagedAgents, type Step } from "../../src/modules/workers/fake-managed-agents.ts";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";
import type { PersonKey, SeededTenant } from "../helpers/seed.ts";

export const WORKER = "offload/stage2/worker.schema.json";
export const WORKER_RUN = "offload/stage2/worker-run.schema.json";
export const DIGEST = "offload/stage2/digest.schema.json";

export const MCP_URL = "https://gmail-mcp.acme.example/mcp";
export const SKILL = "# Follow-ups\n\nRead the thread, draft one short follow-up per lead, propose them as one batch.";

/** Records every Composio CLI call the broker's executor makes (none may happen without an approval). */
export class FakeComposio {
  calls: string[][] = [];
  async run(argv: string[]) {
    this.calls.push(argv);
    return { code: 0, stdout: JSON.stringify({ successful: true, data: { id: `msg_${this.calls.length}` } }) };
  }
  sends(): string[][] {
    return this.calls.filter((a) => a[1] === "execute");
  }
}

export interface World {
  h: Harness;
  t: SeededTenant;
  fake: FakeManagedAgents;
  workers: Workers;
  broker: Broker;
  composio: FakeComposio;
  conns: { readMail: string; readPlain: string; sendMail: string; web: string; roleIdentity: string };
  wf: { id: string; version: number };
  /** A second role workflow (web research) in the same job role. */
  wfWeb: { id: string; version: number };
  as(who: PersonKey, t?: SeededTenant): Promise<Client>;
  close(): Promise<void>;
}

type Step0 = { id: string; title: string; detail: string; class: "read" | "draft" | "commit"; capability: string; connection: null | { kind: string; ownership: string; connectionId: null; label: string }; gate: string };

function definition(local: string, steps: Step0[], skillMd = SKILL) {
  const def = {
    localWorkflowId: local,
    workflowId: null,
    version: null,
    name: "Lead follow-ups",
    description: "Draft follow-ups for leads that went quiet.",
    trigger: { type: "manual", cron: null, timezone: null },
    steps,
    skillMd,
    factsKeys: [],
    limits: { maxItemsPerRun: 20, maxRunsPerDay: 3 },
  };
  // ADR 0104 / SPEC S2-06: sha256 of the JCS of the definition minus id/kind/createdAt/workflowId/version/definitionHash.
  const { workflowId: _w, version: _v, ...hashed } = def;
  return { def, hash: sha256Hex(jcs(hashed)) };
}

const STEPS: Step0[] = [
  { id: "read_thread", title: "Read the thread", detail: "Read the lead's last thread.", class: "read", capability: "mail.read", connection: { kind: "gmail", ownership: "company", connectionId: null, label: "Sales inbox" }, gate: "none" },
  { id: "draft", title: "Draft the follow-up", detail: "One short follow-up.", class: "draft", capability: "text.draft", connection: null, gate: "none" },
  { id: "send", title: "Send the follow-up", detail: "Send exactly the approved text.", class: "commit", capability: "mail.send", connection: { kind: "gmail", ownership: "company", connectionId: null, label: "Sales inbox" }, gate: "approval" },
];

const WEB_STEPS: Step0[] = [
  { id: "research", title: "Research the company", detail: "Read the company's site.", class: "read", capability: "web.research", connection: { kind: "other", ownership: "company", connectionId: null, label: "Web" }, gate: "none" },
  ...STEPS,
];

let seq = 0;

/** Ingests a proposal as `who`'s device and promotes it (admin) with the given bindings; returns the workflow id. */
async function promote(h: Harness, t: SeededTenant, steps: Step0[], bindings: Array<{ stepId: string; connectionId: string | null; disable: boolean }>): Promise<string> {
  const { def, hash } = definition(`wf_s209_${++seq}`, steps);
  const createdAt = h.clock.now();
  const obj = { id: ulid(createdAt), kind: "workflow_proposal", createdAt, ...def, definitionHash: hash };
  const p = t.people.member;
  const principal = { kind: "device" as const, tenantId: t.id, personId: p.id, deviceId: crypto.randomUUID(), accessRole: "member" as const, departmentScope: [], jurisdiction: "CA-ON" };
  await withTenant(h.db.app, { tenantId: t.id, principalId: principal.deviceId, principalPersonId: p.id, accessRole: "member" }, (tx) =>
    registry.syncHandlers!.workflow_proposal!(tx, obj, { principal, deps: h.deps }),
  );
  const [row] = await h.db.migrator`select id from workflows where tenant_id = ${t.id} and local_workflow_id = ${def.localWorkflowId}`;
  const id = row!.id as string;
  const admin = await asPrincipal(h, "admin", t);
  const r = await admin.post(`/v1/workflows/${id}/promote`, { jobRoleId: t.jobRoles.sdr, departmentId: t.departments.sales, fromVersion: 1, bindings });
  if (r.status !== 200) throw new Error(`promote ${r.status} ${JSON.stringify(r.json)}`);
  return id;
}

export async function rolePolicy(h: Harness, t: SeededTenant, over: Partial<{ sessionBudgetCents: number; allowed: string[]; approvers: string }> = {}) {
  const admin = await asPrincipal(h, "admin", t);
  const r = await admin.send("PUT", `/v1/policies/job-roles/${t.jobRoles.sdr}`, {
    jobRoleId: t.jobRoles.sdr,
    allowedCapabilities: over.allowed ?? ["mail.send"],
    approvers: over.approvers ?? "runner_or_dept_lead",
    sessionBudgetCents: over.sessionBudgetCents ?? 500,
    dailyBudgetCents: 5000,
    maxItemsPerBatch: 10,
    models: { design: "claude-opus-5-5", steps: "claude-sonnet-5-5" },
    updatedAt: h.clock.now(),
    updatedBy: t.people.admin.id,
  });
  if (r.status !== 200) throw new Error(`role policy ${r.status} ${JSON.stringify(r.json)}`);
}

export async function world(): Promise<World> {
  const h = await createHarness();
  const t = h.a;
  const db = h.db.migrator;
  const conn = async (kind: string, ref: string, label: string) =>
    ((await db`insert into connections (tenant_id, kind, ownership, label, provider, external_ref)
      values (${t.id}, ${kind}, 'company', ${label}, ${kind === "gmail" ? "mcp" : "composio"}, ${ref}) returning id`)[0]!.id as string);
  const readMail = await conn("gmail", MCP_URL, "Sales inbox (read)");
  const readPlain = await conn("gmail", "acct_not_a_url", "Old inbox");
  const sendMail = await conn("google_workspace_shared", "acct_sales_inbox", "Sales inbox (send)");
  const web = await conn("other", "docs.northzone.example, https://news.example.org/feed", "Web");
  const [ri] = await db`insert into role_identities (tenant_id, job_role_id, label, address, connection_id)
    values (${t.id}, ${t.jobRoles.sdr}, 'Sales inbox', 'sales@acme.example.com', ${sendMail}) returning id`;
  await db`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${t.id}, ${t.jobRoles.sdr}, ${t.people.member.id})`;
  await db`update tenants set monthly_worker_budget_cents = 100000 where id = ${t.id}`;
  await rolePolicy(h, t);
  const bind = [
    { stepId: "read_thread", connectionId: readMail, disable: false },
    { stepId: "send", connectionId: sendMail, disable: false },
  ];
  const wfId = await promote(h, t, STEPS, bind);
  const wfWebId = await promote(h, t, WEB_STEPS, [{ stepId: "research", connectionId: web, disable: false }, ...bind]);
  const fake = new FakeManagedAgents(h.clock.now);
  const workers = workersOf(h.deps.ports);
  workers.configure({ api: fake.api() });
  const broker = brokerOf(h.deps.ports);
  const composio = new FakeComposio();
  broker.configure({ executors: { composio: new ComposioCliExecutor(composio) } });
  return {
    h,
    t,
    fake,
    workers,
    broker,
    composio,
    conns: { readMail, readPlain, sendMail, web, roleIdentity: ri!.id as string },
    wf: { id: wfId, version: 1 },
    wfWeb: { id: wfWebId, version: 1 },
    as: (who, tt = t) => asPrincipal(h, who, tt),
    async close() {
      await workers.idle();
      workers.shutdown();
      await broker.idle();
      await h.close();
    },
  };
}

/** POST /v1/workers as `who` and wait for provisioning. */
export async function createWorker(w: World, over: Record<string, unknown> = {}, who: PersonKey = "admin") {
  const c = await w.as(who);
  const r = await c.post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 300, ...over });
  if (r.status !== 201) throw new Error(`create worker ${r.status} ${JSON.stringify(r.json)}`);
  await w.workers.idle();
  const g = await c.get(`/v1/workers?limit=200`);
  return g.json.items.find((x: { id: string }) => x.id === r.json.id) as Record<string, any>;
}

export function tx<T>(w: World, fn: (tx: Tx) => Promise<T>, t: SeededTenant = w.t): Promise<T> {
  return withTenant(w.h.db.app, { tenantId: t.id, accessRole: "system" }, fn);
}

// ---------- scripted sessions ----------

export const email = (to: string, subject = "Following up", body = `Hi,\nshort follow-up for ${to}.\nSam`) => ({
  capability: "mail.send",
  fields: [["to", to], ["subject", subject], ["body", body]],
});

export const running = { type: "session.status_running" };
export const endTurn = { type: "session.status_idle", stop_reason: { type: "end_turn" } };
export const budgetReached = { type: "session.status_idle", stop_reason: { type: "budget_reached" } };
export const requiresAction = (ids: string[]) => ({ type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ids } });

/** A session that reads one thread (MCP, confirmed), proposes `items`, reports and ends its turn. */
export function proposeScript(items: unknown[], o: { cost?: number; tool?: string; server?: string; summary?: string } = {}): Step[] {
  return [
    { await: "user.message" },
    { emit: [running, { id: "evt_mcp_1", type: "agent.mcp_tool_use", mcp_server_name: o.server ?? "gmail", name: o.tool ?? "search_emails", input: { query: "from:lead" }, evaluated_permission: "ask" }, requiresAction(["evt_mcp_1"])] },
    { await: "user.tool_confirmation", where: (e) => e.tool_use_id === "evt_mcp_1" },
    { emit: [running, { type: "agent.mcp_tool_result", mcp_tool_use_id: "evt_mcp_1", content: [{ type: "text", text: "Thread: Anna asked to talk next week." }] }, { id: "evt_prop_1", type: "agent.custom_tool_use", name: "offload_propose_batch", input: { items } }, requiresAction(["evt_prop_1"])] },
    { await: "user.custom_tool_result", where: (e) => e.custom_tool_use_id === "evt_prop_1" },
    { emit: [running, { id: "evt_rep_1", type: "agent.custom_tool_use", name: "offload_report", input: { summary: o.summary ?? "Drafted follow-ups." } }, requiresAction(["evt_rep_1"])] },
    { await: "user.custom_tool_result", where: (e) => e.custom_tool_use_id === "evt_rep_1" },
    { emit: [{ type: "session.usage", list_cost: { amount: String(o.cost ?? 42), currency: "USD" } }, endTurn], cost: o.cost ?? 42 },
  ];
}

/** Starts a manual run as `who` and waits until the session is consumed. */
export async function manualRun(w: World, workerId: string, inputs: Record<string, unknown> | undefined, who: PersonKey = "member") {
  const c = await w.as(who);
  const r = await c.post(`/v1/workers/${workerId}/runs`, inputs === undefined ? {} : { inputs });
  await w.workers.idle();
  if (r.status !== 201) return { status: r.status, json: r.json, run: null as Record<string, any> | null };
  const g = await c.get(`/v1/worker-runs/${r.json.id}`);
  return { status: r.status, json: r.json, run: g.json as Record<string, any> };
}

export async function overnightPolicy(w: World, over: Record<string, unknown> = {}): Promise<string> {
  const member = await w.as("member");
  const id = crypto.randomUUID();
  const r = await member.post("/v1/overnight-policies", {
    id,
    workflowId: w.wf.id,
    version: 1,
    mode: "preapproved",
    recipients: { emails: ["anna@northzone.com"], domains: [], repliesToThreadsStartedByIdentity: false },
    templateHash: sha256Hex(SKILL),
    maxCommitsPerNight: 5,
    maxPerRecipientPerWeek: 2,
    sendWindow: { startHour: 0, endHour: 24, days: [1, 2, 3, 4, 5, 6, 7], recipientTimezone: false },
    attachmentsAllowed: false,
    budgetCentsPerNight: 1000,
    dryRunNights: 0,
    dryRunNightsDone: 0,
    circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 2 },
    state: "active",
    trippedReason: null,
    ownerPersonId: w.t.people.member.id,
    ...over,
  });
  if (r.status !== 201) throw new Error(`overnight policy ${r.status} ${JSON.stringify(r.json)}`);
  return id;
}
