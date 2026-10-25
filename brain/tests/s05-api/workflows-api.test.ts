// s05 AC-7: workflow routes on the local API, end to end with the stub model and a fake Gmail.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { createBrain, type Brain } from "../../src/api/server.ts";
import type { ApproveResponse, ConnectorsResponse, DashboardResponse, DryRunResponse, ErrorResponse, InsightsResponse, RunResponse, WorkflowDetailDTO, WorkflowsResponse } from "../../src/api/types.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { FixtureMailSource } from "../../src/tone/mail-source.ts";
import { buildTonePack } from "../../src/tone/pack.ts";
import { ScriptedExecutor, sendEachItem } from "../../src/workflows/executor.ts";
import { tempHome } from "../helpers.ts";

const TOKEN = "t".repeat(40);
const SEND = "mcp__gmail__send_email";
let home = "";
let cleanup = () => {};
let brain: Brain;
let sent: Array<Record<string, unknown>> = [];

function req(path: string, init: { method?: string; body?: unknown; token?: string; raw?: string; type?: string } = {}): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? TOKEN}` };
  let body: string | undefined;
  if (init.raw !== undefined || init.body !== undefined) {
    body = init.raw ?? JSON.stringify(init.body);
    headers["content-type"] = init.type ?? "application/json";
  }
  return new Request(`http://127.0.0.1:4545${path}`, { method: init.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
}
async function call<T>(path: string, init: Parameters<typeof req>[1] = {}): Promise<{ status: number; body: T }> {
  const r = await brain.handle(req(path, init));
  return { status: r.status, body: (await r.json()) as T };
}

let wfId = "";
let insightId = "";

beforeAll(async () => {
  ({ home, cleanup } = tempHome());
  writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
  await buildTonePack({ home, source: new FixtureMailSource(), model: new StubModel(), models: DEFAULT_MODELS });
  writeFileSync(join(home, "connectors.json"), JSON.stringify({ version: 1, servers: { gmail: { type: "stdio", command: "npx", args: ["-y", "gmail-mcp"], envFromEnv: { GMAIL_OAUTH_PATH: "GMAIL_OAUTH_PATH" }, catalog: ["gmail"] } } }));
  brain = createBrain({
    home,
    token: TOKEN,
    now: () => Date.UTC(2026, 9, 19, 12),
    workflows: { model: new StubModel(), executor: new ScriptedExecutor({ [SEND]: async (i) => void sent.push(i) }, sendEachItem(SEND)), env: { GMAIL_OAUTH_PATH: "/tmp/creds.json" } },
  });
  insightId = (await call<InsightsResponse>("/insights")).body.insights[0]!.id;
});
afterAll(() => cleanup());

describe("s05 API: workflows", () => {
  test("POST /workflows/draft creates the workflow (201), again returns it (200)", async () => {
    const a = await call<WorkflowDetailDTO>("/workflows/draft", { method: "POST", body: { insightId } });
    expect(a.status).toBe(201);
    expect(a.body.state).toBe("ready_for_review");
    expect(a.body.steps.map((s) => s.type)).toEqual(["read", "read", "draft", "approval_gate", "send", "log"]);
    expect(a.body.skillMd).toContain("gates: [review]");
    expect(a.body.connectors.find((c) => c.id === "gmail")).toMatchObject({ status: "connected", required: true });
    wfId = a.body.id;
    writeFileSync(join(a.body.path, "facts.md"), FIXTURE_FACTS);
    writeFileSync(join(a.body.path, "recipients.csv"), "email,first_name,last_name,org,notes\nanna@northzone.com,Anna,Berg,Northzone,\nleo@hustlefund.vc,Leo,Park,Hustle Fund,\n");
    expect((await call("/workflows/draft", { method: "POST", body: { insightId } })).status).toBe(200);
  });

  test("bad bodies: missing insightId 400, wrong content-type 400, unknown insight 404, oversize 413", async () => {
    expect((await call<ErrorResponse>("/workflows/draft", { method: "POST", body: {} })).status).toBe(400);
    expect((await call<ErrorResponse>("/workflows/draft", { method: "POST", raw: JSON.stringify({ insightId }), type: "text/plain" })).status).toBe(400);
    expect((await call<ErrorResponse>("/workflows/draft", { method: "POST", body: { insightId: "ins_nope" } })).status).toBe(404);
    expect((await call<ErrorResponse>("/workflows/draft", { method: "POST", raw: JSON.stringify({ insightId, pad: "x".repeat(70_000) }) })).status).toBe(413);
  });

  test("GET /workflows and /workflows/:id; unknown id 404; GET-only paths still refuse POST", async () => {
    const list = await call<WorkflowsResponse>("/workflows");
    expect(list.body.workflows.map((w) => w.id)).toEqual([wfId]);
    expect((await call<WorkflowDetailDTO>(`/workflows/${wfId}`)).body.facts).toContain("company: Acme");
    expect((await call("/workflows/wf_nope0")).status).toBe(404);
    expect((await call("/workflows/../../etc")).status).toBe(404);
    expect((await call("/insights", { method: "POST" })).status).toBe(405);
    expect((await call(`/workflows/${wfId}`, { method: "POST" })).status).toBe(405);
  });

  test("POST /workflows/:id/dry-run returns drafts next to observed text, all side effects denied", async () => {
    const r = await call<DryRunResponse>(`/workflows/${wfId}/dry-run`, { method: "POST", body: { limit: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.instances).toHaveLength(3);
    expect(r.body.instances[0]!.draft).toContain("Muhammad");
    expect(r.body.instances[0]!.observed.excerpt).toContain("founder of Acme");
    expect(r.body.sideEffects.denied).toBe(r.body.sideEffects.attempted);
    expect((await call(`/workflows/${wfId}/dry-run`, { method: "POST", body: { limit: 0 } })).status).toBe(400);
  });

  test("run before approval is 409; approving the dry-run hash activates", async () => {
    expect((await call(`/workflows/${wfId}/run`, { method: "POST" })).status).toBe(409);
    const d = await call<WorkflowDetailDTO>(`/workflows/${wfId}`);
    const dryHash = d.body.batches.find((b) => b.kind === "dry_run")!.hash;
    expect((await call(`/workflows/${wfId}/approve`, { method: "POST", body: { batchHash: "abc" } })).status).toBe(400);
    expect((await call(`/workflows/${wfId}/approve`, { method: "POST", body: { batchHash: "0".repeat(64) } })).status).toBe(404);
    const a = await call<ApproveResponse>(`/workflows/${wfId}/approve`, { method: "POST", body: { batchHash: dryHash } });
    expect(a.body).toMatchObject({ kind: "dry_run", result: "activated" });
    expect(a.body.workflow.state).toBe("active");
  });

  test("run makes a pending batch (needs_you); approve sends exactly it in the background", async () => {
    const run = await call<RunResponse>(`/workflows/${wfId}/run`, { method: "POST" });
    expect(run.status).toBe(201);
    expect(run.body.items.map((i) => i.to)).toEqual(["anna@northzone.com", "leo@hustlefund.vc"]);
    const dash = await call<DashboardResponse>("/dashboard");
    expect(dash.body.automations[0]).toMatchObject({ state: "needs_you", status: "approved" });
    expect(sent).toEqual([]);
    const ap = await call<ApproveResponse>(`/workflows/${wfId}/approve`, { method: "POST", body: { batchHash: run.body.batch.hash } });
    expect(ap.body.result).toBe("sending");
    await brain.idle();
    expect(sent.map((s) => s.to)).toEqual(["anna@northzone.com", "leo@hustlefund.vc"]);
    const after = await call<WorkflowDetailDTO>(`/workflows/${wfId}`);
    expect(after.body.state).toBe("active");
    expect(after.body.batches.find((b) => b.hash === run.body.batch.hash)).toMatchObject({ state: "sent", sent: 2 });
    expect((await call(`/workflows/${wfId}/approve`, { method: "POST", body: { batchHash: run.body.batch.hash } })).status).toBe(409);
  });

  test("pause, resume and auto-run flags; DELETE removes the folder", async () => {
    expect((await call<{ state: string }>(`/workflows/${wfId}/pause`, { method: "POST" })).body.state).toBe("paused");
    expect((await call(`/workflows/${wfId}/run`, { method: "POST" })).status).toBe(409);
    expect((await call<{ state: string }>(`/workflows/${wfId}/resume`, { method: "POST" })).body.state).toBe("active");
    expect((await call(`/workflows/${wfId}/auto-run`, { method: "POST", body: { enabled: "yes" } })).status).toBe(400);
    expect((await call<{ autoRun: boolean }>(`/workflows/${wfId}/auto-run`, { method: "POST", body: { enabled: true } })).body.autoRun).toBe(true);
    expect((await call(`/workflows/${wfId}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/workflows/${wfId}`)).status).toBe(404);
    expect((await call<DashboardResponse>("/dashboard")).body.automations).toEqual([]);
  });

  test("GET /connectors shows servers, catalog status and readiness per insight", async () => {
    const r = await call<ConnectorsResponse>("/connectors");
    expect(r.body.configErrors).toEqual([]);
    expect(r.body.servers).toEqual([{ name: "gmail", transport: "stdio", catalog: ["gmail"], status: "connected", missingEnv: [] }]);
    expect(r.body.catalog.find((c) => c.id === "gmail")?.status).toBe("connected");
    expect(r.body.catalog.find((c) => c.id === "google-calendar")?.status).toBe("missing");
    const outreach = r.body.insights.find((i) => i.insightId === insightId)!;
    expect(outreach.ready).toBe(true);
    const sched = r.body.insights.find((i) => i.connectors.some((c) => c.id === "google-calendar"));
    expect(sched?.ready).toBe(false);
  });

  test("auth still applies to the new routes", async () => {
    expect((await call("/workflows", { token: "wrong".repeat(10) })).status).toBe(401);
    expect((await call("/workflows/draft", { method: "POST", body: { insightId }, token: "x".repeat(40) })).status).toBe(401);
  });
});
