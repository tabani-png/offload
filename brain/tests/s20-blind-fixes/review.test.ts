// s20 review round (Codex on 497ffdf): (1) plan needs are matched to what each method really advertises, not by exact
// name; the full need x method table is computed here so a new mismatch between a planner and a connector fails;
// (2) a home's key mode never changes because retained observation files were purged; (3) a read-and-approve task
// (every step only looks) claims no saving, so the flat 87-90% "read + approve" figure is gone from brain output.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityNeedDTO } from "../../src/api/s14-types.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { chainDeps, ChainResolver, result, type MethodProbe } from "../../src/connectors/chain.ts";
import { computerCapabilities, computerServer } from "../../src/connectors/computer/probe.ts";
import type { Method } from "../../src/connectors/link.ts";
import { capabilityOf, catalogTarget, GENERIC_COMMIT, GENERIC_READ, SCREEN_READ, UI_COMMIT, type ChainTarget } from "../../src/connectors/targets.ts";
import { estimateSaving } from "../../src/insights/saving.ts";
import { commitCapability, readCapability, targetOf, type StepTarget } from "../../src/plan/capabilities.ts";
import * as chainResolverModule from "../../src/plan/chain-resolver.ts";
import { ChainCapabilityResolver } from "../../src/plan/chain-resolver.ts";
import { DriverComputerProbe } from "../../src/connectors/computer/probe.ts";
import type { ComputerDriver } from "../../src/connectors/computer/driver.ts";
import { rememberTargets } from "../../src/connectors/chain.ts";
import { stepClass } from "../../src/plan/steps.ts";
import { brainKeyMode, brainKeyPath, clearBrainKeyCache, openText, sealText } from "../../src/store/vault.ts";
import { clearSyncKeyCache, DEVICE_SIGNING, syncKey } from "../../src/sync/keys.ts";
import { TOOL_POLICIES } from "../../src/workflows/allowlist.ts";
import { blindWeek, NOW, writeBlindWeek } from "./fixture.ts";

const homes: string[] = [];
const tmp = (p = "offload-s20r-") => {
  const h = mkdtempSync(join(tmpdir(), p));
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

// ---------- (1) need x method ----------

const CHAIN_METHODS = ["mcp", "composio", "api", "computer"] as const;

/** What each method's real probe advertises for a target when everything it could find is there (the probes' own
 * rules: allowlisted tools by flavor for MCP and Composio, configured operations for the API, the screen and the
 * target's commits for computer use, generic read / commit for a Composio universe toolkit). */
function advertised(method: Method, t: ChainTarget): { reads: string[]; writes: string[] } | null {
  if (method === "computer") {
    const c = computerCapabilities(t, computerServer(t.id));
    return { reads: c.reads, writes: c.writes };
  }
  if (method === "composio" && t.id.startsWith("tk-")) return { reads: [GENERIC_READ], writes: [GENERIC_COMMIT] };
  if (method === "api") {
    // A direct API configured for a catalog app names canonical capabilities; one for any other app lists its own
    // read operations (api.<operationId>) and a write operation of its own.
    return t.catalog ? { reads: [...t.reads], writes: [...t.sends, ...t.logs] } : { reads: ["api.listItems"], writes: ["item.update"] };
  }
  // mcp and composio for catalog / app targets: the allowlisted tools of that flavor the target has.
  const reads: string[] = [];
  const writes: string[] = [];
  for (const p of TOOL_POLICIES) {
    if (p.connector !== t.id || (method === "composio") !== (p.flavor === "composio")) continue;
    const c = capabilityOf(t.id, p.tool);
    if (c === null) continue;
    (c.role === "read" ? reads : writes).push(c.capability);
  }
  return reads.length + writes.length === 0 ? null : { reads, writes };
}

/** Only `only` is healthy, advertising what its real probe would. */
function chainWith(only: Method | null, home: string, simulated = false): ChainResolver {
  const probe = (method: Method): MethodProbe => ({
    method,
    async probe(t) {
      // Computer use finds an app the way OsaDriver.appPresent does: a host to open, or a bundle id on this Mac.
      if (method === "computer" && only === "computer" && t.hosts.length === 0 && t.bundleIds.length === 0) return result("skipped", "app_missing", `${t.name} is not on this Mac.`);
      const caps = method === only ? advertised(method, t) : null;
      return caps === null ? result("skipped", "no_server", `nothing for ${t.name}`) : result("ok", "ok", null, caps, 0);
    },
  });
  return new ChainResolver(chainDeps({ home, env: {}, simulated }), new Map(CHAIN_METHODS.map((m) => [m, probe(m)])));
}

/** Observed steps (app, host as the observer saw them): known products, an unknown native app (bundle id only) and an
 * unknown site (host only), and a local document. */
const OBSERVED_STEPS = [
  { app: "com.granola.app", appName: "Granola", host: "", surfaceKey: "com.granola.app|Granola|" },
  { app: "com.google.Chrome", appName: "Google Chrome", host: "linear.app", surfaceKey: "com.google.Chrome|linear.app|/team" },
  { app: "com.acme.tool", appName: "Acme Tool", host: "", surfaceKey: "com.acme.tool|Acme Tool|" },
  { app: "com.google.Chrome", appName: "Google Chrome", host: "acme.example", surfaceKey: "com.google.Chrome|acme.example|/board" },
  { app: "com.apple.Preview", appName: "Preview", host: "", surfaceKey: "com.apple.Preview|invoice.pdf|" },
];
/** The analysis those steps came from (only what observedTargets reads). */
const OBSERVED_ANALYSIS = { insights: [{ profile: { app: "", appName: "", host: "", understanding: { steps: OBSERVED_STEPS } } }] } as unknown as Parameters<typeof chainResolverModule.observedTargets>[0];
const observedOpt = () => ({ observed: () => chainResolverModule.observedTargets(OBSERVED_ANALYSIS) });

const COMMIT_VERBS = ["send", "reply", "append", "log", "update", "create", "move"];

/** Every need the planner can produce (plan/capabilities.ts), for every catalog connector and the app target kinds. */
function plannerNeeds(): CapabilityNeedDTO[] {
  const targets: StepTarget[] = CONNECTORS.map((c) => ({ target: c.id, targetName: c.name, via: "catalog", connectorId: c.id }));
  targets.push(...OBSERVED_STEPS.map(targetOf));
  const out = new Map<string, CapabilityNeedDTO>();
  for (const t of targets) {
    const read: CapabilityNeedDTO = { need: `read from ${t.targetName}`, target: t.target, targetName: t.targetName, capability: readCapability(t), role: "read", via: t.via };
    out.set(`${t.target}|${read.capability}`, read);
    for (const v of COMMIT_VERBS) {
      const capability = commitCapability(t, v);
      out.set(`${t.target}|${capability}`, { need: `${v} in ${t.targetName}`, target: t.target, targetName: t.targetName, capability, role: "send", via: t.via });
    }
  }
  return [...out.values()];
}

type Row = { need: CapabilityNeedDTO; cells: Record<string, string> };

async function table(): Promise<Row[]> {
  const needs = plannerNeeds();
  const rows: Row[] = needs.map((need) => ({ need, cells: {} }));
  for (const m of [...CHAIN_METHODS, null] as const) {
    // simulated: a known product's Composio toolkit is asked as its universe target (as with a demo sign-in).
    // A connector server on this Mac lists every catalog app, so MCP is in every catalog chain (link.ts order).
    const home = tmp();
    writeFileSync(join(home, "connectors.json"), JSON.stringify({ version: 1, servers: { all: { type: "stdio", command: "npx", args: ["-y", "x"], catalog: CONNECTORS.map((c) => c.id) } } }));
    const r = new (ChainCapabilityResolver as unknown as new (...a: unknown[]) => ChainCapabilityResolver)(chainWith(m, home, true), home, observedOpt());
    const res = await r.resolve(needs);
    for (const row of rows) {
      const x = res.find((y) => y.target === row.need.target && y.capability === row.need.capability)!;
      if (m === null) row.cells.local = x.status === "resolved" && x.method === "local" ? "Y" : "-";
      else row.cells[m] = x.status === "resolved" && x.method === m ? "Y" : "-";
    }
  }
  return rows;
}

describe("s20 ROUTE review: needs are matched to what each method advertises", () => {
  test("ROUTE: Gmail reached only through computer use resolves its mail.read need by reading the screen", async () => {
    const r = new ChainCapabilityResolver(chainWith("computer", tmp()));
    const res = await r.resolve([
      { need: "read email from Gmail", target: "gmail", targetName: "Gmail", capability: "mail.read", role: "read", via: "catalog" },
      { need: "send email in Gmail", target: "gmail", targetName: "Gmail", capability: "mail.send", role: "send", via: "catalog" },
    ]);
    expect(res.map((x) => `${x.capability}:${x.status}:${x.method}`)).toEqual(["mail.read:resolved:computer", "mail.send:resolved:computer"]);
  });

  test("ROUTE: a local document's file.read need resolves by reading the file on this Mac, with no method set up", async () => {
    const t = targetOf({ app: "com.apple.Preview", appName: "Preview", host: "", surfaceKey: "com.apple.Preview|invoice.pdf|" });
    expect(t.via).toBe("local_file");
    expect(readCapability(t)).toBe("file.read");
    const r = new ChainCapabilityResolver(chainWith(null, tmp()));
    const [x] = await r.resolve([{ need: "read invoice from Preview", target: t.target, targetName: t.targetName, capability: "file.read", role: "read", via: "local_file" }]);
    expect(x).toMatchObject({ status: "resolved", method: "local" });
    expect(x!.reason).toContain("reading the file on this Mac");
  });

  test("ROUTE: an app's direct API with its own operations serves the app's screen read and its gated commit", async () => {
    const r = new ChainCapabilityResolver(chainWith("api", tmp()));
    const res = await r.resolve([
      { need: "read issue from Linear", target: "web-linear-app", targetName: "Linear", capability: SCREEN_READ, role: "read", via: "computer_use" },
      { need: "update issue in Linear", target: "web-linear-app", targetName: "Linear", capability: UI_COMMIT, role: "send", via: "computer_use" },
    ]);
    expect(res.map((x) => `${x.capability}:${x.status}:${x.method}`)).toEqual([`${SCREEN_READ}:resolved:api`, `${UI_COMMIT}:resolved:api`]);
  });

  test("ROUTE: a catalog commit is never served by a method that only reads (no loose match for commits)", async () => {
    // Composio for Gmail with an account that asks before every call: reads only.
    const home = tmp();
    const probe = (method: Method): MethodProbe => ({ method, probe: async () => (method === "composio" ? result("ok", "reads_only", "asks", { reads: ["mail.search", "mail.read"], writes: [] }, 0) : result("skipped", "no_server", "none")) });
    const r = new ChainCapabilityResolver(new ChainResolver(chainDeps({ home, env: {}, simulated: false }), new Map(CHAIN_METHODS.map((m) => [m, probe(m)]))));
    const res = await r.resolve([{ need: "send email in Gmail", target: "gmail", targetName: "Gmail", capability: "mail.send", role: "send", via: "catalog" }]);
    expect(res[0]!.status).toBe("unavailable");
  });

  test("ROUTE: the need x method table: every need a planner produces is served by at least one method", async () => {
    const rows = await table();
    const cols = [...CHAIN_METHODS, "local"];
    const text = rows.map((r) => `${`${r.need.target} ${r.need.capability}`.padEnd(42)} ${cols.map((c) => `${c}=${r.cells[c]}`).join(" ")}`).join("\n");
    if (process.env.S20_PRINT_TABLE === "1") console.log(`need x method (Y = resolves when only that method works)\n${text}`);
    expect(rows.length).toBeGreaterThan(CONNECTORS.length);
    // No need is left without any way to do it.
    expect(rows.filter((r) => !cols.some((c) => r.cells[c] === "Y")).map((r) => `${r.need.target} ${r.need.capability}`)).toEqual([]);
    for (const r of rows) {
      const ct = catalogTarget(r.need.target);
      // Computer use reads any app on screen and does any UI commit (its commit tool is gated like every other).
      // (A local document's read never reaches the chain: it is read from disk first.)
      if (r.cells.local !== "Y" && (r.need.role === "read" || r.need.capability === UI_COMMIT)) expect(`${r.need.target} ${r.need.capability} computer=${r.cells.computer}`).toBe(`${r.need.target} ${r.need.capability} computer=Y`);
      // A method that advertises the exact capability always serves it.
      for (const m of CHAIN_METHODS) {
        const t = ct ?? ({ id: r.need.target, name: r.need.targetName, catalog: false, bundleIds: [], hosts: [], toolkit: "", reads: [SCREEN_READ], sends: [UI_COMMIT], logs: [] } as ChainTarget);
        const a = advertised(m, t);
        if (a !== null && (a.reads.includes(r.need.capability) || a.writes.includes(r.need.capability))) expect(`${r.need.target} ${r.need.capability} ${m}=${r.cells[m]}`).toBe(`${r.need.target} ${r.need.capability} ${m}=Y`);
      }
    }
    const cell = (target: string, cap: string, col: string) => rows.find((r) => r.need.target === target && r.need.capability === cap)?.cells[col];
    expect(cell("gmail", "mail.read", "computer")).toBe("Y");
    expect(cell("app-preview", "file.read", "local")).toBe("Y");
    expect(cell("google-sheets", UI_COMMIT, "computer")).toBe("Y");
    expect(cell("app-granola", SCREEN_READ, "composio")).toBe("Y");
    // Observed identity wins over the product table: an unknown native app (bundle id) and an unknown site (host) are
    // found by computer use, and Granola (no bundle id or host in the table) through the bundle id it was seen with.
    for (const t of ["app-acme-tool", "web-acme-example", "app-granola"]) {
      expect(`${t} ${cell(t, SCREEN_READ, "computer")}`).toBe(`${t} Y`);
      expect(`${t} ${cell(t, UI_COMMIT, "computer")}`).toBe(`${t} Y`);
    }
    // Local reading is only for a local document, never for a commit or an app on screen.
    expect(rows.filter((r) => r.cells.local === "Y").map((r) => r.need.capability)).toEqual(["file.read"]);
  });
});

// ---------- (2) key mode never follows retained data ----------

describe("s20 KEYS review: key mode survives the purge of observation files", () => {
  function fakeObserver(dir: string): { bin: string; log: string } {
    const bin = join(dir, "observer.sh");
    const log = join(dir, "calls.log");
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\necho "no keychain here" >&2\nexit 1\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  }
  const day = "2026-10-18";
  const now = new Date(2026, 9, 19, 12).getTime();

  test("KEYS: a plain home keeps its file keys after its last plain day file is purged (sealed data and sync keys stay readable)", () => {
    const home = tmp();
    mkdirSync(join(home, "days"), { recursive: true });
    writeFileSync(join(home, "days", `${day}.jsonl`), "{}\n");
    const obs = fakeObserver(tmp("offload-s20r-obs-"));
    const env = { OFFLOAD_OBSERVER_BIN: obs.bin };
    const path = join(home, "sealed.enc");
    sealText(home, path, "masked text", day, env);
    const signing = syncKey(home, DEVICE_SIGNING, { create: true, env })!;
    expect(existsSync(brainKeyPath(home, day))).toBe(true);
    // Retention removes the last plain day file; the process restarts (in-memory keys are gone).
    rmSync(join(home, "days", `${day}.jsonl`));
    clearBrainKeyCache();
    clearSyncKeyCache();
    expect(brainKeyMode(env, home)).toBe("file");
    expect(openText(home, path, now, env)).toBe("masked text");
    expect(Buffer.from(syncKey(home, DEVICE_SIGNING, { create: false, env })!).equals(Buffer.from(signing))).toBe(true);
    expect(existsSync(obs.log)).toBe(false);
  });

  test("KEYS: an observer home stays on the Keychain after its encrypted days are purged and a plain import arrives", () => {
    const home = tmp();
    mkdirSync(join(home, "days"), { recursive: true });
    writeFileSync(join(home, "days", `${day}.jsonl.enc`), "");
    expect(brainKeyMode({}, home)).toBe("keychain");
    // Retention removes the encrypted day; an importer later writes a plain day into the same home.
    rmSync(join(home, "days", `${day}.jsonl.enc`));
    writeFileSync(join(home, "days", "2026-10-19.jsonl"), "{}\n");
    expect(brainKeyMode({}, home)).toBe("keychain");
  });

  test("KEYS: OFFLOAD_KEYS still overrides a remembered mode both ways", () => {
    const home = tmp();
    mkdirSync(join(home, "days"), { recursive: true });
    writeFileSync(join(home, "days", `${day}.jsonl`), "{}\n");
    expect(brainKeyMode({}, home)).toBe("file");
    rmSync(join(home, "days", `${day}.jsonl`));
    expect(brainKeyMode({ OFFLOAD_KEYS: "keychain" }, home)).toBe("keychain");
    expect(brainKeyMode({ OFFLOAD_KEYS: "file" }, home)).toBe("file");
    expect(brainKeyMode({}, home)).toBe("file");
    // A home with no evidence either way is not marked: it stays Keychain by default and can still become plain.
    const empty = tmp();
    expect(brainKeyMode({}, empty)).toBe("keychain");
    mkdirSync(join(empty, "days"), { recursive: true });
    writeFileSync(join(empty, "days", `${day}.jsonl`), "{}\n");
    expect(brainKeyMode({}, empty)).toBe("file");
    expect(readFileSync(join(empty, "brain-key-mode"), "utf8").trim()).toBe("file");
  });
});

// ---------- (3) no flat read + approve saving ----------

describe("s20 SAVING review: a read-and-approve task claims no saving", () => {
  test("SAVING: a task whose every step only reads claims no saving, with the reason in the arithmetic", () => {
    const s = estimateSaving({ instances: 40, daysActive: 7, windowDays: 7, medianMinutes: 3, eventIds: [], activeMinutes: 120, signals: { share: 0.05, surfaces: 1, genericShare: 1, readOnly: true } } as Parameters<typeof estimateSaving>[0]);
    expect(s.weeklyHoursSaved).toBe(0);
    expect(s.savingPct).toBe(0);
    expect(s.range.low.hoursSaved).toBe(0);
    expect(s.range.high.hoursSaved).toBe(0);
    expect(s.arithmetic).toContain("saves 0.0 h/wk (0%)");
    expect(s.confidence).toBe("low");
  });

  test("SAVING: no blind-week insight claims a saving for a task that only reads (the 87-90% read + approve figure is gone)", async () => {
    const home = tmp();
    writeBlindWeek(home, blindWeek());
    const a = await analyzeHome(home, { now: () => NOW, understanding: "v2" });
    const readOnly = a.insights.filter((i) => (i.profile.understanding?.steps ?? []).every((s) => stepClass(s) !== "text" && stepClass(s) !== "record"));
    expect(readOnly.map((i) => i.saving.arithmetic)).toEqual([]);
    // The write tasks are still offered.
    expect(a.insights.length).toBeGreaterThanOrEqual(3);
    for (const i of a.insights) expect(i.saving.arithmetic).not.toMatch(/\((8[7-9]|90)%\)/);
  });
});

// ---------- (4) observed identity wins over the static product table (Codex on 9f12355) ----------

describe("s20 ROUTE review 2: an app's observed bundle id and host reach the computer-use probe", () => {
  function driver(seen: ChainTarget[]): ComputerDriver {
    return {
      real: true,
      permissions: async () => ({ accessibility: true, screenRecording: true }),
      // OsaDriver.appPresent: a host can be opened; a bundle id must be on this Mac (here: the installed set).
      appPresent: async (t: ChainTarget) => {
        seen.push(t);
        return t.hosts.length > 0 || t.bundleIds.some((b) => ["com.acme.tool", "com.granola.app"].includes(b));
      },
    } as unknown as ComputerDriver;
  }
  function chainWithDriver(home: string, seen: ChainTarget[]): ChainResolver {
    const skip = (method: Method): MethodProbe => ({ method, probe: async () => result("skipped", "no_server", "none") });
    const probes = new Map<Method, MethodProbe>([...(["mcp", "composio", "api"] as const).map((m) => [m, skip(m)] as [Method, MethodProbe]), ["computer", { method: "computer", probe: (t, d) => new DriverComputerProbe(driver(seen)).probe(t, d) }]]);
    return new ChainResolver(chainDeps({ home, env: {}, simulated: false }), probes);
  }
  const needs = (target: string, name: string): CapabilityNeedDTO[] => [
    { need: `read from ${name}`, target, targetName: name, capability: SCREEN_READ, role: "read", via: "computer_use" },
    { need: `change in ${name}`, target, targetName: name, capability: UI_COMMIT, role: "send", via: "computer_use" },
  ];

  test("ROUTE: observedTargets keeps every app's bundle id and every site's host from the analysis", () => {
    const o = chainResolverModule.observedTargets(OBSERVED_ANALYSIS);
    expect(o.get("app-acme-tool")).toEqual({ bundleIds: ["com.acme.tool"], hosts: [] });
    expect(o.get("web-acme-example")).toEqual({ bundleIds: [], hosts: ["acme.example"] });
    expect(o.get("app-granola")).toEqual({ bundleIds: ["com.granola.app"], hosts: [] });
    // A browser is not the app of a site.
    expect(o.get("web-linear-app")?.bundleIds).toEqual([]);
  });

  test("ROUTE: an unknown native app and an unknown site, observed, resolve through computer use", async () => {
    const home = tmp();
    const seen: ChainTarget[] = [];
    const r = new (ChainCapabilityResolver as unknown as new (...a: unknown[]) => ChainCapabilityResolver)(chainWithDriver(home, seen), home, observedOpt());
    const res = await r.resolve([...needs("app-acme-tool", "Acme Tool"), ...needs("web-acme-example", "acme.example"), ...needs("app-granola", "Granola")]);
    expect(res.map((x) => `${x.target} ${x.capability} ${x.status} ${x.method}`)).toEqual([
      `app-acme-tool ${SCREEN_READ} resolved computer`,
      `app-acme-tool ${UI_COMMIT} resolved computer`,
      `web-acme-example ${SCREEN_READ} resolved computer`,
      `web-acme-example ${UI_COMMIT} resolved computer`,
      `app-granola ${SCREEN_READ} resolved computer`,
      `app-granola ${UI_COMMIT} resolved computer`,
    ]);
    // The product table still supplements: Granola keeps its Composio toolkit.
    expect(seen.find((t) => t.id === "app-granola")?.toolkit).toBe("granola");
  });

  test("ROUTE: without an analysis, an app target stored from the insights (GET /connectors) supplies its identity", async () => {
    const home = tmp();
    rememberTargets(home, [{ id: "app-acme-tool", name: "Acme Tool", catalog: false, bundleIds: ["com.acme.tool"], hosts: [], toolkit: "acmetool", reads: [SCREEN_READ], sends: [UI_COMMIT], logs: [] }], Date.now());
    const r = new ChainCapabilityResolver(chainWithDriver(home, []));
    const res = await r.resolve(needs("app-acme-tool", "Acme Tool"));
    expect(res.every((x) => x.status === "resolved" && x.method === "computer")).toBe(true);
  });

  test("ROUTE: an observed host of a catalog app is added to the catalog's own hosts", async () => {
    const home = tmp();
    const seen: ChainTarget[] = [];
    const analysis = { insights: [{ profile: { app: "", appName: "", host: "", understanding: { steps: [{ app: "com.google.Chrome", appName: "Chrome", host: "acme.zendesk.com", surfaceKey: "com.google.Chrome|acme.zendesk.com|/agent" }] } } }] } as unknown as Parameters<typeof chainResolverModule.observedTargets>[0];
    const target = targetOf({ app: "com.google.Chrome", appName: "Chrome", host: "acme.zendesk.com", surfaceKey: "com.google.Chrome|acme.zendesk.com|/agent" });
    expect(target.target).toBe("zendesk");
    const r = new (ChainCapabilityResolver as unknown as new (...a: unknown[]) => ChainCapabilityResolver)(chainWithDriver(home, seen), home, { observed: () => chainResolverModule.observedTargets(analysis) });
    await r.resolve([{ need: "read ticket", target: target.target, targetName: target.targetName, capability: SCREEN_READ, role: "read", via: target.via }]);
    expect(seen.find((t) => t.id === target.target)?.hosts).toContain("acme.zendesk.com");
  });
});
