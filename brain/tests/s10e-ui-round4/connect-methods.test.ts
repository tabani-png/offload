// s10e follow-up: Connect is generic. Every link has a resolution method (mcp | composio | api | computer), the
// ordered `methods` the connector can use, `next` after a failure and a plain-words `detail`. api and computer are
// declared seams that fail with "not available yet" (s13 filled them: see the updated test below); GET
// /connectors/:id/status is the generic poll.
import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectLinkDTO, ErrorResponse } from "../../src/api/types.ts";
import type { ConnectorsConfig } from "../../src/connectors/config.ts";
import { LINK_METHODS, METHOD_DETAIL, nextMethod, registerLinkMethod, resolutionMethods, stubFailures, unavailableMethod, type LinkMethod, type LinkRegistry } from "../../src/connectors/link.ts";
import { BANNED_RE, FakeRunner, linkWorld, ok, type LinkWorld } from "./setup.ts";

let x: LinkWorld | null = null;
afterEach(() => {
  x?.cleanup();
  x = null;
});

const call = (w: LinkWorld, path: string, method = "GET", body?: unknown) => w.call<ConnectLinkDTO & ErrorResponse>(path, { method, ...(body === undefined ? {} : { body }) });
const stdio = (catalog: string[]): ConnectorsConfig => ({ version: 1, servers: { local: { type: "stdio", command: "npx", args: ["-y", "some-server"], envFromEnv: {}, catalog } } });
const http = (catalog: string[]): ConnectorsConfig => ({ version: 1, servers: { composio: { type: "http", url: "https://mcp.composio.example/x", headersFromEnv: { "x-api-key": "COMPOSIO_API_KEY" }, catalog } } });

describe("s10e connect methods: resolutionMethods", () => {
  test("gmail: mcp first, then composio; Composio-only config puts composio first; seams appended", () => {
    expect(resolutionMethods("gmail", null)).toEqual(["mcp", "composio", "api", "computer"]);
    expect(resolutionMethods("gmail", stdio(["gmail"]))).toEqual(["mcp", "composio", "api", "computer"]);
    expect(resolutionMethods("gmail", http(["gmail"]))).toEqual(["composio", "mcp", "api", "computer"]);
  });

  test("Composio-catalog connectors: composio, plus mcp when a stdio server lists them; unknown id: none", () => {
    expect(resolutionMethods("slack", null)).toEqual(["composio", "api", "computer"]);
    expect(resolutionMethods("slack", stdio(["slack"]))).toEqual(["composio", "mcp", "api", "computer"]);
    expect(resolutionMethods("slack", stdio(["notion"]))).toEqual(["composio", "api", "computer"]);
    expect(resolutionMethods("nope", null)).toEqual([]);
  });

  test("nextMethod: the next available method, wrapping; seams are never offered", () => {
    const g = resolutionMethods("gmail", null);
    expect(nextMethod(g, "mcp")).toBe("composio");
    expect(nextMethod(g, "composio")).toBe("mcp");
    expect(nextMethod(g, "api")).toBe("mcp");
    expect(nextMethod(g, "computer")).toBe("mcp");
    expect(nextMethod(resolutionMethods("slack", null), "composio")).toBeNull();
    expect(nextMethod(resolutionMethods("slack", null), "computer")).toBe("composio");
  });

  test("OFFLOAD_STUB_LINK_FAIL is a comma list of methods; unknown words are ignored", () => {
    expect([...stubFailures({ OFFLOAD_STUB_LINK_FAIL: "mcp, computer,bogus" })]).toEqual(["mcp", "computer"]);
    expect(stubFailures({}).size).toBe(0);
  });
});

describe("s10e connect methods: routes (stub)", () => {
  test("the DTO carries method, methods, next and detail; the default method is the first of methods", async () => {
    x = await linkWorld({ linkMs: 0 });
    const idle = await call(x, "/connectors/gmail/link");
    expect(idle.body).toMatchObject({ method: "mcp", methods: ["mcp", "composio", "api", "computer"], next: null, via: "gmail-mcp", detail: METHOD_DETAIL.mcp });
    const p = await call(x, "/connectors/gmail/link", "POST", {});
    expect(p.body).toMatchObject({ state: "waiting", method: "mcp", via: "gmail-mcp", next: null });
    expect((await call(x, "/connectors/gmail/link")).body).toMatchObject({ state: "connected", method: "mcp" });
  });

  test("POST with a method: composio for gmail, via composio", async () => {
    x = await linkWorld({ linkMs: 1000 });
    const p = await call(x, "/connectors/gmail/link", "POST", { method: "composio" });
    expect(p.body).toMatchObject({ state: "waiting", method: "composio", via: "composio", detail: METHOD_DETAIL.composio });
    // A different method while one waits starts the new one.
    const m = await call(x, "/connectors/gmail/link", "POST", { method: "mcp" });
    expect(m.body).toMatchObject({ state: "waiting", method: "mcp" });
    x.clock.now += 1000;
    expect((await call(x, "/connectors/gmail/status")).body).toMatchObject({ state: "connected", method: "mcp" });
  });

  test("stub failure: OFFLOAD_STUB_LINK_FAIL=mcp ends failed with the plain detail and next composio; composio then works", async () => {
    x = await linkWorld({ linkMs: 0, env: { OFFLOAD_STUB_LINK_FAIL: "mcp" } });
    const f = await call(x, "/connectors/gmail/link", "POST", {});
    expect(f.body).toMatchObject({ state: "failed", method: "mcp", next: "composio", detail: "The connector on this Mac did not answer." });
    expect(f.body.message).toBe("The sign-in did not start: the connector on this Mac did not answer.");
    expect((await call(x, "/connectors/gmail/status")).body).toMatchObject({ state: "failed", next: "composio" });
    const c = await call(x, "/connectors/gmail/link", "POST", { method: "composio" });
    expect(c.body).toMatchObject({ state: "waiting", method: "composio", next: null });
    expect((await call(x, "/connectors/gmail/status")).body.state).toBe("connected");
  });

  // s13 filled the api and computer seams (slices/s13-connector-chain/SPEC.md, Scope changes). Without a direct
  // connection set up, api fails in plain words and offers the next usable way; computer use is a demo sign-in here.
  test("api and computer are filled by s13: api without a direct connection fails and offers the next usable way; computer is a demo sign-in", async () => {
    x = await linkWorld({ linkMs: 0 });
    const api = await call(x, "/connectors/gmail/link", "POST", { method: "api" });
    expect(api.status).toBe(200);
    expect(api.body).toMatchObject({ state: "failed", method: "api", next: "computer", detail: "No direct connection is set up for Gmail.", via: "composio" });
    const computer = await call(x, "/connectors/gmail/link", "POST", { method: "computer" });
    expect(computer.body).toMatchObject({ state: "waiting", method: "computer", next: null });
    expect((await call(x, "/connectors/slack/link", "POST", { method: "computer" })).body).toMatchObject({ state: "waiting", method: "computer" });
    // A seam that is not built still fails "not available yet" (unavailableMethod is kept for later slices).
    expect((await unavailableMethod("api").start({} as never)).detail).toBe("That way of connecting is not available yet.");
  });

  test("a method the connector cannot use fails in plain words and offers the one it can", async () => {
    x = await linkWorld({ linkMs: 0 });
    const r = await call(x, "/connectors/slack/link", "POST", { method: "mcp" });
    expect(r.body).toMatchObject({ state: "failed", method: "mcp", next: "composio", detail: "That way of connecting does not work for Slack yet." });
  });

  test("bad method is 400; POST /status is 405; /status of an unknown id is 404", async () => {
    x = await linkWorld();
    expect((await call(x, "/connectors/gmail/link", "POST", { method: "carrier-pigeon" })).status).toBe(400);
    expect((await call(x, "/connectors/gmail/link", "POST", { method: "mcp", restart: "no" })).status).toBe(400);
    for (const m of ["POST", "PUT", "DELETE"]) {
      const r = await call(x, "/connectors/gmail/status", m);
      expect(r.status).toBe(405);
      expect(r.body.error).toBe("method_not_allowed");
    }
    expect((await call(x, "/connectors/nope/status")).status).toBe(404);
    expect((await x.call("/connectors/gmail/status", { token: "w".repeat(40) })).status).toBe(401);
  });

  test("GET /status returns the same DTO as GET /link", async () => {
    x = await linkWorld({ linkMs: 5000 });
    await call(x, "/connectors/notion/link", "POST", {});
    const a = await call(x, "/connectors/notion/link");
    const b = await call(x, "/connectors/notion/status");
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  test("detail and message of every state shown here have no banned word", async () => {
    x = await linkWorld({ linkMs: 0, env: { OFFLOAD_STUB_LINK_FAIL: "composio" } });
    const seen: ConnectLinkDTO[] = [];
    seen.push((await call(x, "/connectors/gmail/status")).body);
    for (const method of ["mcp", "composio", "api", "computer"]) seen.push((await call(x, "/connectors/slack/link", "POST", { method })).body);
    seen.push((await call(x, "/connectors/gmail/link", "POST", { method: "composio" })).body);
    seen.push((await call(x, "/connectors/gmail/link", "POST", { method: "mcp" })).body);
    seen.push((await call(x, "/connectors/gmail/status")).body);
    for (const d of seen) {
      expect(d.detail).not.toMatch(BANNED_RE);
      expect(d.message).not.toMatch(BANNED_RE);
      expect(d.detail.length).toBeGreaterThan(0);
    }
    for (const d of Object.values(METHOD_DETAIL)) expect(d).not.toMatch(BANNED_RE);
  });
});

describe("s10e connect methods: real model and the registry seam", () => {
  test("real: POST method composio for gmail runs composio; mcp runs the local auth command", async () => {
    const runner = new FakeRunner((argv) => (argv[0] === "composio" ? ok("https://connect.composio.dev/link/m1") : new Promise(() => {})));
    x = await linkWorld({ modelLabel: "real", runner, env: {} });
    const c = await call(x, "/connectors/gmail/link", "POST", { method: "composio" });
    expect(c.body).toMatchObject({ method: "composio", via: "composio", state: "waiting", url: "https://connect.composio.dev/link/m1" });
    expect(runner.calls[0]!.argv).toEqual(["composio", "link", "gmail", "--no-browser", "--no-wait"]);
    const m = await call(x, "/connectors/gmail/link", "POST", { method: "mcp" });
    expect(m.body).toMatchObject({ method: "mcp", via: "gmail-mcp", state: "waiting", url: null });
    expect(runner.calls[1]!.argv).toEqual(["npx", "-y", "@gongrzhe/server-gmail-autoauth-mcp", "auth"]);
  });

  test("real: a failed Composio start offers mcp next for gmail", async () => {
    const runner = new FakeRunner(() => ({ code: 1, stdout: "", stderr: "", timedOut: false }));
    x = await linkWorld({ modelLabel: "real", runner, env: {} });
    const r = await call(x, "/connectors/gmail/link", "POST", { method: "composio" });
    expect(r.body).toMatchObject({ state: "failed", method: "composio", next: "mcp", detail: "Composio stopped with an error." });
  });

  test("a later slice registers a method without touching the route", async () => {
    const registry: LinkRegistry = new Map(LINK_METHODS);
    const computer: LinkMethod = {
      method: "computer",
      available: true,
      async start(ctx) {
        return { method: "computer", state: "waiting", url: null, message: "Watching the screen.", detail: "Offload uses the app on your screen.", startedAt: ctx.now, connectedAt: null, signedIn: false, lastPollAt: 0 };
      },
      async poll(ctx, rec) {
        rec.state = "connected";
        rec.connectedAt = ctx.now;
      },
    };
    registerLinkMethod(computer, registry);
    expect(registry.get("computer")!.available).toBe(true);
    expect(LINK_METHODS.get("computer")!.available).toBe(false);
    expect(nextMethod(["mcp", "computer"], "mcp", registry)).toBe("computer");
    registerLinkMethod(unavailableMethod("computer"), registry);
    expect(nextMethod(["mcp", "computer"], "mcp", registry)).toBeNull();
  });
});

