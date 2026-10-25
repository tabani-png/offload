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

/** "composio" when an http server lists the id, "gmail-mcp" when a stdio server does, else from the catalog `how`. */
export function linkVia(c: Connector, cfg: ConnectorsConfig | null): ConnectLinkDTO["via"] {
  const servers = Object.values(cfg?.servers ?? {}).filter((s) => s.catalog.includes(c.id));
  if (servers.some((s) => s.type === "http")) return "composio";
  if (servers.some((s) => s.type === "stdio")) return "gmail-mcp";
  return c.how === "gmail-mcp" ? "gmail-mcp" : "composio";
}

/** The Gmail MCP server's auth command: the configured stdio server's command and args plus "auth", or the default. */
export function gmailAuthArgv(c: Connector, cfg: ConnectorsConfig | null): string[] {
  const s = Object.values(cfg?.servers ?? {}).find((x) => x.type === "stdio" && x.catalog.includes(c.id));
  return s !== undefined && s.type === "stdio" ? [s.command, ...s.args, "auth"] : [...DEFAULT_GMAIL_AUTH];
}

// ---------- the link state machine ----------

export const DEFAULT_STUB_LINK_MS = 2_000;

/** OFFLOAD_STUB_LINK_MS: an integer 0..60000, else the default. */
export function stubLinkMs(env: Env): number {
  const v = env.OFFLOAD_STUB_LINK_MS;
  if (v === undefined || !/^\d{1,5}$/.test(v)) return DEFAULT_STUB_LINK_MS;
  const n = Number(v);
  return n <= 60_000 ? n : DEFAULT_STUB_LINK_MS;
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
}

interface LinkRecord {
  via: ConnectLinkDTO["via"];
  state: ConnectLinkDTO["state"];
  url: string | null;
  message: string;
  startedAt: number;
  connectedAt: number | null;
  /** Real mode: the account is signed in (Composio list active, or the auth command finished). */
  signedIn: boolean;
  lastPollAt: number;
  generation: number;
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
};

/** Why a spawn failed, in plain words for a person. */
function reasonOf(r: LinkRunResult, what: string): string {
  if (r.spawnError !== undefined) return `the ${what} command is not installed on this Mac`;
  if (r.timedOut) return `${what} did not answer in time`;
  return `${what} stopped with an error`;
}

export class Linker {
  private readonly links = new Map<string, LinkRecord>();
  private readonly runner: LinkRunner;
  private readonly linkMs: number;
  private generation = 0;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly o: LinkerOptions) {
    this.runner = o.runner ?? new SpawnLinkRunner();
    this.linkMs = o.linkMs ?? stubLinkMs(o.env);
  }

  private get simulated(): boolean {
    return this.o.modelLabel === "stub";
  }

  /** Background spawns (the Gmail auth command); tests wait on them. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  private connector(id: string): Connector {
    const c = CONNECTORS.find((x) => x.id === id);
    if (c === undefined) throw new LinkNotFound(`unknown connector ${id}`);
    return c;
  }

  private realStatus(): { cfg: ConnectorsConfig | null; status: Record<string, ConnectorStatus> } {
    const cfg = loadConnectorsConfig(this.o.home).config;
    return { cfg, status: catalogStatus(cfg, this.o.env) };
  }

  private dto(c: Connector, via: ConnectLinkDTO["via"], r: { state: LinkRecord["state"]; message: string; url?: string | null; startedAt?: number | null; connectedAt?: number | null }): ConnectLinkDTO {
    return { connectorId: c.id, name: c.name, via, state: r.state, url: r.url ?? null, simulated: this.simulated, message: r.message, startedAt: r.startedAt ?? null, connectedAt: r.connectedAt ?? null };
  }

  /** POST: starts a sign-in (or returns the one running / the connection there is). */
  async start(id: string, opts: { restart?: boolean } = {}): Promise<ConnectLinkDTO> {
    const c = this.connector(id);
    const { cfg, status } = this.realStatus();
    const via = linkVia(c, cfg);
    const now = this.o.now();
    if (this.simulated) {
      const sim = readSim(this.o.home);
      if (sim[c.id] !== undefined || status[c.id] === "connected") return this.dto(c, via, { state: "connected", message: plain.connectedDemo(c.name), connectedAt: sim[c.id] ?? null, startedAt: this.links.get(c.id)?.startedAt ?? null });
      const cur = this.links.get(c.id);
      if (cur !== undefined && cur.state === "waiting" && opts.restart !== true) return this.poll(id);
      const rec: LinkRecord = { via, state: "waiting", url: null, message: plain.waitingDemo, startedAt: now, connectedAt: null, signedIn: false, lastPollAt: 0, generation: ++this.generation };
      this.links.set(c.id, rec);
      return this.dto(c, via, rec);
    }
    if (status[c.id] === "connected") {
      const cur = this.links.get(c.id);
      return this.dto(c, via, { state: "connected", message: plain.connected(c.name), startedAt: cur?.startedAt ?? null, connectedAt: cur?.connectedAt ?? null });
    }
    const cur = this.links.get(c.id);
    if (cur !== undefined && cur.state === "waiting" && opts.restart !== true) return this.poll(id);
    const gen = ++this.generation;
    if (via === "composio") {
      const r = await this.runner.run(["composio", "link", composioToolkit(c), "--no-browser", "--no-wait"], { timeoutMs: COMPOSIO_START_TIMEOUT_MS, env: linkEnv(this.o.env) });
      const url = firstHttpsUrl(`${r.stdout}\n${r.stderr}`);
      if (r.code !== 0 || url === null) {
        const reason = r.code === 0 ? "Composio did not give a sign-in link" : reasonOf(r, "Composio");
        const failed: LinkRecord = { via, state: "failed", url: null, message: plain.failed(reason), startedAt: now, connectedAt: null, signedIn: false, lastPollAt: 0, generation: gen };
        this.links.set(c.id, failed);
        this.o.log?.(`brain: link ${c.id}: composio link did not start (exit ${String(r.code)}${r.timedOut ? ", timed out" : ""})`);
        return this.dto(c, via, failed);
      }
      const rec: LinkRecord = { via, state: "waiting", url, message: c.id === "gmail" ? plain.waitingReal : plain.waitingReal.replace("Gmail", c.name), startedAt: now, connectedAt: null, signedIn: false, lastPollAt: 0, generation: gen };
      this.links.set(c.id, rec);
      return this.dto(c, via, rec);
    }
    // Gmail MCP: its one-time auth command opens a browser window and waits for the sign-in; it runs in the
    // background, bounded by GMAIL_AUTH_TIMEOUT_MS.
    const rec: LinkRecord = { via, state: "waiting", url: null, message: plain.waitingWindow(c.name), startedAt: now, connectedAt: null, signedIn: false, lastPollAt: 0, generation: gen };
    this.links.set(c.id, rec);
    const p = this.runner
      .run(gmailAuthArgv(c, cfg), { timeoutMs: GMAIL_AUTH_TIMEOUT_MS, env: linkEnv(this.o.env) })
      .then((r) => {
        const live = this.links.get(c.id);
        if (live === undefined || live.generation !== gen || live.state !== "waiting") return;
        if (r.code === 0) {
          live.signedIn = true;
          return;
        }
        live.state = "failed";
        live.message = r.spawnError !== undefined ? plain.failed("the sign-in command is not installed on this Mac") : plain.unfinished(r.timedOut ? "it took too long, so Offload stopped waiting" : "the sign-in window closed with an error");
        this.o.log?.(`brain: link ${c.id}: the auth command ended (exit ${String(r.code)}${r.timedOut ? ", timed out" : ""})`);
      })
      .catch(() => {})
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return this.dto(c, via, rec);
  }

  /** GET: the state of the sign-in. */
  async poll(id: string): Promise<ConnectLinkDTO> {
    const c = this.connector(id);
    const { cfg, status } = this.realStatus();
    const via = this.links.get(c.id)?.via ?? linkVia(c, cfg);
    const now = this.o.now();
    const rec = this.links.get(c.id);
    if (this.simulated) {
      const sim = readSim(this.o.home);
      if (sim[c.id] !== undefined || status[c.id] === "connected") return this.dto(c, via, { state: "connected", message: plain.connectedDemo(c.name), connectedAt: sim[c.id] ?? rec?.connectedAt ?? null, startedAt: rec?.startedAt ?? null });
      if (rec === undefined) return this.dto(c, via, { state: "idle", message: plain.idle(c.name) });
      if (rec.state === "waiting" && now - rec.startedAt >= this.linkMs) {
        writeSim(this.o.home, c.id, now);
        rec.state = "connected";
        rec.connectedAt = now;
        rec.message = plain.connectedDemo(c.name);
      }
      return this.dto(c, via, rec);
    }
    if (status[c.id] === "connected" && (rec === undefined || rec.via !== "composio" || rec.signedIn || rec.state !== "waiting")) {
      if (rec !== undefined && rec.state !== "connected") {
        rec.state = "connected";
        rec.connectedAt = now;
        rec.message = plain.connected(c.name);
        rec.url = null;
      }
      return this.dto(c, via, { state: "connected", message: plain.connected(c.name), startedAt: rec?.startedAt ?? null, connectedAt: rec?.connectedAt ?? null });
    }
    if (rec === undefined) return this.dto(c, via, { state: "idle", message: plain.idle(c.name) });
    if (rec.state !== "waiting") return this.dto(c, via, rec);
    if (rec.via === "composio" && now - rec.lastPollAt >= POLL_MIN_INTERVAL_MS) {
      rec.lastPollAt = now;
      const r = await this.runner.run(["composio", "link", composioToolkit(c), "--list"], { timeoutMs: COMPOSIO_LIST_TIMEOUT_MS, env: linkEnv(this.o.env) });
      if (r.code === 0 && listShowsActive(r.stdout)) rec.signedIn = true;
    }
    if (rec.signedIn) {
      // Re-read: the server may have been added meanwhile.
      if (catalogStatus(loadConnectorsConfig(this.o.home).config, this.o.env)[c.id] === "connected") {
        rec.state = "connected";
        rec.connectedAt = now;
        rec.message = plain.connected(c.name);
        rec.url = null;
      } else rec.message = plain.signedInNotAdded(c.name, rec.via === "composio" ? "Composio server" : "Gmail server");
    }
    return this.dto(c, via, rec);
  }
}

/** Every message the link routes can show, for the plain-words lint in the tests. */
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
  plain.unfinished("it took too long, so Offload stopped waiting"),
  plain.unfinished("the sign-in window closed with an error"),
  plain.signedInNotAdded("Gmail", "Composio server"),
  plain.signedInNotAdded("Gmail", "Gmail server"),
  DEMO_SEND_REFUSED,
];
