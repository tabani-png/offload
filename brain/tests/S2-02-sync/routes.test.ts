// ROUTES: the local sync routes need the bearer token (and the loopback Host); GET /sync/preview is exactly the next
// envelope the brain sends; share previews first and queues only on ?confirm=1.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBrain, type Brain } from "../../src/api/server.ts";
import { StubModel } from "../../src/models/model.ts";
import { verifyEs256 } from "../../src/sync/device.ts";
import { Outbox } from "../../src/sync/outbox.ts";
import type { SyncEnvelope, WorkflowProposal } from "../../src/sync/types.ts";
import { tempHome } from "../helpers.ts";
import { NOTICE_1 } from "./fake-control.ts";
import { browser, fixtureSyncWorld, loopbackFetch, type FixtureSyncWorld } from "./setup.ts";

const TOKEN = "s".repeat(40);
let w: FixtureSyncWorld;
let brain: Brain;

async function call<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; token?: string | null; host?: string } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.host !== undefined) headers.host = init.host;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const r = await brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }));
  return { status: r.status, body: (await r.json()) as T };
}

beforeEach(async () => {
  w = await fixtureSyncWorld();
  brain = createBrain({ home: w.home, token: TOKEN, now: () => w.clock.now, workflows: { model: new StubModel(), env: {} }, sync: { controlUrl: w.control.url, fetch: loopbackFetch, openUrl: browser, log: () => {}, analysis: async () => w.fixture.analysis, timezone: "America/Toronto" } });
});
afterEach(() => w.cleanup());

const connectViaApi = async () => {
  const r = await call<{ state: string; authorizeUrl: string }>("/sync/connect", { method: "POST" });
  expect(r.status).toBe(202);
  await brain.sync.connectIdle();
};

describe("auth", () => {
  test("ROUTES: every sync route refuses a missing or wrong bearer token with 401", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/sync/status"],
      ["POST", "/sync/connect"],
      ["POST", "/sync/pause"],
      ["POST", "/sync/resume"],
      ["GET", "/sync/preview"],
      ["POST", "/sync/notice/ack"],
      ["POST", `/workflows/${w.fixture.outreach.id}/share`],
      ["POST", `/workflows/${w.fixture.outreach.id}/share?confirm=1`],
    ];
    for (const [method, path] of routes) {
      expect((await call(path, { method, token: null })).status).toBe(401);
      expect((await call(path, { method, token: "x".repeat(40) })).status).toBe(401);
    }
    expect(w.control.calls).toEqual([]);
    expect(new Outbox(w.home).list(w.clock.now)).toEqual([]);
  });

  test("ROUTES: a foreign Host is refused before the token is even checked", async () => {
    expect((await call("/sync/status", { host: "evil.example" })).status).toBe(403);
  });

  test("ROUTES: wrong methods are 405 and unknown sync paths 404", async () => {
    expect((await call("/sync/connect")).status).toBe(405);
    expect((await call("/sync/status", { method: "POST" })).status).toBe(405);
    expect((await call(`/workflows/${w.fixture.outreach.id}/share`)).status).toBe(405);
    expect((await call("/sync/nope")).status).toBe(404);
  });
});

describe("flows", () => {
  test("ROUTES: status before and after connect; without a control URL the client is not_configured and connect is 409", async () => {
    expect((await call<{ state: string }>("/sync/status")).body.state).toBe("not_connected");
    await connectViaApi();
    const st = await call<{ state: string; deviceId: string }>("/sync/status");
    expect(st.body.state).toBe("connected");
    expect(st.body.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    const t = tempHome();
    try {
      const bare = createBrain({ home: t.home, token: TOKEN, workflows: { model: new StubModel(), env: {} }, sync: { env: {}, fetch: async () => Promise.reject(new Error("no network")) } });
      const r = await bare.handle(new Request("http://127.0.0.1:4545/sync/status", { headers: { authorization: `Bearer ${TOKEN}` } }));
      expect(((await r.json()) as { state: string }).state).toBe("not_configured");
      const c = await bare.handle(new Request("http://127.0.0.1:4545/sync/connect", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }));
      expect(c.status).toBe(409);
    } finally {
      t.cleanup();
    }
  });

  test("ROUTES: notice ack validates its body and must name the required notice version", async () => {
    await connectViaApi();
    expect((await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: "nope" } })).status).toBe(400);
    expect((await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1, extra: 1 } })).status).toBe(400);
    expect((await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: "99999999-9999-4999-8999-999999999999" } })).status).toBe(409);
    const ok = await call<{ ack: { kind: string; noticeVersionId: string } }>("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1 } });
    expect(ok.status).toBe(201);
    expect(ok.body.ack).toMatchObject({ kind: "notice_ack", noticeVersionId: NOTICE_1 });
  });

  test("ROUTES: GET /sync/preview is byte for byte the next envelope the brain sends", async () => {
    await connectViaApi();
    await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1 } });
    const p = await call<{ envelope: SyncEnvelope; body: string; held: number }>("/sync/preview");
    expect(p.status).toBe(200);
    expect(p.body.envelope.seq).toBe(1);
    expect(p.body.envelope.objects[0]!.kind).toBe("notice_ack");
    expect(p.body.envelope.objects.length).toBeGreaterThan(1);
    // A preview sends nothing.
    expect(w.control.received).toHaveLength(0);
    await brain.sync.flush({ force: true });
    const sent = w.control.received[0]!;
    expect(sent.body).toBe(p.body.body);
    expect(JSON.parse(sent.body)).toEqual(p.body.envelope);
    const jwk = w.control.devices.get(p.body.envelope.deviceId)!.jwk;
    expect(await verifyEs256(jwk, new TextEncoder().encode(p.body.body), sent.headers.get("offload-signature")!.split("sig=")[1]!)).toBe(true);
    // The next preview shows the next seq and nothing already sent.
    const p2 = await call<{ envelope: SyncEnvelope | null }>("/sync/preview");
    expect(p2.body.envelope).toBeNull();
  });

  test("ROUTES: pause and resume flip the state; a paused preview holds everything", async () => {
    await connectViaApi();
    await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1 } });
    expect((await call<{ state: string; paused: boolean }>("/sync/pause", { method: "POST" })).body).toMatchObject({ state: "paused", paused: true });
    const p = await call<{ envelope: SyncEnvelope | null; held: number }>("/sync/preview");
    expect(p.body.envelope).toBeNull();
    expect(p.body.held).toBeGreaterThan(0);
    expect((await call<{ state: string }>("/sync/resume", { method: "POST" })).body.state).toBe("connected");
    expect((await call<{ envelope: SyncEnvelope | null }>("/sync/preview")).body.envelope).not.toBeNull();
  });

  test("ROUTES: share returns the proposal JSON for preview; ?confirm=1 queues exactly it", async () => {
    await connectViaApi();
    await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1 } });
    const id = w.fixture.outreach.id;
    const pv = await call<{ confirmed: boolean; proposal: WorkflowProposal }>(`/workflows/${id}/share`, { method: "POST" });
    expect(pv.status).toBe(200);
    expect(pv.body.confirmed).toBe(false);
    expect(pv.body.proposal.kind).toBe("workflow_proposal");
    expect(new Outbox(w.home).list(w.clock.now).some((e) => e.kind === "workflow_proposal")).toBe(false);
    expect((await call(`/workflows/${id}/share?confirm=1&hash=${"0".repeat(64)}`, { method: "POST" })).status).toBe(409);
    expect((await call(`/workflows/${id}/share?confirm=1&hash=zz`, { method: "POST" })).status).toBe(400);
    const ok = await call<{ confirmed: boolean; proposal: WorkflowProposal }>(`/workflows/${id}/share?confirm=1&hash=${pv.body.proposal.definitionHash}`, { method: "POST" });
    expect(ok.status).toBe(201);
    expect(ok.body.proposal).toEqual(pv.body.proposal);
    await brain.sync.flush({ force: true });
    expect(w.control.acceptedObjects().filter((o) => o.kind === "workflow_proposal")).toEqual([pv.body.proposal]);
    expect((await call("/workflows/wf_doesnotexist/share", { method: "POST" })).status).toBe(404);
  });

  test("ROUTES: share and preview before connect are 409, never a request to the control plane", async () => {
    expect((await call(`/workflows/${w.fixture.outreach.id}/share?confirm=1`, { method: "POST" })).status).toBe(409);
    expect((await call("/sync/preview")).status).toBe(409);
    expect((await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1 } })).status).toBe(409);
    expect(w.control.calls).toEqual([]);
  });

  test("ROUTES: a run ending in the background triggers a flush (afterRun)", async () => {
    await connectViaApi();
    await call("/sync/notice/ack", { method: "POST", body: { noticeVersionId: NOTICE_1 } });
    const r = await brain.sync.afterRun();
    expect(r.accepted).toBeGreaterThan(0);
    expect(w.control.received).toHaveLength(1);
  });
});
