// s17 CONNECTIONS + SECRETS + BUILD: the Connections center routes (search any app, methods, one-time setup, read-only
// test), the rule that the brain only ever holds a Keychain or env reference, and the hand-off to the s14 builder.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectionBuildDTO, ConnectionDetailDTO, ConnectionsResponse, ConnectionTestDTO, ConnectLinkDTO, ErrorResponse, UniverseStatusDTO } from "../../src/api/types.ts";
import { createBrain, type Brain } from "../../src/api/server.ts";
import { isReadOnlyComposioArgv } from "../../src/connectors/composio.ts";
import { connectionsPath, connectionIdFor, keychainRefFor, readConnections } from "../../src/connectors/connections.ts";
import type { LinkRunResult } from "../../src/connectors/link.ts";
import { syncUniverse } from "../../src/connectors/universe.ts";
import { StubModel } from "../../src/models/model.ts";
import { listBatches, readApprovals, readWorkflow } from "../../src/workflows/store.ts";
import { FakeLister, FakeSecrets, fakeFetch } from "../s13-connector-chain/setup.ts";
import { freshHome, NOW as S14_NOW } from "../s14-any-task-workflows/setup.ts";
import { FakeRunner, NOW, ok, SECRET, syncedHome, tempHome, TOKEN, universeCli } from "./setup.ts";

interface World {
  home: string;
  brain: Brain;
  runner: FakeRunner;
  lister: FakeLister;
  secrets: FakeSecrets;
  fetches: ReturnType<typeof fakeFetch>;
  logs: string[];
  call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T; text: string }>;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const KC = (id: string) => ({ keychain: keychainRefFor(id) });

async function world(o: { modelLabel?: "stub" | "real"; home?: string; now?: number; runner?: FakeRunner; v2?: boolean } = {}): Promise<World> {
  const runner = o.runner ?? universeCli();
  let home = o.home;
  if (home === undefined) home = (await syncedHome()).home;
  else await syncUniverse({ home, runner: universeCli(), env: {}, now: () => o.now ?? NOW, seeds: ["e", "o"] });
  const lister = new FakeLister(() => ["list_issues", "create_issue", "delete_issue"]);
  const secrets = new FakeSecrets({ [`${keychainRefFor("tk-linear").service}/api-key`]: SECRET });
  const fetches = fakeFetch(() => new Response(JSON.stringify({ viewer: { id: "u1" } }), { status: 200 }));
  const logs: string[] = [];
  const brain = createBrain({
    home,
    token: TOKEN,
    now: () => o.now ?? NOW,
    ...(o.v2 === true ? { analyze: { understanding: "v2" as const } } : {}),
    workflows: { model: new StubModel(), modelLabel: o.modelLabel ?? "stub", env: { PATH: "/usr/bin" } },
    link: { linkMs: 0, runner },
    chain: { deps: { mcp: lister, secrets, fetch: fetches.fetch } },
    log: (l) => void logs.push(l),
  });
  const w: World = {
    home,
    brain,
    runner,
    lister,
    secrets,
    fetches,
    logs,
    async call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] = "application/json";
      }
      const r = await w.brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method: init.method ?? "GET", headers, ...(body === undefined ? {} : { body }) }));
      const text = await r.text();
      return { status: r.status, body: JSON.parse(text) as T, text };
    },
  };
  return w;
}

const post = <T>(w: World, path: string, body: unknown = {}) => w.call<T>(path, { method: "POST", body });

/** Every file under the home, as text (for "no secret anywhere"). */
function allText(dir: string): string {
  let out = "";
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) out += allText(p);
    else if (statSync(p).size < 5_000_000) out += readFileSync(p, "latin1");
  }
  return out;
}

describe("s17 connections", () => {
  test("CONNECTIONS: GET /connections lists the hand-verified catalog first, then every Composio app, never the meta toolkit", async () => {
    const w = await world();
    const r = await w.call<ConnectionsResponse>("/connections");
    expect(r.status).toBe(200);
    const rows = r.body.connections;
    const firstUniverse = rows.findIndex((x) => !x.verified);
    expect(firstUniverse).toBeGreaterThan(0);
    for (const x of rows.slice(0, firstUniverse)) expect(x.verified).toBe(true);
    const ids = rows.map((x) => x.id);
    expect(ids).toContain("gmail");
    expect(ids).toContain("tk-linear");
    expect(ids).toContain("tk-freshdesk");
    expect(ids).not.toContain("tk-composio");
    expect(ids).not.toContain("tk-gmail");
    expect(r.body.universe).toMatchObject({ toolkits: 10, stale: false });
    expect(rows.find((x) => x.id === "tk-linear")).toMatchObject({ name: "Linear", toolkit: "linear", status: "not_set_up", verified: false });
  });

  test("CONNECTIONS: search finds any app by name, slug or description, best match first", async () => {
    const w = await world();
    expect((await w.call<ConnectionsResponse>("/connections?q=linear")).body.connections[0]!.id).toBe("tk-linear");
    expect((await w.call<ConnectionsResponse>("/connections?q=Gmail")).body.connections[0]!.id).toBe("gmail");
    expect((await w.call<ConnectionsResponse>("/connections?q=ticketing")).body.connections.map((x) => x.id)).toContain("tk-freshdesk");
    expect((await w.call<ConnectionsResponse>("/connections?q=zzzz-nothing")).body.connections).toEqual([]);
    expect((await w.call<ErrorResponse>(`/connections?q=${"x".repeat(200)}`)).status).toBe(400);
  });

  test("CONNECTIONS: every row has a status dot: connected, needs you, or not set up", async () => {
    const w = await world();
    writeFileSync(join(w.home, "connectors.json"), JSON.stringify({ version: 1, servers: { gmail: { type: "stdio", command: "npx", args: ["-y", "gmail-mcp"], envFromEnv: {}, catalog: ["gmail"] } } }));
    await post(w, "/connections/tk-stripe/setup", { method: "api_key", secret: KC("tk-stripe") });
    const rows = (await w.call<ConnectionsResponse>("/connections")).body.connections;
    const st = Object.fromEntries(rows.map((x) => [x.id, x.status]));
    expect(st.gmail).toBe("connected");
    expect(st["tk-stripe"]).toBe("needs_you");
    expect(st["tk-linear"]).toBe("not_set_up");
  });

  test("CONNECTIONS: the detail lists the setup methods the app can use, with tool counts by class", async () => {
    const w = await world({ modelLabel: "real" });
    const r = await w.call<ConnectionDetailDTO>("/connections/tk-linear");
    expect(r.status).toBe(200);
    expect(r.body.methods.map((m) => m.method)).toEqual(["composio", "api_key", "mcp"]);
    expect(r.body.methods.every((m) => m.title.length > 0 && m.steps.length > 0)).toBe(true);
    expect(r.body.tools.commit).toBeGreaterThan(0);
    expect(r.body.tools.read).toBeGreaterThan(0);
    expect(r.body.sample.commit).toContain("Create issue");
    for (const m of r.body.methods) for (const s of [m.title, ...m.steps]) expect(s).not.toMatch(/token|json|env|mcp|gate|skill/i);
    // The auth modes came from the read-only `dev toolkits info`.
    expect(w.runner.calls.some((c) => c.argv.join(" ") === "composio dev toolkits info linear")).toBe(true);
  });

  test("CONNECTIONS: an app without key sign-in offers Composio and a connector server, not a pasted key", async () => {
    const w = await world({ modelLabel: "real" });
    const r = await w.call<ConnectionDetailDTO>("/connections/tk-freshdesk");
    expect(r.body.methods.map((m) => m.method)).toEqual(["composio", "mcp"]);
  });

  test("CONNECTIONS: an unknown id is 404, other HTTP methods 405", async () => {
    const w = await world();
    expect((await w.call<ErrorResponse>("/connections/tk-nope")).status).toBe(404);
    expect((await w.call<ErrorResponse>("/connections/tk-composio")).status).toBe(404);
    expect((await w.call<ErrorResponse>("/connections/tk-linear", { method: "DELETE" })).status).toBe(405);
    expect((await w.call<ErrorResponse>("/connections/tk-linear/setup")).status).toBe(405);
    expect((await post<ErrorResponse>(w, "/connections/tk-linear/setup", { method: "carrier-pigeon" })).status).toBe(400);
  });

  test("CONNECTIONS: Composio sign-in reuses the s10e link hand-off and becomes connected through the status poll", async () => {
    const w = await world();
    const r = await post<ConnectLinkDTO>(w, "/connections/tk-linear/setup", { method: "composio" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connectorId: "tk-linear", method: "composio", simulated: true });
    const s = await w.call<ConnectLinkDTO>("/connectors/tk-linear/status");
    expect(s.body.state).toBe("connected");
    expect((await w.call<ConnectionDetailDTO>("/connections/tk-linear")).body.status).toBe("connected");
  });

  test("CONNECTIONS: real model Composio sign-in runs `composio link <toolkit> --no-browser --no-wait` and hands back the URL", async () => {
    const w = await world({ modelLabel: "real" });
    const r = await post<ConnectLinkDTO>(w, "/connections/tk-linear/setup", { method: "composio" });
    expect(r.body.state).toBe("waiting");
    expect(r.body.url).toBe("https://connect.composio.dev/link/ln_test");
    expect(w.runner.calls.some((c) => c.argv.join(" ") === "composio link linear --no-browser --no-wait")).toBe(true);
  });

  test("CONNECTIONS: an API key setup stores only the Keychain reference, privately", async () => {
    const w = await world();
    const r = await post<ConnectionDetailDTO>(w, "/connections/tk-linear/setup", { method: "api_key", secret: KC("tk-linear"), baseUrl: "https://api.linear.app", healthPath: "/graphql/health" });
    expect(r.status).toBe(200);
    expect(r.body.setup).toMatchObject({ method: "api_key", secretRef: "Keychain: offload.connection.tk-linear" });
    expect(statSync(connectionsPath(w.home)).mode & 0o777).toBe(0o600);
    const rec = readConnections(w.home)["tk-linear"]!;
    expect(rec.api?.secret).toEqual(KC("tk-linear"));
    expect(rec.api?.baseUrl).toBe("https://api.linear.app");
  });

  test("CONNECTIONS: a connector server (https URL) is stored with header references and tested with tools/list", async () => {
    const w = await world({ modelLabel: "real" });
    const r = await post<ConnectionDetailDTO>(w, "/connections/tk-linear/setup", { method: "mcp", url: "https://mcp.linear.app/mcp", headers: { Authorization: KC("tk-linear") } });
    expect(r.status).toBe(200);
    expect(r.body.setup?.test).toMatchObject({ ok: true, tools: 3 });
    expect(r.body.status).toBe("connected");
    expect(w.lister.calls.at(-1)!.server).toMatchObject({ type: "http", url: "https://mcp.linear.app/mcp" });
    // The header value is resolved in memory for the probe only.
    expect((w.lister.calls.at(-1)!.server as { headers?: Record<string, string> }).headers?.Authorization).toBe(SECRET);
    expect(readFileSync(connectionsPath(w.home), "utf8")).not.toContain(SECRET);
  });

  test("CONNECTIONS: a connector server command is stored with env references", async () => {
    const w = await world({ modelLabel: "real" });
    const r = await post<ConnectionDetailDTO>(w, "/connections/tk-linear/setup", { method: "mcp", command: "npx", args: ["-y", "@acme/linear-mcp"], env: { LINEAR_API_KEY: KC("tk-linear") } });
    expect(r.status).toBe(200);
    const rec = readConnections(w.home)["tk-linear"]!;
    expect(rec.server).toMatchObject({ type: "stdio", command: "npx", args: ["-y", "@acme/linear-mcp"] });
    expect(w.lister.calls.at(-1)!.server).toMatchObject({ type: "stdio", command: "npx" });
  });

  test("CONNECTIONS: a plain http URL (not this Mac) is refused", async () => {
    const w = await world();
    expect((await post<ErrorResponse>(w, "/connections/tk-linear/setup", { method: "mcp", url: "http://mcp.linear.app/mcp" })).status).toBe(400);
  });

  test("CONNECTIONS: the read-only test of a Composio connection lists connections and runs nothing else", async () => {
    const w = await world({ modelLabel: "real" });
    await post(w, "/connections/tk-linear/setup", { method: "composio" });
    const before = w.runner.calls.length;
    const r = await post<ConnectionTestDTO>(w, "/connections/tk-linear/test");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(r.body.detail).toMatch(/Linear is signed in/);
    const calls = w.runner.calls.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(isReadOnlyComposioArgv(c.argv)).toBe(true);
  });

  test("CONNECTIONS: the API key test checks the Keychain item exists without reading it when there is no health check", async () => {
    const runner = new FakeRunner((argv): LinkRunResult => (argv[0] === "security" ? ok("keychain: \"/Users/me/Library/Keychains/login.keychain-db\"\n") : universeCli().reply(argv) as LinkRunResult));
    const w = await world({ modelLabel: "real", runner });
    await post(w, "/connections/tk-linear/setup", { method: "api_key", secret: KC("tk-linear") });
    const r = await post<ConnectionTestDTO>(w, "/connections/tk-linear/test");
    expect(r.body.ok).toBe(true);
    const sec = runner.calls.filter((c) => c.argv[0] === "security");
    expect(sec.length).toBe(1);
    expect(sec[0]!.argv).toEqual(["security", "find-generic-password", "-s", "offload.connection.tk-linear", "-a", "api-key"]);
    expect(sec[0]!.argv).not.toContain("-w");
  });

  test("CONNECTIONS: the API key test with a health check makes one GET with the key in memory", async () => {
    const w = await world({ modelLabel: "real" });
    await post(w, "/connections/tk-linear/setup", { method: "api_key", secret: KC("tk-linear"), baseUrl: "https://api.linear.app", healthPath: "/me", header: "Authorization" });
    const r = await post<ConnectionTestDTO>(w, "/connections/tk-linear/test");
    expect(r.body.ok).toBe(true);
    expect(w.fetches.calls.length).toBe(1);
    expect(w.fetches.calls[0]!.url).toBe("https://api.linear.app/me");
    expect(w.fetches.calls[0]!.init.method).toBe("GET");
    expect((w.fetches.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(SECRET);
    expect(r.text).not.toContain(SECRET);
  });

  test("CONNECTIONS: GET /connections/universe answers the index status; the stub model never refreshes it", async () => {
    const w = await world();
    const s = await w.call<UniverseStatusDTO>("/connections/universe");
    expect(s.body).toMatchObject({ toolkits: 10, stale: false, syncedAt: NOW });
    const n = w.runner.calls.length;
    const r = await post<UniverseStatusDTO & { started: boolean }>(w, "/connections/universe/refresh");
    expect(r.body.started).toBe(false);
    expect(w.runner.calls.length).toBe(n);
  });

  test("CONNECTIONS: the real model refreshes the index in the background, read-only", async () => {
    const w = await world({ modelLabel: "real" });
    const r = await post<{ started: boolean }>(w, "/connections/universe/refresh");
    expect(r.body.started).toBe(true);
    await w.brain.idle();
    expect(w.runner.calls.some((c) => c.argv.slice(0, 4).join(" ") === "composio dev toolkits list")).toBe(true);
    for (const c of w.runner.calls) if (c.argv[0] === "composio") expect(isReadOnlyComposioArgv(c.argv) || c.argv[1] === "link").toBe(true);
  });

  test("CONNECTIONS: connection ids are the catalog id when Offload maps the app, else tk-<toolkit>", () => {
    expect(connectionIdFor("gmail")).toBe("gmail");
    expect(connectionIdFor("googlesheets")).toBe("google-sheets");
    expect(connectionIdFor("linear")).toBe("tk-linear");
    expect(keychainRefFor("tk-linear")).toEqual({ service: "offload.connection.tk-linear", account: "api-key" });
  });

  test("CONNECTIONS: without an index the center still lists the catalog and says the app list is not loaded", async () => {
    const home = tempHome();
    const brain = createBrain({ home, token: TOKEN, now: () => NOW, workflows: { model: new StubModel(), modelLabel: "stub", env: {} }, link: { linkMs: 0, runner: universeCli() }, log: () => {} });
    const r = await brain.handle(new Request("http://127.0.0.1:4545/connections", { headers: { authorization: `Bearer ${TOKEN}` } }));
    const body = (await r.json()) as ConnectionsResponse;
    expect(body.connections.length).toBeGreaterThan(10);
    expect(body.connections.every((x) => x.verified)).toBe(true);
    expect(body.universe.syncedAt).toBeNull();
    expect(body.note).toMatch(/list of apps/);
  });
});

describe("s17 secrets", () => {
  test.each(["key", "secret", "token", "password", "value", "apiKey", "api_key"])("SECRETS: a setup body with a %s field is refused and nothing is stored", async (field) => {
    const w = await world();
    const r = await post<ErrorResponse>(w, "/connections/tk-linear/setup", { method: "api_key", secret: KC("tk-linear"), [field]: SECRET });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain(SECRET);
    expect(existsSync(connectionsPath(w.home))).toBe(false);
  });

  test("SECRETS: a secret-looking value anywhere (URL query, header, command argument) is refused without echoing it", async () => {
    const w = await world();
    for (const body of [
      { method: "mcp", url: "https://mcp.linear.app/mcp?api_key=abc123" },
      { method: "mcp", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_api_123456789012345" } },
      { method: "mcp", command: "npx", args: ["-y", "srv", `--token=${SECRET}`] },
      { method: "api_key", secret: { fromEnv: "LINEAR_API_KEY" }, baseUrl: `https://api.linear.app/?token=${SECRET}` },
    ]) {
      const r = await post<ErrorResponse>(w, "/connections/tk-linear/setup", body);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain("lin_api_123456789012345");
    }
    expect(existsSync(connectionsPath(w.home))).toBe(false);
  });

  test("SECRETS: a Keychain reference must be this connection's own item (the brain never reads other items)", async () => {
    const w = await world();
    for (const secret of [{ keychain: { service: "com.apple.account.iCloud", account: "me" } }, { keychain: { service: "offload.connection.tk-stripe", account: "api-key" } }, { keychain: { service: "offload.connection.tk-linear", account: "other" } }]) {
      expect((await post<ErrorResponse>(w, "/connections/tk-linear/setup", { method: "api_key", secret })).status).toBe(400);
    }
    expect((await post(w, "/connections/tk-linear/setup", { method: "api_key", secret: { fromEnv: "LINEAR_API_KEY" } })).status).toBe(200);
  });

  test("SECRETS: after setup and tests, no file under the home, no log line and no answer holds the secret", async () => {
    const w = await world({ modelLabel: "real" });
    const texts: string[] = [];
    texts.push((await post(w, "/connections/tk-linear/setup", { method: "api_key", secret: KC("tk-linear"), baseUrl: "https://api.linear.app", healthPath: "/me" })).text);
    texts.push((await post(w, "/connections/tk-linear/test")).text);
    texts.push((await post(w, "/connections/tk-linear/setup", { method: "mcp", url: "https://mcp.linear.app/mcp", headers: { Authorization: KC("tk-linear") } })).text);
    texts.push((await w.call("/connections/tk-linear")).text, (await w.call("/connections")).text);
    for (const t of texts) expect(t).not.toContain(SECRET);
    expect(allText(w.home)).not.toContain(SECRET);
    expect(w.logs.join("\n")).not.toContain(SECRET);
  });

  test("SECRETS: a failing health check reports the status in plain words, never the key or the response body", async () => {
    const w = await world({ modelLabel: "real" });
    w.fetches.calls.length = 0;
    const brain = createBrain({ home: w.home, token: TOKEN, now: () => NOW, workflows: { model: new StubModel(), modelLabel: "real", env: {} }, link: { linkMs: 0, runner: w.runner }, chain: { deps: { secrets: w.secrets, fetch: async () => new Response(`bad key ${SECRET}`, { status: 401 }) } }, log: () => {} });
    w.brain = brain;
    await post(w, "/connections/tk-linear/setup", { method: "api_key", secret: KC("tk-linear"), baseUrl: "https://api.linear.app", healthPath: "/me" });
    const r = await post<ConnectionTestDTO>(w, "/connections/tk-linear/test");
    expect(r.body.ok).toBe(false);
    expect(r.body.detail).toBe("Linear refused the sign-in. Check the API key in Linear's settings and save it again.");
    expect(r.text).not.toContain(SECRET);
    expect(readFileSync(connectionsPath(w.home), "utf8")).not.toContain(SECRET);
  });

  test("SECRETS: plain words in every method, status and test line the center shows", async () => {
    const w = await world({ modelLabel: "real" });
    const d = (await w.call<ConnectionDetailDTO>("/connections/tk-linear")).body;
    // "API key" is the vendor's own word on its settings page; the rest of the s10e lint holds.
    for (const s of [d.statusLine, ...d.methods.flatMap((m) => [m.title, m.detail, ...m.steps])]) expect(s).not.toMatch(/token|mcp|skill|gate|json|\benv\b/i);
  });
});

describe("s17 build", () => {
  const supportWorld = async (modelLabel: "stub" | "real" = "stub") => {
    const { home, v2 } = await freshHome("support");
    const w = await world({ home, now: S14_NOW, v2: true, modelLabel });
    return { w, v2 };
  };

  test("BUILD: building from a catalog connection drafts the workflow, records the pick and returns the dry run", async () => {
    const { w } = await supportWorld();
    const r = await post<ConnectionBuildDTO>(w, "/connections/zendesk/build");
    expect(r.status).toBe(200);
    expect(r.body.workflow.id).toMatch(/^wf_/);
    expect(r.body.dryRun.instances).toBeGreaterThan(0);
    expect(r.body.dryRun.commitTool).toBe("zendesk");
    const wf = readWorkflow(w.home, r.body.workflow.id)!;
    const step = wf.tools!.find((t) => t.options.some((o) => o.id === "zendesk"))!;
    expect(step.chosen).toBe("zendesk");
    expect(step.chosenBy).toBe("user");
    expect(wf.lastDryRunAt).not.toBeNull();
  });

  test("BUILD: a universe connection for an app the task touches is picked for the step it fits", async () => {
    const { w } = await supportWorld();
    const r = await post<ConnectionBuildDTO>(w, "/connections/tk-shopify/build");
    expect(r.status).toBe(200);
    const wf = readWorkflow(w.home, r.body.workflow.id)!;
    expect(wf.tools!.some((t) => t.chosen === "shopify" && t.chosenBy === "user")).toBe(true);
  });

  test("BUILD: an app Offload has not seen you use is a 409 in plain words", async () => {
    const { w } = await supportWorld();
    const r = await post<ErrorResponse>(w, "/connections/tk-linear/build");
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/has not seen you work in Linear yet/);
  });

  test("BUILD: with an insight named, any app's tool is added to the commit step, chosen and previewed field by field", async () => {
    const { w, v2 } = await supportWorld("real");
    const insight = v2.insights.find((i) => (i.profile.understanding?.surfaces ?? []).some((s) => s.host === "acme.zendesk.com"))!;
    const r = await post<ConnectionBuildDTO>(w, "/connections/tk-linear/build", { insightId: insight.id });
    expect(r.status).toBe(200);
    // A ticket reply maps to a comment in Linear (the step's words), with the reply text in its body.
    expect(r.body.dryRun.commitTool).toBe("composio:LINEAR_CREATE_LINEAR_COMMENT");
    expect(r.body.dryRun.missing).toEqual(["issueId"]);
    const wf = readWorkflow(w.home, r.body.workflow.id)!;
    const commitStep = wf.tools!.find((t) => t.chosen === "composio:LINEAR_CREATE_LINEAR_COMMENT")!;
    expect(commitStep.chosenBy).toBe("user");
    expect(commitStep.options.length).toBeLessThanOrEqual(3);
    expect(commitStep.options.slice(0, 2).map((o) => o.id)).toEqual(["zendesk", "intercom"]);
    // The schema was fetched (read-only) before the dry run, and nothing was executed.
    expect(w.runner.calls.some((c) => c.argv.join(" ") === "composio execute LINEAR_CREATE_LINEAR_COMMENT --get-schema")).toBe(true);
    expect(w.runner.calls.some((c) => c.argv[1] === "execute" && !c.argv.includes("--get-schema"))).toBe(false);
  });

  test("BUILD: building never sends: no live batch, no execute, no approval", async () => {
    const { w } = await supportWorld();
    const r = await post<ConnectionBuildDTO>(w, "/connections/zendesk/build");
    const batches = listBatches(w.home, r.body.workflow.id, S14_NOW);
    expect(batches.filter((b) => b.kind === "live")).toEqual([]);
    expect(readApprovals(w.home, r.body.workflow.id)).toEqual({});
    expect(w.runner.calls.some((c) => c.argv[1] === "execute" && !c.argv.includes("--get-schema"))).toBe(false);
    expect(r.body.dryRun.sent).toBe(0);
  });

  test("BUILD: the demo model never runs Composio while building; a universe tool's fields are then not fetched yet", async () => {
    const { w, v2 } = await supportWorld("stub");
    const insight = v2.insights.find((i) => (i.profile.understanding?.surfaces ?? []).some((s) => s.host === "acme.zendesk.com"))!;
    const before = w.runner.calls.length;
    const r = await post<ConnectionBuildDTO>(w, "/connections/tk-linear/build", { insightId: insight.id });
    expect(r.status).toBe(200);
    expect(r.body.dryRun.commitTool).toBe("composio:LINEAR_CREATE_LINEAR_COMMENT");
    expect(r.body.dryRun.missing).toEqual(["the tool's fields (not fetched yet)"]);
    expect(w.runner.calls.length).toBe(before);
  });

  test("CONNECTIONS: a malformed id is a 404, never a crash", async () => {
    const w = await world();
    expect((await w.call<ErrorResponse>("/connections/%E0%A4%A")).status).toBe(404);
  });

  test("BUILD: an unknown insight id is a 404; a bad body is a 400", async () => {
    const { w } = await supportWorld();
    expect((await post<ErrorResponse>(w, "/connections/zendesk/build", { insightId: "ins_nope" })).status).toBe(404);
    expect((await post<ErrorResponse>(w, "/connections/zendesk/build", { insightId: 3 })).status).toBe(400);
    expect((await post<ErrorResponse>(w, "/connections/zendesk/build", { other: 1 })).status).toBe(400);
  });
});
