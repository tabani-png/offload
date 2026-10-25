// s10e work item 1, stub model: the demo sign-in is a deterministic simulation (idle -> waiting -> connected), kept
// in connect-sim.json, and counts as connected everywhere the brain computes connector status, only with the stub.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

import type { ConnectLinkDTO, ConnectorsResponse, DashboardResponse, ErrorResponse, WorkflowDetailDTO } from "../../src/api/types.ts";
import { DEFAULT_STUB_LINK_MS, readSim, simPath, stubLinkMs } from "../../src/connectors/link.ts";
import { BANNED_RE, FakeRunner, linkWorld, ok, type LinkWorld } from "./setup.ts";

let x: LinkWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

const link = (w: LinkWorld, id = "gmail", method = "GET", body?: unknown) => w.call<ConnectLinkDTO & ErrorResponse & { model?: string }>(`/connectors/${id}/link`, { method, ...(body === undefined ? {} : { body }) });

describe("s10e connect link: stub simulation", () => {
  test("GET before any POST is idle; POST starts a demo sign-in (waiting, no url, simulated, startedAt = now)", async () => {
    x = await linkWorld({ linkMs: 2000 });
    const idle = await link(x);
    expect(idle.status).toBe(200);
    expect(idle.body).toMatchObject({ connectorId: "gmail", name: "Gmail", state: "idle", url: null, simulated: true, startedAt: null, connectedAt: null, model: "stub" });
    const start = x.clock.now;
    const p = await link(x, "gmail", "POST", {});
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ state: "waiting", url: null, simulated: true, startedAt: start, connectedAt: null, via: "gmail-mcp" });
    expect(p.body.message).toBe("Demo sign-in: no browser opens and nothing is sent.");
    expect(existsSync(simPath(x.home))).toBe(false);
  });

  test("with an injected clock: still waiting just before linkMs, connected at linkMs, persisted 0600", async () => {
    x = await linkWorld({ linkMs: 2000 });
    const t0 = x.clock.now;
    await link(x, "gmail", "POST");
    x.clock.now = t0 + 1999;
    expect((await link(x)).body.state).toBe("waiting");
    x.clock.now = t0 + 2000;
    const c = await link(x);
    expect(c.body).toMatchObject({ state: "connected", connectedAt: t0 + 2000, startedAt: t0, simulated: true });
    expect(c.body.message).toContain("Gmail is connected");
    const file = JSON.parse(readFileSync(simPath(x.home), "utf8"));
    expect(file).toEqual({ version: 1, connected: { gmail: t0 + 2000 } });
    expect(statSync(simPath(x.home)).mode & 0o777).toBe(0o600);
  });

  test("POST on a connected id answers connected right away and starts nothing", async () => {
    x = await linkWorld({ linkMs: 0 });
    await link(x, "gmail", "POST");
    expect((await link(x)).body.state).toBe("connected");
    const again = await link(x, "gmail", "POST", { restart: true });
    expect(again.body.state).toBe("connected");
    expect(readSim(x.home)).toEqual({ gmail: x.clock.now });
  });

  test("a second POST while waiting keeps the first start; restart: true starts again", async () => {
    x = await linkWorld({ linkMs: 5000 });
    const t0 = x.clock.now;
    await link(x, "slack", "POST");
    x.clock.now = t0 + 1000;
    expect((await link(x, "slack", "POST")).body.startedAt).toBe(t0);
    expect((await link(x, "slack", "POST", { restart: true })).body.startedAt).toBe(t0 + 1000);
    expect((await link(x, "slack")).body.via).toBe("composio");
  });

  test("OFFLOAD_STUB_LINK_MS: an integer 0..60000, otherwise the 2000 ms default", () => {
    expect(DEFAULT_STUB_LINK_MS).toBe(2000);
    expect(stubLinkMs({})).toBe(2000);
    expect(stubLinkMs({ OFFLOAD_STUB_LINK_MS: "0" })).toBe(0);
    expect(stubLinkMs({ OFFLOAD_STUB_LINK_MS: "60000" })).toBe(60000);
    expect(stubLinkMs({ OFFLOAD_STUB_LINK_MS: "60001" })).toBe(2000);
    expect(stubLinkMs({ OFFLOAD_STUB_LINK_MS: "-1" })).toBe(2000);
    expect(stubLinkMs({ OFFLOAD_STUB_LINK_MS: "1.5" })).toBe(2000);
  });

  test("the env setting reaches the brain when no option is given", async () => {
    x = await linkWorld({ env: { OFFLOAD_STUB_LINK_MS: "0" } });
    await link(x, "gmail", "POST");
    expect((await link(x)).body.state).toBe("connected");
  });

  test("the stub never runs a command, even for a Composio connector", async () => {
    const runner = new FakeRunner(() => ok("https://example.com/x"));
    x = await linkWorld({ linkMs: 0, runner });
    await link(x, "google-calendar", "POST");
    await link(x, "google-calendar");
    expect(runner.calls).toEqual([]);
  });

  test("simulated gmail counts as connected in /connectors, /workflows/:id and /dashboard (stub only)", async () => {
    x = await linkWorld({ linkMs: 0 });
    await link(x, "gmail", "POST");
    await link(x);
    const conns = await x.call<ConnectorsResponse>("/connectors");
    expect(conns.body.catalog.find((c) => c.id === "gmail")).toMatchObject({ status: "connected", simulated: true, servers: [] });
    expect(conns.body.catalog.find((c) => c.id === "slack")).toMatchObject({ status: "missing", simulated: false });
    const ins = conns.body.insights.find((i) => i.connectors.some((c) => c.id === "gmail"))!;
    expect(ins.connectors.find((c) => c.id === "gmail")!.status).toBe("connected");
    const wf = await x.call<WorkflowDetailDTO>(`/workflows/${x.outreach.id}`);
    expect(wf.body.connectors.find((c) => c.id === "gmail")!.status).toBe("connected");
  });

  test("dashboard needsYou drops 'Connect Gmail' after the demo sign-in; the real model ignores the file and says so", async () => {
    x = await linkWorld({ linkMs: 0 });
    // Activate through a dry run so needsYou is computed (it only shows on active workflows).
    const dry = await x.call<{ batchHash: string }>(`/workflows/${x.outreach.id}/dry-run`, { method: "POST", body: { limit: 1 } });
    expect((await x.call(`/workflows/${x.outreach.id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } })).status).toBe(200);
    const pre = await x.call<DashboardResponse>("/dashboard");
    expect(pre.body.automations[0]!.needsYou).toContain("Connect Gmail so this can send.");
    await link(x, "gmail", "POST");
    await link(x);
    const post = await x.call<DashboardResponse>("/dashboard");
    expect(post.body.automations[0]!.needsYou).not.toContain("Connect Gmail so this can send.");
    expect(post.body.automations[0]!.state).toBe("active");

    x.rebuild({ modelLabel: "real", linkMs: 0, runner: new FakeRunner(() => ok("")) });
    expect(x.logs.some((l) => l.includes("connect-sim.json is ignored"))).toBe(true);
    const real = await x.call<DashboardResponse>("/dashboard");
    expect(real.body.automations[0]!.needsYou).toContain("Connect Gmail so this can send.");
    const conns = await x.call<ConnectorsResponse>("/connectors");
    expect(conns.body.catalog.find((c) => c.id === "gmail")).toMatchObject({ status: "missing" });
    expect(conns.body.catalog.find((c) => c.id === "gmail")!.simulated).toBeUndefined();
    expect((await x.call<WorkflowDetailDTO>(`/workflows/${x.outreach.id}`)).body.connectors.find((c) => c.id === "gmail")!.status).toBe("missing");
    expect((await link(x)).body).toMatchObject({ state: "idle", simulated: false });
  });

  test("a sim file with unknown ids or a bad shape counts nothing", async () => {
    x = await linkWorld({ linkMs: 0 });
    writeFileSync(simPath(x.home), JSON.stringify({ version: 1, connected: { nope: 1, gmail: "x" } }));
    expect(readSim(x.home)).toEqual({});
    writeFileSync(simPath(x.home), "{not json");
    expect(readSim(x.home)).toEqual({});
    expect((await x.call<ConnectorsResponse>("/connectors")).body.catalog.find((c) => c.id === "gmail")!.status).toBe("missing");
  });
});

describe("s10e connect link: routes", () => {
  test("unknown catalog id is 404 not_found (GET and POST)", async () => {
    x = await linkWorld();
    expect((await link(x, "outlook")).status).toBe(404);
    const p = await link(x, "outlook", "POST");
    expect(p.status).toBe(404);
    expect(p.body.error).toBe("not_found");
    expect((await link(x, "..%2Fetc")).status).toBe(404);
  });

  test("other methods are 405; POST stays refused on other connector paths", async () => {
    x = await linkWorld();
    for (const m of ["PUT", "DELETE", "PATCH"]) {
      const r = await link(x, "gmail", m);
      expect(r.status).toBe(405);
      expect(r.body.error).toBe("method_not_allowed");
    }
    expect((await x.call("/connectors", { method: "POST" })).status).toBe(405);
    expect((await x.call("/connectors/gmail", { method: "POST" })).status).toBe(405);
    expect((await x.call("/connectors/gmail/unlink", { method: "POST" })).status).toBe(405);
  });

  test("bad bodies are 400: unknown key, non-boolean restart, not JSON", async () => {
    x = await linkWorld();
    expect((await link(x, "gmail", "POST", { force: true })).status).toBe(400);
    expect((await link(x, "gmail", "POST", { restart: "yes" })).status).toBe(400);
    expect((await link(x, "gmail", "POST", [1])).status).toBe(400);
  });

  test("same auth and host checks as every route", async () => {
    x = await linkWorld();
    expect((await x.call("/connectors/gmail/link", { method: "POST", token: "w".repeat(40) })).status).toBe(401);
    expect((await x.call("/connectors/gmail/link", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await x.call("/connectors/gmail/link", { method: "POST", headers: { origin: "http://evil.example" } })).status).toBe(403);
  });

  test("every message the stub flow shows is plain words (no banned word)", async () => {
    x = await linkWorld({ linkMs: 1000 });
    const msgs = [(await link(x)).body.message, (await link(x, "gmail", "POST")).body.message];
    x.clock.now += 1000;
    msgs.push((await link(x)).body.message);
    for (const m of msgs) expect(m).not.toMatch(BANNED_RE);
    expect(msgs.every((m) => m.length > 0 && m.length < 140)).toBe(true);
  });
});

