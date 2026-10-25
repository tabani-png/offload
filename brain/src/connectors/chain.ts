// s13: the connector resolution chain (ADR 0007 point 6). Per target (a catalog connector or any app a task profile
// touches) the methods are tried in order: a connector server on this Mac (mcp) -> Composio -> a direct API -> computer
// use, the last resort. Each method has a health probe that says what it can do for the target (capabilities) and why
// it was skipped. The first healthy method that offers what the caller needs is chosen; the decision is cached in
// $OFFLOAD_HOME/connector-chain.json (0600, no secrets) with an expiry. A run that fails on a method marks it failed
// and the next resolve moves on to the next method. Every method still goes through the approval gate: the chain only
// decides HOW to reach an app, never WHETHER something may be sent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainHealthDTO, ConnectorChainDTO } from "../api/types.ts";
import { scrubLogText } from "../log.ts";
import { writePrivate } from "../workflows/store.ts";
import { ApiProbe } from "./api.ts";
import { ComposioProbe } from "./composio.ts";
import { OsaDriver } from "./computer/osa-driver.ts";
import { DisabledComputerProbe, DriverComputerProbe, type ComputerProbe } from "./computer/probe.ts";
import { loadConnectorsConfig, type Env } from "./config.ts";
import { readSim, resolutionMethods, SpawnLinkRunner, type LinkRunner, type Method } from "./link.ts";
import { McpProbe, SdkMcpLister, type McpLister } from "./mcp-probe.ts";
import { DefaultSecretReader, redact, type SecretReader } from "./secrets.ts";
import { allCapabilities, CATALOG_TARGETS, catalogTarget, isAppTargetId, SCREEN_READ, toolkitOfUniverseId, universeTarget, type ChainTarget } from "./targets.ts";
import { readUniverse } from "./universe.ts";

export type Health = ChainHealthDTO;

export interface ProbeResult {
  health: Health;
  /** Machine code for the outcome, e.g. ok, no_server, missing_env, timeout, no_toolkit, not_signed_in. */
  code: string;
  /** Plain words for a person; null when ok. */
  reason: string | null;
  reads: string[];
  writes: string[];
  /** capability -> the concrete tool / operation / action that does it. */
  tools: Record<string, string>;
  latencyMs: number | null;
  /** Method-private facts the executors need (server names, Composio toolkit and account). Never in a DTO. */
  info?: Record<string, string>;
}

export interface MethodState extends ProbeResult {
  method: Method;
  checkedAt: number;
  /** The last run failure on this method (scrubbed), null when none. */
  lastError: string | null;
  /** When a run failed on it; a run failure holds for FAIL_TTL_MS whatever the probe says. */
  failedAt: number | null;
}

export interface ChainDecision {
  targetId: string;
  methods: MethodState[];
  decidedAt: number;
  expiresAt: number;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ChainDeps {
  home: string;
  env: Env;
  now: () => number;
  /** Stub model: deterministic probes, nothing spawned, no network, no UI. */
  simulated: boolean;
  runner: LinkRunner;
  mcp: McpLister;
  fetch: FetchLike;
  secrets: SecretReader;
  computer: ComputerProbe;
  /** Per probe step (one MCP tools/list, one CLI command, one HTTP request). */
  timeoutMs: number;
  log?: (line: string) => void;
}

export interface MethodProbe {
  readonly method: Method;
  probe(target: ChainTarget, deps: ChainDeps): Promise<ProbeResult>;
}

export const OK_TTL_MS = 10 * 60_000;
export const FAIL_TTL_MS = 2 * 60_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const CHAIN_FILE = "connector-chain.json";
/** Decisions of the stub model's demo probes are stored under this prefix. */
export const DEMO_PREFIX = "demo:";
export const chainPath = (home: string) => join(home, CHAIN_FILE);

/** Plain words the chain shows a person (no internal words: the app's lint refuses key, token, mcp, gate, ...). */
export const CHAIN_WORDS = {
  noServer: (name: string) => `No connector on this Mac is set up for ${name}.`,
  missingSetting: "Its sign-in setting is not set yet.",
  noAnswer: "The connector on this Mac did not answer in time.",
  broken: "The connector on this Mac stopped with an error.",
  noUsable: "It does not offer any action Offload can use.",
  composioMissing: "Composio is not installed on this Mac.",
  composioNoApp: (name: string) => `Composio has no app for ${name}.`,
  composioNotSigned: (name: string) => `${name} is not signed in to Composio yet.`,
  composioAsks: "Composio asks before every action on this account, so Offload only reads through it.",
  composioNoAnswer: "Composio did not answer in time.",
  apiNone: (name: string) => `No direct connection is set up for ${name}.`,
  apiNoSecret: "The sign-in for the direct connection could not be read.",
  apiDown: "The service did not answer.",
  apiRefused: "The service refused the sign-in.",
  computerOff: "Using apps on your screen is off until you turn it on.",
  computerNoAccess: "Offload is not allowed to control the screen yet. Turn it on in System Settings, Privacy and Security, Accessibility.",
  computerNoApp: (name: string) => `${name} is not on this Mac.`,
  runFailed: "The last run through this way did not finish.",
  stubFail: "This way did not answer in the demo.",
} as const;

export const CHAIN_WORDS_FOR_LINT: readonly string[] = Object.values(CHAIN_WORDS).map((v) => (typeof v === "function" ? (v as (n: string) => string)("Gmail") : v));

/** A probe result in one line. */
export const result = (health: Health, code: string, reason: string | null, caps: { reads?: string[]; writes?: string[]; tools?: Record<string, string> } = {}, latencyMs: number | null = null, info?: Record<string, string>): ProbeResult => ({
  health,
  code,
  reason,
  reads: [...(caps.reads ?? [])].sort(),
  writes: [...(caps.writes ?? [])].sort(),
  tools: { ...(caps.tools ?? {}) },
  latencyMs,
  ...(info === undefined ? {} : { info }),
});

/** Runs `p` with a time limit; rejects with Error("timeout") when it passes. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------- stub probes (demo, e2e) ----------

/** OFFLOAD_STUB_CHAIN_FAIL: comma list of methods whose demo probe fails. */
export function stubChainFailures(env: Env): Set<Method> {
  return new Set((env.OFFLOAD_STUB_CHAIN_FAIL ?? "").split(",").map((x) => x.trim()).filter((x): x is Method => ["mcp", "composio", "api", "computer"].includes(x)));
}

/** Deterministic: mcp ok when connectors.json lists the target, composio ok for catalog targets and demo sign-ins,
 * api ok when `apis` lists it, computer ok. Spawns nothing and opens nothing. */
export function stubProbe(method: Method): MethodProbe {
  return {
    method,
    async probe(t, d) {
      if (stubChainFailures(d.env).has(method)) return result("failed", "stub_failed", CHAIN_WORDS.stubFail);
      const cfg = loadConnectorsConfig(d.home).config;
      const writes = [...t.sends, ...t.logs];
      const all = { reads: t.reads, writes, tools: Object.fromEntries(allCapabilities(t).map((c) => [c, `demo:${method}`])) };
      if (method === "mcp") return Object.values(cfg?.servers ?? {}).some((s) => s.catalog.includes(t.id)) ? result("ok", "ok", null, all, 0) : result("skipped", "no_server", CHAIN_WORDS.noServer(t.name));
      if (method === "composio") return t.catalog || readSim(d.home)[t.id] !== undefined ? result("ok", "ok", null, all, 0) : result("skipped", "no_toolkit", CHAIN_WORDS.composioNoApp(t.name));
      if (method === "api") return cfg?.apis?.[t.id] !== undefined ? result("ok", "ok", null, all, 0) : result("skipped", "no_api", CHAIN_WORDS.apiNone(t.name));
      return result("ok", "ok", null, { reads: [SCREEN_READ], writes: t.sends, tools: { [SCREEN_READ]: "computer:screen", ...Object.fromEntries(t.sends.map((c) => [c, "computer:commit"])) } }, 0);
    },
  };
}

export function stubProbes(): Map<Method, MethodProbe> {
  return new Map((["mcp", "composio", "api", "computer"] as const).map((m) => [m, stubProbe(m)]));
}

export function defaultProbes(): Map<Method, MethodProbe> {
  return new Map<Method, MethodProbe>([
    ["mcp", new McpProbe()],
    ["composio", new ComposioProbe()],
    ["api", new ApiProbe()],
    ["computer", { method: "computer", probe: (t, d) => d.computer.probe(t, d) }],
  ]);
}

/** Fills the defaults for every dependency the caller did not inject. */
export function chainDeps(o: Partial<ChainDeps> & Pick<ChainDeps, "home" | "env">): ChainDeps {
  const runner = o.runner ?? new SpawnLinkRunner();
  return {
    home: o.home,
    env: o.env,
    now: o.now ?? Date.now,
    simulated: o.simulated ?? false,
    runner,
    mcp: o.mcp ?? new SdkMcpLister(),
    fetch: o.fetch ?? ((url, init) => fetch(url, init)),
    secrets: o.secrets ?? new DefaultSecretReader(o.env, runner),
    // Computer use is off until the person turns it on (OFFLOAD_COMPUTER_REAL=1 today; the app's switch later).
    computer: o.computer ?? (o.env.OFFLOAD_COMPUTER_REAL === "1" ? new DriverComputerProbe(new OsaDriver(runner, o.env)) : new DisabledComputerProbe()),
    timeoutMs: o.timeoutMs ?? PROBE_TIMEOUT_MS,
    ...(o.log === undefined ? {} : { log: o.log }),
  };
}

// ---------- the cache file ----------

/** App targets come from observed task profiles (app names, hosts): kept 7 days from when they were last seen, like
 * the observed data they come from (ADR 0003), then dropped with their decisions. */
export const APP_TARGET_RETAIN_MS = 7 * 24 * 60 * 60_000;

type StoredTarget = ChainTarget & { seenAt: number };

interface ChainFile {
  version: 1;
  /** App targets seen in task profiles (catalog targets are rebuilt from the catalog). */
  targets: Record<string, StoredTarget>;
  decisions: Record<string, ChainDecision>;
}

function readChainFile(home: string): ChainFile {
  const p = chainPath(home);
  if (!existsSync(p)) return { version: 1, targets: {}, decisions: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ChainFile>;
    if (raw.version !== 1 || typeof raw.decisions !== "object" || raw.decisions === null) return { version: 1, targets: {}, decisions: {} };
    return { version: 1, targets: typeof raw.targets === "object" && raw.targets !== null ? raw.targets : {}, decisions: raw.decisions };
  } catch {
    return { version: 1, targets: {}, decisions: {} };
  }
}

function writeChainFile(home: string, f: ChainFile): void {
  writePrivate(chainPath(home), JSON.stringify(f, null, 2) + "\n");
}

const fresh = (t: StoredTarget | undefined, now: number): t is StoredTarget => t !== undefined && typeof t.seenAt === "number" && now - t.seenAt < APP_TARGET_RETAIN_MS;
const plainTarget = ({ seenAt: _seen, ...t }: StoredTarget): ChainTarget => t;

/** Remembers app targets (seen now) so their ids work in /connectors/:id routes, and drops app targets (and their
 * decisions) not seen for APP_TARGET_RETAIN_MS. Catalog ids are never stored. */
export function rememberTargets(home: string, targets: readonly ChainTarget[], now: number = Date.now()): void {
  const app = targets.filter((t) => !t.catalog && isAppTargetId(t.id));
  const f = readChainFile(home);
  let changed = false;
  for (const t of app) {
    f.targets[t.id] = { ...t, seenAt: now };
    changed = true;
  }
  for (const [id, t] of Object.entries(f.targets)) {
    if (fresh(t, now)) continue;
    delete f.targets[id];
    delete f.decisions[id];
    delete f.decisions[`${DEMO_PREFIX}${id}`];
    changed = true;
  }
  if (changed) writeChainFile(home, f);
}

/** The target for an id: a catalog connector, or an app target seen in the last 7 days; null otherwise. */
export function knownTarget(home: string, id: string, now: number = Date.now()): ChainTarget | null {
  const c = catalogTarget(id);
  if (c !== null) return c;
  // s17: any toolkit of the Composio universe index (never Composio's own helper toolkit).
  const tk = toolkitOfUniverseId(id);
  if (tk !== null) {
    const t = tk === "composio" ? undefined : readUniverse(home)?.toolkits[tk];
    return t === undefined ? null : universeTarget(t);
  }
  if (!isAppTargetId(id)) return null;
  const t = readChainFile(home).targets[id];
  return fresh(t, now) ? plainTarget(t) : null;
}

export function knownTargets(home: string, now: number = Date.now()): ChainTarget[] {
  return [...CATALOG_TARGETS, ...Object.values(readChainFile(home).targets).filter((t) => isAppTargetId(t.id) && fresh(t, now)).map(plainTarget)];
}

// ---------- decisions ----------

/** The methods a target is tried with, in order. App targets: composio, api, computer (no server lists them). */
export function chainOrder(t: ChainTarget, home: string): Method[] {
  if (t.catalog) return resolutionMethods(t.id, loadConnectorsConfig(home).config);
  return ["composio", "api", "computer"];
}

const offers = (s: ProbeResult, need: readonly string[]) => need.every((c) => s.reads.includes(c) || s.writes.includes(c));

/** What a target's status is about: its commits (or logs), else its reads. */
export const primaryNeed = (t: ChainTarget): string[] => (t.sends.length > 0 ? [...t.sends] : t.logs.length > 0 ? [...t.logs] : [...t.reads]);

/** The ok methods, in order, that offer everything in `need` (all ok methods when `need` is empty). */
export function usable(states: readonly MethodState[], need: readonly string[]): MethodState[] {
  return states.filter((s) => s.health === "ok" && offers(s, need));
}

export function chooseMethod(states: readonly MethodState[], need: readonly string[]): { method: Method | null; next: Method | null } {
  const ok = usable(states, need);
  return { method: ok[0]?.method ?? null, next: ok[1]?.method ?? null };
}

export function scrubError(err: unknown, secrets: readonly string[] = []): string {
  const text = err instanceof Error ? err.message : String(err);
  return redact(scrubLogText(text), secrets).slice(0, 300);
}

export class ChainResolver {
  private readonly probes: Map<Method, MethodProbe>;
  private readonly inflight = new Map<string, Promise<ChainDecision>>();

  constructor(
    readonly deps: ChainDeps,
    probes?: Map<Method, MethodProbe>,
  ) {
    this.probes = probes ?? (deps.simulated ? stubProbes() : defaultProbes());
  }

  /** Demo (stub) decisions are kept apart from real ones and never count for the real model. */
  private key(targetId: string): string {
    return this.deps.simulated ? `${DEMO_PREFIX}${targetId}` : targetId;
  }

  /** The cached decision, expired or not; null when there is none. */
  peek(targetId: string): ChainDecision | null {
    return readChainFile(this.deps.home).decisions[this.key(targetId)] ?? null;
  }

  /** Probes every method of the target (or answers from the cache until it expires). One probe per target at a time. */
  async resolve(t: ChainTarget, opts: { refresh?: boolean } = {}): Promise<ChainDecision> {
    const now = this.deps.now();
    const cached = this.peek(t.id);
    const order = chainOrder(t, this.deps.home);
    const fresh = cached !== null && cached.expiresAt > now && cached.methods.map((m) => m.method).join() === order.join();
    if (fresh && opts.refresh !== true) return cached;
    const running = this.inflight.get(t.id);
    if (running !== undefined) return running;
    const p = this.probeAll(t, order, cached).finally(() => this.inflight.delete(t.id));
    this.inflight.set(t.id, p);
    return p;
  }

  private async probeAll(t: ChainTarget, order: readonly Method[], prior: ChainDecision | null): Promise<ChainDecision> {
    const states: MethodState[] = [];
    for (const method of order) {
      const at = this.deps.now();
      const was = prior?.methods.find((m) => m.method === method);
      const probe = this.probes.get(method);
      let r: ProbeResult;
      try {
        r = probe === undefined ? result("skipped", "not_built", CHAIN_WORDS.noUsable) : await probe.probe(t, this.deps);
      } catch (err) {
        r = result("failed", "probe_error", CHAIN_WORDS.broken);
        this.deps.log?.(`brain: chain ${t.id}: ${method} probe failed: ${scrubError(err)}`);
      }
      // A run failure holds for FAIL_TTL_MS, whatever the probe says now.
      const runFailed = was?.failedAt != null && at - was.failedAt < FAIL_TTL_MS;
      states.push({
        ...(runFailed && r.health === "ok" ? { ...r, health: "failed" as const, code: "run_failed", reason: CHAIN_WORDS.runFailed } : r),
        method,
        checkedAt: at,
        lastError: was?.lastError ?? null,
        failedAt: runFailed ? was!.failedAt : null,
      });
    }
    const now = this.deps.now();
    const anyOk = states.some((s) => s.health === "ok");
    const d: ChainDecision = { targetId: t.id, methods: states, decidedAt: now, expiresAt: now + (anyOk ? OK_TTL_MS : FAIL_TTL_MS) };
    const f = readChainFile(this.deps.home);
    f.decisions[this.key(t.id)] = d;
    writeChainFile(this.deps.home, f);
    return d;
  }

  /** A run through `method` failed: it is skipped until FAIL_TTL_MS passes; the next resolve moves on. */
  markFailed(targetId: string, method: Method, err: unknown, secrets: readonly string[] = []): ChainDecision | null {
    const f = readChainFile(this.deps.home);
    const d = f.decisions[this.key(targetId)];
    if (d === undefined) return null;
    const now = this.deps.now();
    const s = d.methods.find((m) => m.method === method);
    if (s === undefined) return d;
    s.health = "failed";
    s.code = "run_failed";
    s.reason = CHAIN_WORDS.runFailed;
    s.lastError = scrubError(err, secrets);
    s.failedAt = now;
    writeChainFile(this.deps.home, f);
    return d;
  }

  /** The ok methods, in order, that can do every capability in `need` for the target. */
  async plan(t: ChainTarget, need: readonly string[], opts: { refresh?: boolean } = {}): Promise<MethodState[]> {
    return usable((await this.resolve(t, opts)).methods, need);
  }
}

/** The DTO of a decision. `info` (server names, accounts) never leaves the brain. */
export function toChainDTO(t: ChainTarget, d: ChainDecision, simulated: boolean): ConnectorChainDTO {
  const need = primaryNeed(t);
  const { method, next } = chooseMethod(d.methods, need);
  const chosen = d.methods.find((m) => m.method === method);
  const lastError = [...d.methods].filter((m) => m.lastError !== null).sort((a, b) => (b.failedAt ?? 0) - (a.failedAt ?? 0))[0]?.lastError ?? null;
  return {
    targetId: t.id,
    name: t.name,
    catalog: t.catalog,
    method,
    health: chosen !== undefined ? "ok" : d.methods.some((m) => m.health === "failed") ? "failed" : "skipped",
    capabilities: { reads: chosen?.reads ?? [], writes: chosen?.writes ?? [] },
    lastError,
    next,
    decidedAt: d.decidedAt,
    expiresAt: d.expiresAt,
    simulated,
    methods: d.methods.map((m) => ({ method: m.method, health: m.health, code: m.code, reason: m.reason, reads: [...m.reads], writes: [...m.writes], tools: { ...m.tools }, lastError: m.lastError, checkedAt: m.checkedAt, latencyMs: m.latencyMs })),
  };
}

/** Real mode: catalog ids that a cached, unexpired decision can commit through (counts as connected for approval). */
export function chainConnected(home: string, now: number): Set<string> {
  const out = new Set<string>();
  for (const [id, d] of Object.entries(readChainFile(home).decisions)) {
    if (id.startsWith(DEMO_PREFIX)) continue;
    const t = knownTarget(home, id, now);
    if (t === null || d.expiresAt <= now) continue;
    const need = [...t.sends, ...t.logs].filter((c) => c !== "ui.commit");
    if (need.length === 0) continue;
    if (d.methods.some((m) => m.health === "ok" && m.writes.some((w) => need.includes(w)))) out.add(id);
  }
  return out;
}
