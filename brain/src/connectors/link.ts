// s10e: "Connect Gmail" from the app. POST /connectors/:id/link starts a sign-in, GET /connectors/:id/link polls it.
// Connecting never sends anything: it only makes a catalog id reachable. Sending still needs an approved batch hash
// and the gate (workflows/gate.ts), which this file does not touch.
//
// Stub model (demos, e2e): a deterministic simulation. POST -> waiting; GET -> connected once `linkMs` has passed.
// The connected ids are kept in $OFFLOAD_HOME/connect-sim.json (0600). They count as connected only while the brain
// runs with the stub model, and a simulated connection has no server, so nothing can be sent through it
// (workflow-routes.ts refuses live approval and sendBatch never starts the executor for it).
// Real model: Composio (`composio link <toolkit> --no-browser --no-wait`, then `--list` to poll) or the Gmail MCP
// server's one-time auth command. Every spawn is bounded by a timeout and gets a scrubbed environment.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectLinkDTO, ModelLabel } from "../api/types.ts";
import { executorEnv } from "../workflows/executor.ts";
import { CONNECTORS, connectorById, type Connector } from "./catalog.ts";
import { catalogStatus, loadConnectorsConfig, type ConnectorStatus, type ConnectorsConfig, type Env } from "./config.ts";

// ---------- simulated connections (stub model only) ----------

export const SIM_FILE = "connect-sim.json";
export const simPath = (home: string) => join(home, SIM_FILE);

/** Catalog id -> connectedAt (ms) from connect-sim.json; {} when missing or unreadable. Unknown ids are dropped. */
export function readSim(home: string): Record<string, number> {
  const p = simPath(home);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { version?: unknown; connected?: unknown };
    if (raw.version !== 1 || typeof raw.connected !== "object" || raw.connected === null) return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(raw.connected as Record<string, unknown>)) if (connectorById(id) !== undefined && typeof at === "number" && Number.isFinite(at)) out[id] = at;
    return out;
  } catch {
    return {};
  }
}

export function writeSim(home: string, id: string, at: number): void {
  const connected = { ...readSim(home), [id]: at };
  const p = simPath(home);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, connected }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

/** Catalog status with the demo sign-ins counted as connected. Call it ONLY when the brain runs with the stub model. */
export function withSimulated(status: Record<string, ConnectorStatus>, home: string): Record<string, ConnectorStatus> {
  const sim = readSim(home);
  const out = { ...status };
  for (const id of Object.keys(sim)) out[id] = "connected";
  return out;
}

/** Ids that count as connected only through a demo sign-in: in connect-sim.json and not really connected. */
export function simulatedOnly(home: string, env: Env, ids: readonly string[]): string[] {
  const sim = readSim(home);
  const real = catalogStatus(loadConnectorsConfig(home).config, env);
  return ids.filter((id) => sim[id] !== undefined && real[id] !== "connected");
}

export const DEMO_SEND_REFUSED = "Demo connection: Offload does not send from a demo sign-in.";

// ---------- spawning (real model) ----------

export interface LinkRunResult {
  /** Exit code; null when it never started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the command could not be started (e.g. not installed). */
  spawnError?: string;
}

/** Runs one command for a sign-in. Tests inject a fake and assert the exact argv; the default spawns it. */
export interface LinkRunner {
  run(argv: readonly string[], opts: { timeoutMs: number; env: Record<string, string> }): Promise<LinkRunResult>;
}

const OUTPUT_CAP = 64 * 1024;

export class SpawnLinkRunner implements LinkRunner {
  async run(argv: readonly string[], opts: { timeoutMs: number; env: Record<string, string> }): Promise<LinkRunResult> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: opts.env });
    } catch (err) {
      return { code: null, stdout: "", stderr: "", timedOut: false, spawnError: err instanceof Error ? err.message : String(err) };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
    const read = async (s: ReadableStream<Uint8Array> | number | undefined | null) => (s instanceof ReadableStream ? (await new Response(s).text()).slice(0, OUTPUT_CAP) : "");
    try {
      const [stdout, stderr, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
      return { code: timedOut ? null : code, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The child's environment: the plain process basics only. Never OFFLOAD_TOKEN, a connector secret or a model login. */
export function linkEnv(env: Env): Record<string, string> {
  const base = executorEnv(env);
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) if (base[k] !== undefined) out[k] = base[k]!;
  return out;
}

/** The first https URL in a command's output, or null. */
export function firstHttpsUrl(text: string): string | null {
  const m = /https:\/\/[^\s"'<>`)\]]+/.exec(text);
  return m === null ? null : m[0].replace(/[.,;:]+$/, "");
}

/** True when `composio link <toolkit> --list` shows an active account ("ACTIVE", not "INACTIVE"). */
export function listShowsActive(text: string): boolean {
  return /(?<![a-z])active\b/i.test(text);
}

export const DEFAULT_GMAIL_AUTH = ["npx", "-y", "@gongrzhe/server-gmail-autoauth-mcp", "auth"] as const;
export const COMPOSIO_START_TIMEOUT_MS = 30_000;
export const COMPOSIO_LIST_TIMEOUT_MS = 15_000;
export const GMAIL_AUTH_TIMEOUT_MS = 10 * 60_000;
/** A GET runs `composio link --list` at most this often; in between it answers from the last poll. */
export const POLL_MIN_INTERVAL_MS = 2_000;

export function composioToolkit(c: Connector): string {
  return c.how.startsWith("composio:") ? c.how.slice("composio:".length) : c.id;
}

// ---------- resolution methods (s10e follow-up: Connect is generic, not Gmail-specific) ----------

/** How a connector can be reached. mcp = a connector server on this Mac; composio = Composio holds the sign-in;
 * api and computer are declared seams (a later slice registers them; today they answer "not available yet"). */
export const METHODS = ["mcp", "composio", "api", "computer"] as const;
export type Method = (typeof METHODS)[number];
export const isMethod = (x: unknown): x is Method => typeof x === "string" && (METHODS as readonly string[]).includes(x);

/**
 * The ordered methods a connector can use. The single source of truth for `methods` and the default method (the
 * first one). gmail: ["mcp", "composio"] (composio first when only a Composio http server lists it);
 * Composio-catalog ids: ["composio", "mcp"] when a stdio server lists them, else ["composio"]. "api" and "computer"
 * are appended as declared but not yet available seams. Unknown id: [].
 */
export function resolutionMethods(connectorId: string, cfg: ConnectorsConfig | null): Method[] {
  const c = connectorById(connectorId);
  if (c === undefined) return [];
  const servers = Object.values(cfg?.servers ?? {}).filter((s) => s.catalog.includes(c.id));
  const stdio = servers.some((s) => s.type === "stdio");
  const http = servers.some((s) => s.type === "http");
  const head: Method[] = c.how === "gmail-mcp" ? (http && !stdio ? ["composio", "mcp"] : ["mcp", "composio"]) : stdio ? ["composio", "mcp"] : ["composio"];
  return [...head, "api", "computer"];
}

/** The legacy `via` of a method (kept for compatibility): gmail-mcp for mcp, composio otherwise. */
export const viaOf = (m: Method): ConnectLinkDTO["via"] => (m === "mcp" ? "gmail-mcp" : "composio");

/** "composio" when an http server lists the id, "gmail-mcp" when a stdio server does, else from the catalog `how`. */
export function linkVia(c: Connector, cfg: ConnectorsConfig | null): ConnectLinkDTO["via"] {
  return viaOf(resolutionMethods(c.id, cfg)[0] ?? "composio");
}

/** The local connector's one-time auth command: the configured stdio server's command and args plus "auth"; for
 * Gmail without one, the default Gmail server's. null when there is nothing to run. */
export function mcpAuthArgv(c: Connector, cfg: ConnectorsConfig | null): string[] | null {
  const s = Object.values(cfg?.servers ?? {}).find((x) => x.type === "stdio" && x.catalog.includes(c.id));
  if (s !== undefined && s.type === "stdio") return [s.command, ...s.args, "auth"];
  return c.id === "gmail" ? [...DEFAULT_GMAIL_AUTH] : null;
}
export const gmailAuthArgv = (c: Connector, cfg: ConnectorsConfig | null): string[] => mcpAuthArgv(c, cfg) ?? [...DEFAULT_GMAIL_AUTH];

// ---------- the link state machine ----------

export const DEFAULT_STUB_LINK_MS = 2_000;

/** OFFLOAD_STUB_LINK_MS: an integer 0..60000, else the default. */
export function stubLinkMs(env: Env): number {
  const v = env.OFFLOAD_STUB_LINK_MS;
  if (v === undefined || !/^\d{1,5}$/.test(v)) return DEFAULT_STUB_LINK_MS;
  const n = Number(v);
  return n <= 60_000 ? n : DEFAULT_STUB_LINK_MS;
}

/** OFFLOAD_STUB_LINK_FAIL: comma list of methods whose demo sign-in fails (stub only), e.g. "mcp". */
export function stubFailures(env: Env): Set<Method> {
  return new Set((env.OFFLOAD_STUB_LINK_FAIL ?? "").split(",").map((x) => x.trim()).filter(isMethod));
}

/** One sign-in in progress (or finished) for one connector. Methods mutate it in poll. */
export interface LinkProgress {
  method: Method;
  state: ConnectLinkDTO["state"];
  url: string | null;
  message: string;
  detail: string;
  startedAt: number;
  connectedAt: number | null;
  /** Real mode: the account is signed in (Composio list active, or the auth command finished). */
  signedIn: boolean;
  lastPollAt: number;
}

export interface LinkMethodContext {
  connector: Connector;
  cfg: ConnectorsConfig | null;
  status: Record<string, ConnectorStatus>;
  env: Env;
  home: string;
  now: number;
  runner: LinkRunner;
  log?: (line: string) => void;
  /** Background work the method started (tests wait on it through Linker.idle). */
  track(p: Promise<unknown>): void;
  /** True while `rec` is still this connector's live sign-in (a restart replaces it). */
  isCurrent(rec: LinkProgress): boolean;
}

/**
 * One way of connecting. Real mode only: the stub simulates every available method itself. A later slice (s13) adds
 * the auto-fallback chain and computer use by registering methods here, not by editing the route.
 */
export interface LinkMethod {
  readonly method: Method;
  /** false = a declared seam: start answers failed with "not available yet" and the next method is offered. */
  readonly available: boolean;
  start(ctx: LinkMethodContext): Promise<LinkProgress>;
  /** Called on GET while the progress is waiting; updates it in place. */
  poll(ctx: LinkMethodContext, rec: LinkProgress): Promise<void>;
}

export class LinkNotFound extends Error {}

const plain = {
  waitingReal: "Finish signing in to Gmail in your browser. Offload checks every few seconds.",
  waitingDemo: "Demo sign-in: no browser opens and nothing is sent.",
  waitingWindow: (name: string) => `Finish signing in to ${name} in the browser window that opened.`,
  connected: (name: string) => `${name} is connected.`,
  connectedDemo: (name: string) => `${name} is connected for this demo. Nothing is sent from a demo sign-in.`,
  idle: (name: string) => `${name} is not connected yet.`,
  failed: (reason: string) => `The sign-in did not start: ${reason}.`,
  unfinished: (reason: string) => `The sign-in did not finish: ${reason}.`,
  signedInNotAdded: (name: string, where: string) => `${name} is signed in. Add it to the ${where} Offload uses, then Offload connects it.`,
  notYet: "That way of connecting is not available yet.",
  notFor: (name: string) => `That way of connecting does not work for ${name} yet.`,
  stubFail: { mcp: "The connector on this Mac did not answer.", composio: "Composio did not answer.", api: "That way of connecting is not available yet.", computer: "That way of connecting is not available yet." } as Record<Method, string>,
};

/** What each method means, in plain words (the `detail` while it is not failed). */
export const METHOD_DETAIL: Record<Method, string> = {
  mcp: "Uses a connector on this Mac, so the sign-in stays on this Mac.",
  composio: "Uses Composio, which keeps the sign-in for Offload.",
  api: "Connects straight to the service.",
  computer: "Offload uses the app on your screen, the way you do.",
};

/** Why a spawn failed, in plain words for a person. */
function reasonOf(r: LinkRunResult, what: string): string {
  if (r.spawnError !== undefined) return `the ${what} command is not installed on this Mac`;
  if (r.timedOut) return `${what} did not answer in time`;
  return `${what} stopped with an error`;
}

const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
const progress = (method: Method, now: number, p: Partial<LinkProgress> & Pick<LinkProgress, "state" | "message">): LinkProgress => ({ method, url: null, detail: METHOD_DETAIL[method], startedAt: now, connectedAt: null, signedIn: false, lastPollAt: 0, ...p });

function markConnected(rec: LinkProgress, name: string, now: number): void {
  rec.state = "connected";
  rec.connectedAt = now;
  rec.message = plain.connected(name);
  rec.detail = METHOD_DETAIL[rec.method];
  rec.url = null;
}

/** Composio: `composio link <toolkit> --no-browser --no-wait` hands back a sign-in URL; `--list` polls it. */
export const COMPOSIO_METHOD: LinkMethod = {
  method: "composio",
  available: true,
  async start(ctx) {
    const c = ctx.connector;
    const r = await ctx.runner.run(["composio", "link", composioToolkit(c), "--no-browser", "--no-wait"], { timeoutMs: COMPOSIO_START_TIMEOUT_MS, env: linkEnv(ctx.env) });
    const url = firstHttpsUrl(`${r.stdout}\n${r.stderr}`);
    if (r.code !== 0 || url === null) {
      const reason = r.code === 0 ? "Composio did not give a sign-in link" : reasonOf(r, "Composio");
      ctx.log?.(`brain: link ${c.id}: composio link did not start (exit ${String(r.code)}${r.timedOut ? ", timed out" : ""})`);
      return progress("composio", ctx.now, { state: "failed", message: plain.failed(reason), detail: sentence(reason) });
    }
    return progress("composio", ctx.now, { state: "waiting", url, message: plain.waitingReal.replace("Gmail", c.name) });
  },
  async poll(ctx, rec) {
    const c = ctx.connector;
    if (ctx.now - rec.lastPollAt >= POLL_MIN_INTERVAL_MS) {
      rec.lastPollAt = ctx.now;
      const r = await ctx.runner.run(["composio", "link", composioToolkit(c), "--list"], { timeoutMs: COMPOSIO_LIST_TIMEOUT_MS, env: linkEnv(ctx.env) });
      if (r.code === 0 && listShowsActive(r.stdout)) rec.signedIn = true;
    }
    if (!rec.signedIn) return;
    // Re-read: the server may have been added meanwhile.
    if (catalogStatus(loadConnectorsConfig(ctx.home).config, ctx.env)[c.id] === "connected") markConnected(rec, c.name, ctx.now);
    else rec.message = plain.signedInNotAdded(c.name, "Composio server");
  },
};

/** A connector on this Mac: its one-time auth command opens a browser window and waits for the sign-in. It runs in
 * the background, bounded by GMAIL_AUTH_TIMEOUT_MS; connected follows the catalog status. */
export const MCP_METHOD: LinkMethod = {
  method: "mcp",
  available: true,
  async start(ctx) {
    const c = ctx.connector;
    const argv = mcpAuthArgv(c, ctx.cfg);
    if (argv === null) return progress("mcp", ctx.now, { state: "failed", message: plain.failed(`there is no connector for ${c.name} on this Mac yet`), detail: plain.notFor(c.name) });
    const rec = progress("mcp", ctx.now, { state: "waiting", message: plain.waitingWindow(c.name) });
    ctx.track(
      ctx.runner
        .run(argv, { timeoutMs: GMAIL_AUTH_TIMEOUT_MS, env: linkEnv(ctx.env) })
        .then((r) => {
          if (!ctx.isCurrent(rec) || rec.state !== "waiting") return;
          if (r.code === 0) {
            rec.signedIn = true;
            return;
          }
          rec.state = "failed";
          if (r.spawnError !== undefined) rec.message = plain.failed("the sign-in command is not installed on this Mac");
          else rec.message = plain.unfinished(r.timedOut ? "it took too long, so Offload stopped waiting" : "the sign-in window closed with an error");
          rec.detail = "The connector on this Mac did not finish the sign-in.";
          ctx.log?.(`brain: link ${c.id}: the auth command ended (exit ${String(r.code)}${r.timedOut ? ", timed out" : ""})`);
        })
        .catch(() => {}),
    );
    return rec;
  },
  async poll(ctx, rec) {
    const c = ctx.connector;
    if (ctx.status[c.id] === "connected") markConnected(rec, c.name, ctx.now);
    else if (rec.signedIn) rec.message = plain.signedInNotAdded(c.name, `${c.name} server`);
  },
};

/** A declared seam that is not built yet: it fails at once and the next method is offered. */
export function unavailableMethod(method: Method): LinkMethod {
  return {
    method,
    available: false,
    async start(ctx) {
      return progress(method, ctx.now, { state: "failed", message: plain.notYet, detail: plain.notYet });
    },
    async poll() {},
  };
}

export type LinkRegistry = Map<Method, LinkMethod>;
/** The default registry: mcp and composio work; api and computer are seams. */
export const LINK_METHODS: LinkRegistry = new Map<Method, LinkMethod>([
  ["mcp", MCP_METHOD],
  ["composio", COMPOSIO_METHOD],
  ["api", unavailableMethod("api")],
  ["computer", unavailableMethod("computer")],
]);
/** Registers (or replaces) a method, e.g. computer use in s13. */
export function registerLinkMethod(m: LinkMethod, registry: LinkRegistry = LINK_METHODS): void {
  registry.set(m.method, m);
}

/** The method to offer after `current` failed: the next available one in `methods`, wrapping around; null if none. */
export function nextMethod(methods: readonly Method[], current: Method, registry: LinkRegistry = LINK_METHODS): Method | null {
  const i = methods.indexOf(current);
  const order = i < 0 ? methods : [...methods.slice(i + 1), ...methods.slice(0, i)];
  return order.find((m) => m !== current && registry.get(m)?.available === true) ?? null;
}

export interface LinkerOptions {
  home: string;
  env: Env;
  modelLabel: ModelLabel;
  now: () => number;
  /** Stub: how long the demo sign-in takes (default OFFLOAD_STUB_LINK_MS or 2000 ms). */
  linkMs?: number;
  runner?: LinkRunner;
  log?: (line: string) => void;
  /** Methods by name (default LINK_METHODS). */
  registry?: LinkRegistry;
}

export class Linker {
  private readonly links = new Map<string, LinkProgress>();
  private readonly runner: LinkRunner;
  private readonly linkMs: number;
  private readonly registry: LinkRegistry;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly o: LinkerOptions) {
    this.runner = o.runner ?? new SpawnLinkRunner();
    this.linkMs = o.linkMs ?? stubLinkMs(o.env);
    this.registry = o.registry ?? LINK_METHODS;
  }

  private get simulated(): boolean {
    return this.o.modelLabel === "stub";
  }

  /** Background spawns (a local connector's auth command); tests wait on them. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private connector(id: string): Connector {
    const c = CONNECTORS.find((x) => x.id === id);
    if (c === undefined) throw new LinkNotFound(`unknown connector ${id}`);
    return c;
  }

  private context(c: Connector): LinkMethodContext {
    const cfg = loadConnectorsConfig(this.o.home).config;
    return {
      connector: c,
      cfg,
      status: catalogStatus(cfg, this.o.env),
      env: this.o.env,
      home: this.o.home,
      now: this.o.now(),
      runner: this.runner,
      ...(this.o.log === undefined ? {} : { log: this.o.log }),
      track: (p) => {
        const t: Promise<unknown> = p.finally(() => this.inflight.delete(t));
        this.inflight.add(t);
      },
      isCurrent: (rec) => this.links.get(c.id) === rec,
    };
  }

  private dto(ctx: LinkMethodContext, methods: readonly Method[], r: { method: Method; state: LinkProgress["state"]; message: string; detail?: string; url?: string | null; startedAt?: number | null; connectedAt?: number | null }): ConnectLinkDTO {
    const c = ctx.connector;
    return {
      connectorId: c.id,
      name: c.name,
      via: viaOf(r.method),
      method: r.method,
      methods: [...methods],
      next: r.state === "failed" ? nextMethod(methods, r.method, this.registry) : null,
      state: r.state,
      url: r.url ?? null,
      simulated: this.simulated,
      message: r.message,
      detail: r.detail ?? METHOD_DETAIL[r.method],
      startedAt: r.startedAt ?? null,
      connectedAt: r.connectedAt ?? null,
    };
  }

  /** POST: starts a sign-in with `method` (default: the running one, else the first of resolutionMethods). */
  async start(id: string, opts: { restart?: boolean; method?: Method } = {}): Promise<ConnectLinkDTO> {
    const c = this.connector(id);
    const ctx = this.context(c);
    const methods = resolutionMethods(c.id, ctx.cfg);
    const cur = this.links.get(c.id);
    const method = opts.method ?? (cur?.state === "waiting" ? cur.method : methods[0]!);
    const sim = this.simulated ? readSim(this.o.home) : {};
    if (sim[c.id] !== undefined || ctx.status[c.id] === "connected") {
      return this.dto(ctx, methods, { method: cur?.method ?? method, state: "connected", message: this.simulated ? plain.connectedDemo(c.name) : plain.connected(c.name), startedAt: cur?.startedAt ?? null, connectedAt: sim[c.id] ?? cur?.connectedAt ?? null });
    }
    if (cur !== undefined && cur.state === "waiting" && cur.method === method && opts.restart !== true) return this.poll(id);
    let rec: LinkProgress;
    const impl = this.registry.get(method);
    if (!methods.includes(method)) rec = progress(method, ctx.now, { state: "failed", message: plain.failed(`that way of connecting does not work for ${c.name} yet`), detail: plain.notFor(c.name) });
    else if (impl === undefined || !impl.available) rec = await (impl ?? unavailableMethod(method)).start(ctx);
    else if (this.simulated) {
      // Deterministic demo sign-in per method; OFFLOAD_STUB_LINK_FAIL makes the listed methods fail.
      rec = stubFailures(this.o.env).has(method)
        ? progress(method, ctx.now, { state: "failed", message: plain.failed(plain.stubFail[method].replace(/\.$/, "").replace(/^./, (x) => x.toLowerCase())), detail: plain.stubFail[method] })
        : progress(method, ctx.now, { state: "waiting", message: plain.waitingDemo });
    } else {
      // Placeholder first, so a background completion of this start sees itself as current.
      this.links.set(c.id, progress(method, ctx.now, { state: "waiting", message: "" }));
      const placeholder = this.links.get(c.id)!;
      rec = await impl.start({ ...ctx, isCurrent: (r) => this.links.get(c.id) === r || (this.links.get(c.id) === placeholder && r !== placeholder) });
    }
    this.links.set(c.id, rec);
    return this.dto(ctx, methods, rec);
  }

  /** GET /link and GET /status: the state of the sign-in. */
  async poll(id: string): Promise<ConnectLinkDTO> {
    const c = this.connector(id);
    const ctx = this.context(c);
    const methods = resolutionMethods(c.id, ctx.cfg);
    const rec = this.links.get(c.id);
    if (this.simulated) {
      const sim = readSim(this.o.home);
      if (sim[c.id] !== undefined || ctx.status[c.id] === "connected") return this.dto(ctx, methods, { method: rec?.method ?? methods[0]!, state: "connected", message: plain.connectedDemo(c.name), connectedAt: sim[c.id] ?? rec?.connectedAt ?? null, startedAt: rec?.startedAt ?? null });
      if (rec === undefined) return this.dto(ctx, methods, { method: methods[0]!, state: "idle", message: plain.idle(c.name) });
      if (rec.state === "waiting" && ctx.now - rec.startedAt >= this.linkMs) {
        writeSim(this.o.home, c.id, ctx.now);
        rec.state = "connected";
        rec.connectedAt = ctx.now;
        rec.message = plain.connectedDemo(c.name);
      }
      return this.dto(ctx, methods, rec);
    }
    if (rec === undefined) {
      const connected = ctx.status[c.id] === "connected";
      return this.dto(ctx, methods, { method: methods[0]!, state: connected ? "connected" : "idle", message: connected ? plain.connected(c.name) : plain.idle(c.name) });
    }
    if (rec.state === "waiting") await (this.registry.get(rec.method) ?? unavailableMethod(rec.method)).poll(ctx, rec);
    else if (rec.state !== "connected" && ctx.status[c.id] === "connected") markConnected(rec, c.name, ctx.now);
    return this.dto(ctx, methods, rec);
  }
}

/** Every message and detail the link routes can show, for the plain-words lint in the tests. */
export const LINK_MESSAGES_FOR_LINT: readonly string[] = [
  plain.waitingReal,
  plain.waitingDemo,
  plain.waitingWindow("Gmail"),
  plain.connected("Gmail"),
  plain.connectedDemo("Gmail"),
  plain.idle("Gmail"),
  plain.failed("the Composio command is not installed on this Mac"),
  plain.failed("Composio did not answer in time"),
  plain.failed("Composio stopped with an error"),
  plain.failed("Composio did not give a sign-in link"),
  plain.failed("the sign-in command is not installed on this Mac"),
  plain.failed("there is no connector for Slack on this Mac yet"),
  plain.failed("that way of connecting does not work for Slack yet"),
  plain.failed("the connector on this Mac did not answer"),
  plain.unfinished("it took too long, so Offload stopped waiting"),
  plain.unfinished("the sign-in window closed with an error"),
  plain.signedInNotAdded("Gmail", "Composio server"),
  plain.signedInNotAdded("Gmail", "Gmail server"),
  plain.notYet,
  plain.notFor("Slack"),
  "The connector on this Mac did not finish the sign-in.",
  ...Object.values(plain.stubFail),
  ...Object.values(METHOD_DETAIL),
  DEMO_SEND_REFUSED,
];
