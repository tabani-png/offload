// s13 CHAIN: order, first healthy method with the needed capabilities, skip reasons, cache with expiry, markFailed,
// stub determinism, app targets for apps the catalog does not know.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import {
  APP_TARGET_RETAIN_MS,
  CHAIN_WORDS_FOR_LINT,
  chainConnected,
  chainOrder,
  chainPath,
  chooseMethod,
  FAIL_TTL_MS,
  knownTarget,
  OK_TTL_MS,
  rememberTargets,
  stubProbes,
  toChainDTO,
  type MethodProbe,
} from "../../src/connectors/chain.ts";
import type { Method } from "../../src/connectors/link.ts";
import { appTargetId, catalogTarget, slugify, targetForProfile } from "../../src/connectors/targets.ts";
import { profile } from "../helpers.ts";
import { BANNED_RE, composioCli, fail, GMAIL_STDIO, NOW, resolver, tempHome, writeConfig } from "./setup.ts";

let home: string;
let cleanup: () => void;
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

const gmail = () => catalogTarget("gmail")!;

describe("s13 chain: targets", () => {
  test("CHAIN: catalog targets carry capabilities from the allowlist (gmail sends mail.send, sheets logs sheet.append)", () => {
    expect(gmail()).toMatchObject({ id: "gmail", catalog: true, toolkit: "gmail", sends: ["mail.send"], logs: [] });
    expect(gmail().reads).toEqual(["mail.labels", "mail.read", "mail.search"]);
    expect(catalogTarget("google-sheets")).toMatchObject({ toolkit: "googlesheets", sends: [], logs: ["sheet.append"] });
    // A catalog app with no allowlisted commit can still be driven on screen.
    // (s14: Slack has a commit policy since s16, so Notion is the example now.)
    expect(catalogTarget("notion")!.sends).toEqual(["ui.commit"]);
  });

  test("CHAIN: a task profile in an app the catalog does not know becomes an app target (Mac app or web host)", () => {
    const qb = targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks Online", host: "" }));
    expect(qb).toMatchObject({ id: "app-quickbooks-online", name: "QuickBooks Online", catalog: false, bundleIds: ["com.intuit.QuickBooks"], hosts: [], reads: ["screen.read"], sends: ["ui.commit"] });
    expect(qb.toolkit).toBe("quickbooksonline");
    const web = targetForProfile(profile({ app: "com.google.Chrome", appName: "Google Chrome", host: "app.pipedrive.com", urlPattern: "/deal/<n>" }));
    expect(web).toMatchObject({ id: "web-app-pipedrive-com", hosts: ["app.pipedrive.com"], toolkit: "pipedrive", catalog: false });
    // A profile the catalog knows stays the catalog connector.
    expect(targetForProfile(profile()).id).toBe("gmail");
    expect(appTargetId({ app: "", appName: "", host: "www.example.org" })).toBe("web-example-org");
    expect(slugify("  Ünïcode — App!! ")).toBe("unicode-app");
  });

  test("CHAIN: app targets are remembered so their ids resolve; catalog ids always do; others never", () => {
    expect(knownTarget(home, "app-quickbooks-online")).toBeNull();
    rememberTargets(home, [targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks Online", host: "" }))]);
    expect(knownTarget(home, "app-quickbooks-online")?.name).toBe("QuickBooks Online");
    expect(knownTarget(home, "gmail")?.catalog).toBe(true);
    expect(knownTarget(home, "nope")).toBeNull();
    expect(knownTarget(home, "../etc")).toBeNull();
  });

  test("CHAIN: app targets (observed app names and hosts) are kept 7 days from when they were last seen, then dropped with their decisions", async () => {
    const qb = targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks Online", host: "" }));
    rememberTargets(home, [qb], NOW);
    const { r } = resolver(home);
    await r.resolve(qb);
    expect(knownTarget(home, qb.id, NOW + APP_TARGET_RETAIN_MS - 1)).not.toBeNull();
    expect(knownTarget(home, qb.id, NOW + APP_TARGET_RETAIN_MS)).toBeNull();
    rememberTargets(home, [], NOW + APP_TARGET_RETAIN_MS);
    const file = readFileSync(chainPath(home), "utf8");
    expect(file).not.toContain("QuickBooks");
    expect(file).not.toContain(qb.id);
  });

  test("CHAIN: order follows resolutionMethods for catalog ids; app targets try composio, api, computer", () => {
    expect(chainOrder(gmail(), home)).toEqual(["mcp", "composio", "api", "computer"]);
    expect(chainOrder(catalogTarget("slack")!, home)).toEqual(["composio", "api", "computer"]);
    const app = targetForProfile(profile({ app: "com.intuit.QuickBooks", appName: "QuickBooks", host: "" }));
    expect(chainOrder(app, home)).toEqual(["composio", "api", "computer"]);
  });
});

describe("s13 chain: resolve and decide", () => {
  test("CHAIN: the first healthy method that offers the target's commit wins; skipped methods say why", async () => {
    // No server configured: mcp is skipped, Composio (CLI) has gmail signed in.
    const { r } = resolver(home);
    const d = await r.resolve(gmail());
    const dto = toChainDTO(gmail(), d, false);
    expect(dto.method).toBe("composio");
    expect(dto.health).toBe("ok");
    expect(dto.capabilities.writes).toEqual(["mail.send"]);
    expect(dto.next).toBeNull();
    const mcp = dto.methods.find((m) => m.method === "mcp")!;
    expect(mcp).toMatchObject({ health: "skipped", code: "no_server", reason: "No connector on this Mac is set up for Gmail." });
    expect(dto.methods.find((m) => m.method === "api")).toMatchObject({ health: "skipped", code: "no_api" });
    expect(dto.methods.find((m) => m.method === "computer")).toMatchObject({ health: "skipped", code: "computer_off" });
  });

  test("CHAIN: with the Gmail server configured mcp is chosen and Composio is next", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    const { r } = resolver(home);
    const dto = toChainDTO(gmail(), await r.resolve(gmail()), false);
    expect(dto).toMatchObject({ method: "mcp", next: "composio", health: "ok" });
    expect(dto.methods[0]!.tools["mail.send"]).toBe("mcp__gmail__send_email");
  });

  test("CHAIN: a method that does not offer what is needed is not chosen even when healthy", () => {
    const states = [
      { method: "mcp" as Method, health: "ok" as const, code: "ok", reason: null, reads: ["mail.search"], writes: [], tools: {}, latencyMs: 1, checkedAt: 0, lastError: null, failedAt: null },
      { method: "composio" as Method, health: "ok" as const, code: "ok", reason: null, reads: [], writes: ["mail.send"], tools: {}, latencyMs: 1, checkedAt: 0, lastError: null, failedAt: null },
    ];
    expect(chooseMethod(states, ["mail.send"])).toEqual({ method: "composio", next: null });
    expect(chooseMethod(states, [])).toEqual({ method: "mcp", next: "composio" });
    expect(chooseMethod(states, ["sheet.append"])).toEqual({ method: null, next: null });
  });

  test("CHAIN: decisions are cached (0600, no secret) until they expire; refresh re-probes", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    const { r, clock, lister } = resolver(home);
    const a = await r.resolve(gmail());
    expect(a.expiresAt - a.decidedAt).toBe(OK_TTL_MS);
    expect(statSync(chainPath(home)).mode & 0o777).toBe(0o600);
    clock.now += 60_000;
    expect((await r.resolve(gmail())).decidedAt).toBe(a.decidedAt);
    expect(lister.calls).toHaveLength(1);
    await r.resolve(gmail(), { refresh: true });
    expect(lister.calls).toHaveLength(2);
    clock.now += OK_TTL_MS + 1;
    await r.resolve(gmail());
    expect(lister.calls).toHaveLength(3);
    const file = readFileSync(chainPath(home), "utf8");
    expect(file).not.toContain("creds.json");
    expect(file).toContain("\"gmail\"");
  });

  test("CHAIN: when nothing is healthy the decision is re-checked sooner (FAIL_TTL_MS)", async () => {
    const { r } = resolver(home, { runner: composioCli({ "connections list": fail() }) });
    const d = await r.resolve(gmail());
    expect(d.expiresAt - d.decidedAt).toBe(FAIL_TTL_MS);
    expect(toChainDTO(gmail(), d, false)).toMatchObject({ method: null, health: "failed" });
  });

  test("CHAIN: markFailed skips the method at once (next is chosen), and a run failure outlives a fresh probe for FAIL_TTL_MS", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    const { r, clock } = resolver(home);
    await r.resolve(gmail());
    r.markFailed("gmail", "mcp", new Error("MCP error -32000: Connection closed (to anna@northzone.com)"));
    const after = toChainDTO(gmail(), r.peek("gmail")!, false);
    expect(after.method).toBe("composio");
    expect(after.lastError).not.toContain("anna@northzone.com");
    expect(after.methods[0]).toMatchObject({ health: "failed", code: "run_failed", reason: "The last run through this way did not finish." });
    // Re-probed while the run failure is fresh: still failed.
    const re = await r.resolve(gmail(), { refresh: true });
    expect(toChainDTO(gmail(), re, false).method).toBe("composio");
    // After FAIL_TTL_MS the healthy probe counts again.
    clock.now += FAIL_TTL_MS + 1;
    expect(toChainDTO(gmail(), await r.resolve(gmail(), { refresh: true }), false).method).toBe("mcp");
  });

  test("CHAIN: a probe that throws is a failed method, not a crash", async () => {
    const boom: MethodProbe = { method: "mcp", probe: async () => { throw new Error("kaput"); } };
    const probes = new Map(stubProbes());
    probes.set("mcp", boom);
    const { r, logs } = resolver(home, { probes });
    const d = await r.resolve(gmail());
    expect(d.methods[0]).toMatchObject({ method: "mcp", health: "failed", code: "probe_error" });
    expect(logs.some((l) => l.includes("kaput"))).toBe(true);
  });

  test("CHAIN: the DTO never carries probe-private facts (server names, Composio accounts)", async () => {
    const { r } = resolver(home);
    const d = await r.resolve(gmail());
    expect(d.methods.find((m) => m.method === "composio")!.info).toEqual({ toolkit: "gmail", account: "gmail_live-one" });
    expect(JSON.stringify(toChainDTO(gmail(), d, false))).not.toContain("gmail_live-one");
  });
});

describe("s13 chain: stub, connected, words", () => {
  test("CHAIN: stub probes are deterministic, spawn nothing and fail on OFFLOAD_STUB_CHAIN_FAIL", async () => {
    writeConfig(home, { servers: GMAIL_STDIO });
    const { r, runner, lister } = resolver(home, { simulated: true });
    const dto = toChainDTO(gmail(), await r.resolve(gmail()), true);
    expect(dto).toMatchObject({ method: "mcp", next: "composio", simulated: true });
    expect(runner.calls).toHaveLength(0);
    expect(lister.calls).toHaveLength(0);
    const { r: r2 } = resolver(home, { simulated: true, env: { OFFLOAD_STUB_CHAIN_FAIL: "mcp,composio" } });
    const d2 = toChainDTO(gmail(), await r2.resolve(gmail(), { refresh: true }), true);
    expect(d2.method).toBe("computer");
    expect(d2.methods[0]).toMatchObject({ health: "failed", code: "stub_failed" });
  });

  test("CHAIN: chainConnected counts unexpired real decisions that can commit; demo decisions never count", async () => {
    const { r, clock } = resolver(home);
    await r.resolve(gmail());
    expect([...chainConnected(home, clock.now)]).toEqual(["gmail"]);
    expect(chainConnected(home, clock.now + OK_TTL_MS + 1).size).toBe(0);
    const { home: h2, cleanup: c2 } = tempHome();
    try {
      writeConfig(h2, { servers: GMAIL_STDIO });
      const demo = resolver(h2, { simulated: true });
      await demo.r.resolve(gmail());
      expect(chainConnected(h2, demo.clock.now).size).toBe(0);
      // The real model does not read demo decisions either.
      expect(resolver(h2).r.peek("gmail")).toBeNull();
    } finally {
      c2();
    }
  });

  test("CHAIN: every reason the chain shows a person is plain words", () => {
    for (const w of CHAIN_WORDS_FOR_LINT) expect(w).not.toMatch(BANNED_RE);
  });
});
