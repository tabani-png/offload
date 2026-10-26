import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { COMMIT_NAME_RE, CUSTOM_TOOL_NAMES } from "../../src/modules/workers/tools.ts";
import { MCP_URL, WORKER, createWorker, rolePolicy, world, type World } from "./setup.ts";

let w: World;
let worker: Record<string, any>;

beforeAll(async () => {
  w = await world();
  w.workers.configure({
    credentials: async (c) => (c.id === w.conns.readMail ? { token: "tok_secret_read_only_123", mcpServerUrl: MCP_URL } : null),
  });
  worker = await createWorker(w, { schedule: { cron: "0 22 * * 1-5", timezone: "America/Toronto" } });
});
afterAll(() => w.close());

const body = (op: string, i = 0) => w.fake.ops(op)[i]!.body!;

describe("PROVISION", () => {
  test("PROVISION: POST /v1/workers answers 201 provisioning at once, then the orchestrator makes it ready", async () => {
    const admin = await w.as("admin");
    const r = await admin.post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 200 });
    expect(r.status).toBe(201);
    expect(r.json.state).toBe("provisioning");
    expect(r.json.externalRefs).toEqual({ agentId: "", agentVersion: 1, environmentId: "", deploymentId: null });
    expect(w.h.deps.validator.validate(WORKER, r.json)).toEqual({ ok: true });
    await w.workers.idle();
    const g = await admin.get("/v1/workers");
    const ready = g.json.items.find((x: { id: string }) => x.id === r.json.id);
    expect(ready.state).toBe("ready");
    expect(ready.externalRefs.agentId).toMatch(/^agent_/);
    expect(w.fake.violations).toEqual([]);
  });

  test("PROVISION: the worker DTO validates and carries its schedule, next run and external refs", () => {
    expect(w.h.deps.validator.validate(WORKER, worker)).toEqual({ ok: true });
    expect(worker.state).toBe("ready");
    expect(worker.schedule).toMatchObject({ cron: "0 22 * * 1-5", timezone: "America/Toronto" });
    expect(worker.schedule.nextRunAt).toBeGreaterThan(w.h.clock.now());
    expect(worker.externalRefs.environmentId).toMatch(/^env_/);
    expect(worker.externalRefs.deploymentId).toMatch(/^depl_/);
    expect(worker.sessionBudgetCents).toBe(300);
  });

  test("PROVISION: one environment per tenant: limited networking, allowed_hosts from the read connectors, MCP on, package managers off", () => {
    expect(w.fake.ops("environments.create")).toHaveLength(1);
    expect(body("environments.create").config).toEqual({
      type: "cloud",
      networking: { type: "limited", allowed_hosts: ["gmail-mcp.acme.example"], allow_mcp_servers: true, allow_package_managers: false },
    });
  });

  test("PROVISION: one vault per job role, holding read credentials only; the token never reaches a record or the database", async () => {
    expect(w.fake.ops("vaults.create")).toHaveLength(1);
    const creds = w.fake.ops("vaults.credentials.create");
    expect(creds).toHaveLength(1);
    expect(creds[0]!.body!.auth).toEqual({ type: "static_bearer", token: "[redacted]", mcp_server_url: MCP_URL });
    const dump = JSON.stringify(await w.h.db.migrator`select * from workers`) + JSON.stringify(await w.h.db.migrator`select * from worker_vaults`) + JSON.stringify(await w.h.db.migrator`select detail from audit_events`);
    expect(dump).not.toContain("tok_secret");
  });

  test("PROVISION: the agent gets SKILL.md, the role policy's model, one always_ask MCP toolset per read connector, and the custom tools", () => {
    const a = body("agents.create");
    expect(a.model).toBe("claude-sonnet-5-5");
    expect(a.system).toContain("Read the thread, draft one short follow-up per lead");
    expect(a.mcp_servers).toEqual([{ type: "url", name: "gmail", url: MCP_URL }]);
    const sets = a.tools.filter((t: { type: string }) => t.type === "mcp_toolset");
    expect(sets).toHaveLength(1);
    expect(sets[0].default_config).toEqual({ enabled: false, permission_policy: { type: "always_ask" } });
    expect(sets[0].configs.every((c: { permission_policy: unknown }) => JSON.stringify(c.permission_policy) === '{"type":"always_ask"}')).toBe(true);
    expect(a.tools.filter((t: { type: string }) => t.type === "custom").map((t: { name: string }) => t.name)).toEqual([...CUSTOM_TOOL_NAMES]);
  });

  test("PROVISION: no toolset in any recorded agent request names a commit-capable tool", () => {
    for (const r of w.fake.ops("agents.create")) {
      const names: string[] = [];
      for (const t of r.body!.tools) {
        if (t.type === "custom") names.push(t.name);
        if (t.type === "mcp_toolset") for (const c of t.configs) names.push(c.name);
      }
      expect(names.length).toBeGreaterThan(3);
      expect(names.filter((n) => COMMIT_NAME_RE.test(n))).toEqual([]);
    }
  });

  test("PROVISION: bash is always_ask and web tools are disabled without web.research", () => {
    const toolset = body("agents.create").tools.find((t: { type: string }) => t.type === "agent_toolset_20260401");
    expect(toolset.configs).toEqual([
      { name: "bash", enabled: true, permission_policy: { type: "always_ask" } },
      { name: "web_fetch", enabled: false },
      { name: "web_search", enabled: false },
    ]);
  });

  test("PROVISION: a web.research version gets web tools limited to its connection's domains", async () => {
    const before = w.fake.ops("agents.create").length;
    await createWorker(w, { workflowId: w.wfWeb.id });
    const a = w.fake.ops("agents.create")[before]!.body!;
    const toolset = a.tools.find((t: { type: string }) => t.type === "agent_toolset_20260401");
    expect(toolset.configs.slice(1)).toEqual([
      { name: "web_fetch", enabled: true, permission_policy: { type: "always_allow" }, allowed_domains: ["docs.northzone.example", "news.example.org"] },
      { name: "web_search", enabled: true, permission_policy: { type: "always_allow" }, allowed_domains: ["docs.northzone.example", "news.example.org"] },
    ]);
    // Same tenant, same job role: the environment and the vault are reused.
    expect(w.fake.ops("environments.create")).toHaveLength(1);
    expect(w.fake.ops("vaults.create")).toHaveLength(1);
  });

  test("PROVISION: the deployment carries the cron, timezone, budget and one initial user.message", () => {
    const d = body("deployments.create");
    expect(d.schedule).toEqual({ type: "cron", expression: "0 22 * * 1-5", timezone: "America/Toronto" });
    expect(d.budget).toEqual({ type: "limit", max_list_cost: { amount: "300", currency: "USD" } });
    expect(d.initial_events).toHaveLength(1);
    expect(d.initial_events[0].type).toBe("user.message");
    expect(d.agent).toEqual({ type: "agent", id: worker.externalRefs.agentId, version: 1 });
    expect(d.environment_id).toBe(worker.externalRefs.environmentId);
  });

  test("PROVISION: a session budget above the role policy's is refused", async () => {
    const r = await (await w.as("admin")).post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 501 });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/role policy/);
  });

  test("PROVISION: a read step bound to a connection without an https MCP endpoint fails provisioning in plain words", async () => {
    await w.h.db.migrator`update connections set external_ref = 'acct_not_a_url' where id = ${w.conns.readMail}`;
    try {
      const r = await (await w.as("admin")).post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100 });
      expect(r.status).toBe(201);
      await w.workers.idle();
      const g = await (await w.as("admin")).get("/v1/workers?limit=200");
      expect(g.json.items.find((x: { id: string }) => x.id === r.json.id).state).toBe("failed");
      const [a] = await w.h.db.migrator`select detail from audit_events where action = 'worker.provision_failed' and resource_id = ${r.json.id}`;
      expect(String(a!.detail.reason)).toMatch(/https MCP endpoint/);
    } finally {
      await w.h.db.migrator`update connections set external_ref = ${MCP_URL} where id = ${w.conns.readMail}`;
    }
  });

  test("PROVISION: unknown workflow, a proposal, or an identity outside the job role is 404 / 409", async () => {
    const admin = await w.as("admin");
    expect((await admin.post("/v1/workers", { workflowId: crypto.randomUUID(), version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100 })).status).toBe(404);
    expect((await admin.post("/v1/workers", { workflowId: w.wf.id, version: 9, identityId: w.conns.roleIdentity, sessionBudgetCents: 100 })).status).toBe(404);
    const r = await admin.post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.t.people.member2.id, sessionBudgetCents: 100 });
    expect(r.status).toBe(409);
    expect((await admin.post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100, extra: 1 })).status).toBe(400);
  });

  test("PROVISION: RBAC: a dept lead creates in their department only; member and auditor cannot create; auditor can list", async () => {
    const lead = await w.as("lead");
    expect((await lead.post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100 })).status).toBe(201);
    await w.workers.idle();
    await w.h.db.migrator`update people set dept_lead_of = ${[w.t.departments.finance]}::jsonb where id = ${w.t.people.lead.id}`;
    try {
      expect((await (await w.as("lead")).post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100 })).status).toBe(404);
      expect((await (await w.as("lead")).get("/v1/workers")).json.items).toEqual([]);
    } finally {
      await w.h.db.migrator`update people set dept_lead_of = ${[w.t.departments.sales]}::jsonb where id = ${w.t.people.lead.id}`;
    }
    expect((await (await w.as("member")).post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 100 })).status).toBe(403);
    expect((await (await w.as("auditor")).post("/v1/workers", {})).status).toBe(403);
    expect((await (await w.as("auditor")).get("/v1/workers")).json.items.length).toBeGreaterThan(0);
    // A member sees the workers of the job roles they hold; member2 (finance) holds none.
    expect((await (await w.as("member")).get("/v1/workers")).json.items.length).toBeGreaterThan(0);
    expect((await (await w.as("member2")).get("/v1/workers")).json.items).toEqual([]);
    // Another tenant sees nothing.
    expect((await (await w.as("admin", w.h.b)).get("/v1/workers")).json.items).toEqual([]);
  });

  test("PROVISION: creation is audited; changing the role policy's budget lowers what new workers may ask for", async () => {
    const [a] = await w.h.db.migrator`select detail from audit_events where action = 'worker.create' and resource_id = ${worker.id}`;
    expect(a!.detail).toMatchObject({ workflowId: w.wf.id, version: 1, sessionBudgetCents: 300 });
    await rolePolicy(w.h, w.t, { sessionBudgetCents: 100 });
    try {
      expect((await (await w.as("admin")).post("/v1/workers", { workflowId: w.wf.id, version: 1, identityId: w.conns.roleIdentity, sessionBudgetCents: 300 })).status).toBe(400);
    } finally {
      await rolePolicy(w.h, w.t);
    }
  });
});
