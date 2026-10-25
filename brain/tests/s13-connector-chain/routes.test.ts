// s13 ROUTES: GET /connectors chains, GET /connectors/:id/status chain DTO and ?refresh=1, app target ids, the
// computer stop / session routes, real-mode probing only through injected fakes, plain words in every reason, and the
// whole send path through the chain (approve -> sendBatch -> fallback).
import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectLinkDTO, ConnectorsResponse, ComputerSessionDTO, ErrorResponse } from "../../src/api/types.ts";
import { createBrain } from "../../src/api/server.ts";
import { rememberTargets } from "../../src/connectors/chain.ts";
import { COMPOSIO_CLI_SERVER, ComposioCliExecutor } from "../../src/connectors/composio.ts";
import { targetForProfile } from "../../src/connectors/targets.ts";
import type { ExecJob, Executor } from "../../src/workflows/executor.ts";
import { profile } from "../helpers.ts";
import { connectGmail, s09bWorld, TOKEN, type S09bWorld } from "../s09b-brain/setup.ts";
import { writeRecipients } from "../s05-workflows/setup.ts";
import { BANNED_RE, composioCli, FakeLister, ok, okComputer } from "./setup.ts";

let x: S09bWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

const status = (w: S09bWorld, id: string, q = "") => w.call<ConnectLinkDTO & ErrorResponse>(`/connectors/${id}/status${q}`);

/** A brain on the world's home with injected chain fakes (nothing real is spawned). */
function rebrain(w: S09bWorld, o: { modelLabel?: "stub" | "real"; lister?: FakeLister; runner?: ReturnType<typeof composioCli>; executors?: Record<string, Executor>; always?: boolean; env?: Record<string, string> } = {}) {
  w.brain = createBrain({
    home: w.home,
    token: TOKEN,
    now: () => w.clock.now,
    workflows: { model: w.model, modelLabel: o.modelLabel ?? "stub", env: o.env ?? { GMAIL_OAUTH_PATH: "/tmp/creds.json" } },
    link: { linkMs: 0, runner: o.runner ?? composioCli() },
    chain: { deps: { mcp: o.lister ?? new FakeLister(() => ["send_email", "search_emails"]), computer: okComputer(), fetch: async () => new Response("{}") }, ...(o.executors === undefined ? {} : { executors: o.executors }), ...(o.always === true ? { always: true } : {}) },
    log: () => {},
  });
}

describe("s13 routes", () => {
  test("ROUTES: GET /connectors/:id/status carries the chain: method, health, capabilities, next, every method's reason", async () => {
    x = await s09bWorld();
    connectGmail(x.home);
    const r = await status(x, "gmail");
    expect(r.status).toBe(200);
    expect(r.body.chain).toMatchObject({ targetId: "gmail", method: "mcp", next: "composio", health: "ok", simulated: true, capabilities: { writes: ["mail.send"] } });
    expect(r.body.chain!.methods.map((m) => [m.method, m.health])).toEqual([
      ["mcp", "ok"],
      ["composio", "ok"],
      ["api", "skipped"],
      ["computer", "ok"],
    ]);
    for (const m of r.body.chain!.methods) if (m.reason !== null) expect(m.reason).not.toMatch(BANNED_RE);
    // The /link poll answers the same chain.
    expect((await x.call<ConnectLinkDTO>("/connectors/gmail/link")).body.chain).toEqual(r.body.chain);
  });

  test("ROUTES: ?refresh=1 re-probes; otherwise the cached decision is reused", async () => {
    x = await s09bWorld();
    const a = (await status(x, "slack")).body.chain!;
    x.clock.now += 60_000;
    expect((await status(x, "slack")).body.chain!.decidedAt).toBe(a.decidedAt);
    expect((await status(x, "slack", "?refresh=1")).body.chain!.decidedAt).toBe(a.decidedAt + 60_000);
  });

  test("ROUTES: GET /connectors lists a chain for every catalog id and for app targets the insights touch", async () => {
    x = await s09bWorld();
    const r = await x.call<ConnectorsResponse>("/connectors");
    expect(r.status).toBe(200);
    const ids = r.body.chains!.map((c) => c.targetId);
    for (const id of ["gmail", "google-calendar", "google-sheets", "slack", "notion", "hubspot", "attio", "zoom", "linkedin"]) expect(ids).toContain(id);
    // Apps of the fixture week the catalog does not know show up as app targets.
    for (const c of r.body.chains!.filter((c) => !c.catalog)) {
      expect(c.targetId).toMatch(/^(app|web)-/);
      expect(c.methods.map((m) => m.method)).toEqual(["composio", "api", "computer"]);
    }
  });

  test("ROUTES: an app target id works once it is known (status, connect); unknown ids stay 404", async () => {
    x = await s09bWorld();
    expect((await status(x, "app-quickbooks-online")).status).toBe(404);
    rememberTargets(x.home, [targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks Online", host: "" }))]);
    const r = await status(x, "app-quickbooks-online");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connectorId: "app-quickbooks-online", name: "QuickBooks Online", methods: ["composio", "api", "computer"] });
    expect(r.body.chain).toMatchObject({ catalog: false, method: "computer" });
    const link = await x.call<ConnectLinkDTO>("/connectors/app-quickbooks-online/link", { method: "POST", body: { method: "composio" } });
    expect(link.body).toMatchObject({ state: "waiting", method: "composio", simulated: true });
  });

  test("ROUTES: real model: /status probes through the injected fakes; /link never probes", async () => {
    x = await s09bWorld();
    connectGmail(x.home);
    const lister = new FakeLister(() => ["send_email"]);
    const runner = composioCli();
    rebrain(x, { modelLabel: "real", lister, runner });
    await x.call("/connectors/gmail/link");
    expect(lister.calls).toHaveLength(0);
    const r = await status(x, "gmail");
    expect(r.body.chain).toMatchObject({ method: "mcp", next: "composio", simulated: false });
    expect(lister.calls).toHaveLength(1);
    expect(runner.calls.every((c) => c.argv[0] === "composio")).toBe(true);
    // The chain now makes Gmail connected for approval, also without a configured server (Composio CLI only).
  });

  test("ROUTES: real model: a connector reachable only through the Composio CLI counts as connected once probed", async () => {
    x = await s09bWorld();
    rebrain(x, { modelLabel: "real" });
    const before = await x.call<ConnectorsResponse>("/connectors");
    expect(before.body.catalog.find((c) => c.id === "gmail")!.status).toBe("missing");
    expect((await status(x, "gmail")).body.chain!.method).toBe("composio");
    const after = await x.call<ConnectorsResponse>("/connectors");
    expect(after.body.catalog.find((c) => c.id === "gmail")!.status).toBe("connected");
    await x.brain.idle();
  });

  test("ROUTES: real model: after a Composio sign-in the Composio CLI path connects the app without a Composio server", async () => {
    x = await s09bWorld();
    const runner = composioCli({ link: (argv) => (argv.includes("--list") ? ok('[{"status":"ACTIVE"}]') : ok("https://connect.composio.dev/link/abc")) });
    rebrain(x, { modelLabel: "real", runner });
    const start = await x.call<ConnectLinkDTO>("/connectors/gmail/link", { method: "POST", body: { method: "composio" } });
    expect(start.body).toMatchObject({ state: "waiting", url: "https://connect.composio.dev/link/abc" });
    const polled = await x.call<ConnectLinkDTO>("/connectors/gmail/link");
    expect(polled.body).toMatchObject({ state: "connected", method: "composio" });
    expect(runner.calls.some((c) => c.argv.join(" ") === "composio connections list --toolkit gmail")).toBe(true);
    expect(runner.calls.some((c) => c.argv[1] === "execute")).toBe(false);
  });

  test("ROUTES: POST /computer/stop and GET /computer/session; other methods are 405", async () => {
    x = await s09bWorld();
    const stop = await x.call<{ stopped: boolean; session: ComputerSessionDTO }>("/computer/stop", { method: "POST" });
    expect(stop.body).toMatchObject({ stopped: false, session: { running: false, pointer: null } });
    const s = await x.call<ComputerSessionDTO>("/computer/session");
    expect(s.body).toMatchObject({ running: false, workflowId: null, stopped: false });
    expect((await x.call("/computer/stop")).status).toBe(405);
    expect((await x.call("/computer/session", { method: "POST" })).status).toBe(405);
    expect((await x.call("/computer/session", { token: "w".repeat(40) })).status).toBe(401);
  });

  test("ROUTES: approve -> send goes through the chain: MCP fails, Composio sends the rest, the chain says so", async () => {
    x = await s09bWorld();
    connectGmail(x.home);
    writeRecipients(x.home, x.outreach.id, ["anna@northzone.com,Anna,Berg,Northzone,", "leo@hustlefund.vc,Leo,Park,Hustle Fund,"]);
    let mcpCalls = 0;
    const brokenMcp: Executor = {
      async execute(job: ExecJob) {
        mcpCalls += 1;
        expect(job.mcpServers).toHaveProperty("gmail");
        throw new Error("spawn npx ENOENT");
      },
    };
    const runner = composioCli();
    rebrain(x, { runner, executors: { mcp: brokenMcp, composio: new ComposioCliExecutor({ runner, env: {}, accounts: { gmail: "gmail_live-one" } }) }, always: true });
    const w = x;
    const dry = await w.call<{ batchHash: string }>(`/workflows/${w.outreach.id}/dry-run`, { method: "POST", body: { limit: 1 } });
    expect((await w.call(`/workflows/${w.outreach.id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } })).status).toBe(200);
    const run = await w.call<{ batch: { hash: string } }>(`/workflows/${w.outreach.id}/run`, { method: "POST" });
    expect(run.status).toBe(201);
    // The stub world's gmail is a real connectors.json server, so live approval is allowed (not a demo sign-in).
    const ap = await w.call(`/workflows/${w.outreach.id}/approve`, { method: "POST", body: { batchHash: run.body.batch.hash } });
    expect(ap.status).toBe(200);
    await w.brain.idle();
    expect(mcpCalls).toBe(1);
    const sends = runner.calls.filter((c) => c.argv[1] === "execute").map((c) => (JSON.parse(c.argv[4]!) as { recipient_email: string }).recipient_email);
    expect(sends.sort()).toEqual(["anna@northzone.com", "leo@hustlefund.vc"]);
    const chain = (await status(w, "gmail")).body.chain!;
    expect(chain).toMatchObject({ method: "composio", next: "computer" });
    expect(chain.methods[0]).toMatchObject({ method: "mcp", health: "failed", lastError: "spawn npx ENOENT" });
    expect(COMPOSIO_CLI_SERVER).toBe("composio_cli");
  });
});
