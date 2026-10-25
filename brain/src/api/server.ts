// The brain's local API: Bun.serve on 127.0.0.1, bearer token, read-only GET routes (brain/API.md).
import { localDay, migrateBrainKeys, startPurgeSchedule } from "../store/vault.ts";
import { purgeAll } from "../store/retention.ts";
import type { ObserverEnv } from "../store/observer.ts";
import { observerControl, observerStatus } from "./observer-route.ts";
import { SCHEDULER_INTERVAL_MS, schedulerTick, type SchedulerTick } from "./scheduler.ts";
import { randomBytes } from "node:crypto";
import { analyzeHome, type Analysis, type AnalyzeOptions } from "../analyze.ts";
import { DAY_RE, storeFingerprint } from "../store/reader.ts";
import type { Env } from "../connectors/config.ts";
import { AgentSdkModel, StubModel, type Model } from "../models/model.ts";
import { RoutedModel } from "../models/router.ts";
import { AgentSdkExecutor, type Executor } from "../workflows/executor.ts";
import { dashboard, keptFiles } from "../workflows/service.ts";
import { toEvidence, toInsights, toStatus, toTimeline } from "./dto.ts";
import { BRAIN_READY_PREFIX, CAPTIONER_OFF, MODEL_HEADER, type BrainReadyDTO, type CaptionerStatusDTO, type ModelLabel } from "./types.ts";
import { authorized, error, gate, json, LOOPBACK, secure } from "./http.ts";
import { workflowRoute } from "./workflow-routes.ts";
import { s14Route } from "./s14-routes.ts";
import { syncRoute } from "./sync-routes.ts";
import { SyncClient, type SyncDeps } from "../sync/client.ts";
import { contextStamp, readUserContext } from "../context/store.ts";
import { isMethod, Linker, LinkNotFound, METHODS, simPath, type LinkRunner, type Method } from "../connectors/link.ts";
import { chainDeps, ChainResolver, knownTarget, toChainDTO, type ChainDeps, type MethodProbe } from "../connectors/chain.ts";
import { chainLinkRegistry } from "../connectors/methods.ts";
import { anthropicMessages, ClaudePlanner, type MessagesApi, type PickModel, type Planner } from "../connectors/computer/claude.ts";
import type { ComputerDriver } from "../connectors/computer/driver.ts";
import { OsaDriver } from "../connectors/computer/osa-driver.ts";
import { ComputerSessions, STOP_REASONS } from "../connectors/computer/session.ts";
import { API_VERSION, type CapabilitiesResponse, type ConnectLinkDTO } from "./types.ts";
import { CAPABILITIES, capabilityById, capabilityDTO, CATALOG_CHECKED_AT } from "../connectors/capabilities.ts";
import { existsSync } from "node:fs";
import { connectionsRoute, startUniverseRefresh, type ConnectionsContext } from "./connections-routes.ts";
import { readUniverse, universeStatus } from "../connectors/universe.ts";

export interface BrainOptions {
  home: string;
  token: string;
  now?: () => number;
  analyze?: Omit<AnalyzeOptions, "reviewSeconds" | "now">;
  /** s05: model for drafts and cards (default: Agent SDK), executor for approved batches (default: Agent SDK),
   * env for connector secrets (default process.env). Tests pass StubModel and ScriptedExecutor. */
  workflows?: { model?: Model; executor?: Executor; env?: Env; modelLabel?: ModelLabel };
  /** OFFLOAD_OBSERVER_BIN for GET /observer (default process.env). */
  observerEnv?: ObserverEnv;
  /** Startup and purge log lines (default stderr, so nothing precedes the ready line on stdout). */
  log?: (line: string) => void;
  /** s10e connect-link routes: the demo sign-in time (stub) and the command runner (real). Tests inject both. */
  link?: { linkMs?: number; runner?: LinkRunner };
  /** s13 connector chain: probe dependencies (runner, MCP lister, fetch, secrets, computer probe), probes, per-method
   * executors, the computer-use driver and planner. Tests inject fakes; nothing real runs unless the real model is on. */
  chain?: {
    deps?: Partial<Omit<ChainDeps, "home" | "env" | "now" | "simulated">>;
    probes?: Map<Method, MethodProbe>;
    executors?: Partial<Record<Method, Executor>>;
    computer?: { driver: ComputerDriver; planner: Planner };
    /** Model per route for computer-use steps (s14's router at merge); default Sonnet 5.5. */
    pickModel?: PickModel;
    /** Send through the chain with the stub model too (tests). */
    always?: boolean;
  };
  /** s11: the caption worker (vision/worker.ts). Its status is `captioner` in GET /status; startBrainServer starts
   * and stops it. Absent = `serve --captioner off`. */
  vision?: VisionHandle;
  /** S2-02 company sync: overrides for the sync client (control URL, fetch, browser opener, signer). Default: the
   * client reads OFFLOAD_CONTROL_URL and stays "not_configured" without it. Nothing is sent before "Connect". */
  sync?: Omit<SyncDeps, "home" | "analysis"> & { analysis?: SyncDeps["analysis"] };
  /** s17: re-sync the Composio app list when it is older than a day (real model, `serve` only; read-only commands). */
  universe?: { autoRefresh?: boolean };
}

/** What the server needs from the caption worker. */
export interface VisionHandle {
  status(): CaptionerStatusDTO;
  start?(): () => void;
}

export interface Brain {
  handle(req: Request): Promise<Response>;
  /** Resolves when background work (sending approved batches) has finished. */
  idle(): Promise<void>;
  /** s09b: one pass of the run loop at `now()` (api/scheduler.ts). `serve` calls it every SCHEDULER_INTERVAL_MS. */
  schedulerTick(): Promise<SchedulerTick>;
  /** "stub" or "real": on every response (MODEL_HEADER, and `model` in 2xx JSON object bodies). */
  readonly modelLabel: ModelLabel;
  /** s10e: resolves when background sign-in commands have ended (tests). */
  linkIdle(): Promise<void>;
  /** s13: the connector chain and the computer-use sessions (tests). */
  readonly chain: ChainResolver;
  readonly computer: ComputerSessions;
  /** S2-02: the company sync client. */
  readonly sync: SyncClient;
  /** s17: starts a background re-sync of the Composio app list when it is stale (real model). True when one runs. */
  refreshUniverseIfStale(): boolean;
}

async function linkBody(req: Request): Promise<{ restart: boolean; method?: Method } | string> {
  const text = await req.text();
  if (text.length > 64 * 1024) return "body over 65536 bytes";
  if (text.trim() === "") return { restart: false };
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return "content-type must be application/json";
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return "body is not JSON";
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "body must be a JSON object";
  for (const k of Object.keys(v)) if (k !== "restart" && k !== "method") return `${k} is not a link field (send {}, { "restart": true } or { "method": ... })`;
  const { restart: r, method: m } = v as { restart?: unknown; method?: unknown };
  if (r !== undefined && typeof r !== "boolean") return "restart must be true or false";
  if (m !== undefined && !isMethod(m)) return `method must be one of ${METHODS.join(", ")}`;
  return { restart: r === true, ...(m === undefined ? {} : { method: m }) };
}

/** Adds the model label: the header on every response, `model` on 2xx JSON object bodies that do not have one. */
async function labelled(res: Response, label: ModelLabel): Promise<Response> {
  const headers = new Headers(res.headers);
  headers.set(MODEL_HEADER, label);
  if (res.status < 200 || res.status >= 300 || !(headers.get("content-type") ?? "").startsWith("application/json")) return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  const text = await res.text();
  let out = text;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === "object" && v !== null && !Array.isArray(v) && !("model" in v)) out = JSON.stringify({ ...v, model: label });
  } catch {
    // Not JSON after all: pass it through.
  }
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}

export const MIN_TOKEN_LENGTH = 32;

/** `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}`: the first stdout line of `serve` (brain/API.md "Connection"). */
export function formatReadyLine(port: number, token: string): string {
  const body: BrainReadyDTO = { port, token };
  return `${BRAIN_READY_PREFIX} ${JSON.stringify(body)}`;
}

/** The ready line's port and token, or null when the line is anything else. */
export function parseReadyLine(line: string): BrainReadyDTO | null {
  if (!line.startsWith(`${BRAIN_READY_PREFIX} `)) return null;
  try {
    const v = JSON.parse(line.slice(BRAIN_READY_PREFIX.length + 1)) as Record<string, unknown>;
    const { port, token } = v;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) return null;
    return { port, token };
  } catch {
    return null;
  }
}

/** OFFLOAD_TOKEN when set (at least 32 chars), otherwise a fresh 256-bit token the caller prints once. */
export function resolveToken(env: Readonly<Record<string, string | undefined>>): { token: string; generated: boolean } {
  const given = env.OFFLOAD_TOKEN;
  if (given !== undefined && given !== "") {
    if (given.length < MIN_TOKEN_LENGTH) throw new Error(`OFFLOAD_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
    return { token: given, generated: false };
  }
  return { token: randomBytes(32).toString("base64url"), generated: true };
}

function parseReviewSeconds(raw: string | null): number | undefined | "invalid" {
  if (raw === null) return undefined;
  if (!/^\d{1,3}(?:\.\d+)?$/.test(raw)) return "invalid";
  const n = Number(raw);
  return n > 0 && n <= 600 ? n : "invalid";
}

export function createBrain(opts: BrainOptions): Brain {
  const now = opts.now ?? Date.now;
  // Cache per store fingerprint and review time; a change to any day file invalidates it.
  const cache = new Map<string, Promise<Analysis>>();
  const analysis = (reviewSeconds: number | undefined): Promise<Analysis> => {
    // The local day is part of the key: a day that ages past 7 days drops out even when no file changed (REVIEW-1 M4).
    // s14: the onboarding context is part of the key (it reaches label prompts); the fingerprint covers frame notes.
    const key = `${storeFingerprint(opts.home)}#${localDay(now())}#${reviewSeconds ?? "default"}#${contextStamp(opts.home)}`;
    let hit = cache.get(key);
    if (hit === undefined) {
      if (cache.size >= 8) cache.clear();
      const stored = opts.analyze?.userContext === undefined ? readUserContext(opts.home).context : undefined;
      hit = analyzeHome(opts.home, { ...opts.analyze, ...(stored === undefined ? {} : { userContext: stored }), now, ...(reviewSeconds === undefined ? {} : { reviewSeconds }) });
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
    }
    return hit;
  };

  const background = new Set<Promise<unknown>>();
  const env = opts.workflows?.env ?? process.env;
  const model = opts.workflows?.model ?? new AgentSdkModel();
  const modelLabel: ModelLabel = opts.workflows?.modelLabel ?? (model instanceof StubModel ? "stub" : "real");
  // s14: the model router behind `model` (ADR 0009), for GET /status `models` and GET /models/usage.
  const router = model instanceof RoutedModel ? model.router : undefined;
  const observerEnv = opts.observerEnv ?? process.env;
  const simulated = modelLabel === "stub";
  if (!simulated && existsSync(simPath(opts.home))) (opts.log ?? ((l: string) => console.error(l)))("brain: connect-sim.json is ignored: demo sign-ins count only with --model stub");
  // s13: the connector chain. Stub model: deterministic probes. The chain shares the link runner (tests inject one).
  const resolver = new ChainResolver(
    chainDeps({ home: opts.home, env, now, simulated, ...(opts.link?.runner === undefined ? {} : { runner: opts.link.runner }), ...(opts.log === undefined ? {} : { log: opts.log }), ...(opts.chain?.deps ?? {}) }),
    opts.chain?.probes,
  );
  const sessions = new ComputerSessions();
  // Computer use: injected (tests), or the real driver and Claude planner only when the person turned it on.
  let computer: { driver: ComputerDriver; planner: Planner; sessions: ComputerSessions } | undefined;
  if (opts.chain?.computer !== undefined) computer = { ...opts.chain.computer, sessions };
  else if (!simulated && env.OFFLOAD_COMPUTER_REAL === "1") {
    let api: MessagesApi | null = null;
    computer = { driver: new OsaDriver(resolver.deps.runner, env), planner: new ClaudePlanner({ create: async (p) => (api ??= await anthropicMessages()).create(p) }, opts.chain?.pickModel ?? (router === undefined ? undefined : (route, ctx) => router.pickModel(route, ctx))), sessions };
  }
  const targetOf = (id: string) => knownTarget(opts.home, id, now());
  const linker = new Linker({
    home: opts.home,
    env,
    modelLabel,
    now,
    registry: chainLinkRegistry(resolver, targetOf),
    // After a Composio sign-in, the CLI path counts once a fresh probe can commit through it (no server needed).
    reachable: async (id, method) => {
      const t = targetOf(id);
      if (t === null) return false;
      const s = (await resolver.resolve(t, { refresh: true })).methods.find((m) => m.method === method);
      return s?.health === "ok" && t.sends.some((c) => s.writes.includes(c));
    },
    resolveConnector: (id) => {
      const t = targetOf(id);
      return t === null || t.catalog ? undefined : { id: t.id, name: t.name, how: `composio:${t.toolkit}`, reach: 0, hosts: t.hosts, apps: t.bundleIds };
    },
    ...(opts.link?.linkMs === undefined ? {} : { linkMs: opts.link.linkMs }),
    ...(opts.link?.runner === undefined ? {} : { runner: opts.link.runner }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
  });
  /** The chain of a connector for the link/status DTO. peek: the cache only; resolve: probe when expired. */
  const withChain = async (dto: ConnectLinkDTO, mode: "peek" | "resolve" | "refresh"): Promise<ConnectLinkDTO> => {
    const t = targetOf(dto.connectorId);
    if (t === null) return dto;
    const d = mode === "peek" ? resolver.peek(t.id) : await resolver.resolve(t, { refresh: mode === "refresh" });
    return d === null ? dto : { ...dto, chain: toChainDTO(t, d, simulated) };
  };
  // S2-02: the sync client. It reads the analysis only for baselines and working time, and flushes after each run.
  const sync = new SyncClient({ home: opts.home, now, ...(opts.log === undefined ? {} : { log: opts.log }), analysis: () => analysis(undefined), ...(opts.sync ?? {}) });
  const wctx = {
    home: opts.home,
    env,
    model,
    modelLabel,
    executor: opts.workflows?.executor ?? new AgentSdkExecutor(),
    now,
    analysis: () => analysis(undefined),
    background: (p: Promise<unknown>) => {
      const tracked = p
        .catch((err: unknown) => console.error("brain: background run failed", err))
        .finally(() => {
          background.delete(tracked);
          // S2-02: run outcomes go out after each run (ADR 0103 §4), when this Mac is connected and not paused.
          if (sync.active()) void sync.afterRun();
        });
      background.add(tracked);
    },
    chain: {
      resolver,
      ...(opts.chain?.executors === undefined ? {} : { executors: opts.chain.executors }),
      ...(computer === undefined ? {} : { computer }),
      ...(opts.chain?.always === true ? { always: true } : {}),
      ...(opts.log === undefined ? {} : { log: opts.log }),
    },
  };

  const connCtx: ConnectionsContext = {
    home: opts.home,
    env,
    now,
    model,
    modelLabel,
    linker,
    resolver,
    analysis: () => analysis(undefined),
    background: wctx.background,
    withChain: (dto) => withChain(dto, simulated ? "resolve" : "peek"),
    log: opts.log ?? ((l: string) => console.error(l)),
  };

  async function route(req: Request): Promise<Response> {
    const refused = gate(req);
    if (refused !== null) return refused;
    if (!authorized(req, opts.token)) return error(401, "unauthorized");
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // s14: context, general drafting and plan choice (api/s14-routes.ts); null = not one of its routes.
    const s14 = await s14Route(req, path, { home: opts.home, env, model, modelLabel, now, analysis: () => analysis(undefined), ...(router === undefined ? {} : { router }) });
    if (s14 !== null) return s14;
    // S2-02: company sync (status, connect, pause/resume, preview, notice ack) and POST /workflows/:id/share.
    const sr = await syncRoute(req, path, sync);
    if (sr !== null) return sr;
    // Workflow routes take POST and DELETE; everything else is read-only.
    const wf = await workflowRoute(req, path, wctx);
    if (wf !== null) return wf;
    // s09b: pause / resume the observer through its CLI.
    const ctl = /^\/observer\/([a-z]+)$/.exec(path);
    if (ctl !== null) {
      const action = ctl[1];
      if (action !== "pause" && action !== "resume") return error(404, "not_found");
      if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
      const r = await observerControl(opts.home, action, observerEnv, now());
      return r.ok ? json(200, r.body) : error(409, "conflict", r.error);
    }
    // s10e: start (POST) or poll (GET) a sign-in for one catalog id. Connecting never sends anything.
    // GET /connectors/:id/status is the generic name of the same poll (GET and HEAD only).
    // s13: the computer-use kill switch (the app maps Esc and its menu item here) and the overlay's session state.
    if (path === "/computer/stop") {
      if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
      return json(200, { stopped: sessions.stop(STOP_REASONS.user), session: sessions.dto() });
    }
    if (path === "/computer/session") {
      if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method_not_allowed", "use GET");
      return json(200, sessions.dto());
    }
    // s17: the Connections center (search any app, one-time setup, read-only test, build).
    const conn = await connectionsRoute(req, path, url, connCtx);
    if (conn !== null) return conn;
    const link = /^\/connectors\/([^/]+)\/(link|status)$/.exec(path);
    if (link !== null) {
      const id = link[1]!;
      const allowed = link[2] === "link" ? ["POST", "GET", "HEAD"] : ["GET", "HEAD"];
      if (!allowed.includes(req.method)) return error(405, "method_not_allowed", link[2] === "link" ? "use GET or POST" : "use GET");
      try {
        // s13: the chain rides along. Stub: always probed (deterministic). Real: /status probes when the cached
        // decision expired (?refresh=1 now); /link answers from the cache so a sign-in poll never spawns a probe.
        const mode = url.searchParams.get("refresh") === "1" ? "refresh" : simulated || link[2] === "status" ? "resolve" : "peek";
        if (req.method === "POST") {
          const b = await linkBody(req);
          if (typeof b === "string") return error(400, "bad_request", b);
          return json(200, await withChain(await linker.start(id, b), mode));
        }
        return json(200, await withChain(await linker.poll(id), mode));
      } catch (err) {
        if (err instanceof LinkNotFound) return error(404, "not_found", "unknown connector id");
        throw err;
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method_not_allowed");

    // s13: the capability -> candidate tools catalog (read-only data) for the workflow builder.
    if (path === "/catalog/capabilities") return json(200, { version: API_VERSION, checkedAt: CATALOG_CHECKED_AT, capabilities: CAPABILITIES.map(capabilityDTO) } satisfies CapabilitiesResponse);
    const capM = /^\/catalog\/capabilities\/([a-z0-9-]{1,64})$/.exec(path);
    if (capM !== null) {
      const cap = capabilityById(capM[1]!);
      return cap === undefined ? error(404, "not_found", "unknown capability id") : json(200, capabilityDTO(cap));
    }
    if (path === "/status") return json(200, { ...toStatus(await analysis(undefined), now(), opts.vision?.status() ?? CAPTIONER_OFF), ...(router === undefined ? {} : { models: router.summary() }) });
    // s10b: plus the user files kept until the user deletes them, for the app's "Observing" section.
    if (path === "/observer") return json(200, { ...(await observerStatus(opts.home, observerEnv, now())), keptFiles: keptFiles(opts.home) });
    if (path === "/dashboard") return json(200, dashboard(await analysis(undefined), opts.home, env, now(), simulated));
    if (path === "/insights") {
      const review = parseReviewSeconds(url.searchParams.get("reviewSeconds"));
      if (review === "invalid") return error(400, "bad_request", "reviewSeconds must be a number in (0, 600]");
      return json(200, toInsights(await analysis(review)));
    }
    const ev = /^\/insights\/([A-Za-z0-9_-]+)\/evidence$/.exec(path);
    if (ev?.[1] !== undefined) {
      const a = await analysis(undefined);
      const insight = a.insights.find((i) => i.id === ev[1]);
      return insight === undefined ? error(404, "not_found", "unknown insight id") : json(200, toEvidence(a, insight));
    }
    if (path === "/timeline") {
      const day = url.searchParams.get("day");
      if (day === null || !DAY_RE.test(day)) return error(400, "bad_request", "day=YYYY-MM-DD is required");
      const a = await analysis(undefined);
      if (!a.windowDays.includes(day)) return error(404, "not_found", `no stored day ${day}`);
      return json(200, toTimeline(a, day));
    }
    return error(404, "not_found");
  }

  let ticking: Promise<SchedulerTick> | null = null;
  return {
    modelLabel,
    chain: resolver,
    computer: sessions,
    sync,
    refreshUniverseIfStale: () => (universeStatus(readUniverse(opts.home), now()).stale ? startUniverseRefresh(connCtx) : false),
    linkIdle: () => linker.idle(),
    async idle(): Promise<void> {
      while (background.size > 0) await Promise.all([...background]);
    },
    schedulerTick(): Promise<SchedulerTick> {
      // One pass at a time: a slow tick (drafting a batch) is not overlapped by the next interval.
      if (ticking !== null) return ticking;
      ticking = schedulerTick(wctx, opts.log ?? ((l: string) => console.error(l))).finally(() => (ticking = null));
      return ticking;
    },
    async handle(req: Request): Promise<Response> {
      try {
        return secure(await labelled(await route(req), modelLabel));
      } catch (err) {
        console.error("brain: request failed", req.method, new URL(req.url).pathname, err);
        return secure(await labelled(error(500, "internal"), modelLabel));
      }
    },
  };
}

export interface RunningBrain {
  hostname: string;
  port: number;
  url: string;
  stop(): Promise<void>;
}

/** `schedulerIntervalMs`: how often the run loop ticks (default SCHEDULER_INTERVAL_MS; 0 turns it off). */
export async function startBrainServer(opts: BrainOptions & { port?: number; schedulerIntervalMs?: number }): Promise<RunningBrain> {
  const brain = createBrain(opts);
  const log = opts.log ?? ((l: string) => console.error(l));
  const now = opts.now ?? Date.now;
  // H4 close-out: raw brain key files from s05b become Keychain-wrapped keys (no-op under OFFLOAD_KEYS=file).
  try {
    const m = migrateBrainKeys(opts.home, now());
    if (m.migrated > 0) log(`brain: wrapped ${m.migrated} raw brain key file(s) with the observer's Keychain key`);
    for (const e of m.errors) log(`brain: key migration: ${e}`);
  } catch (err) {
    log(`brain: key migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Brain artefacts with OCR or mail text: purged now, BEFORE the listener opens, and every hour (store/retention.ts,
  // REVIEW-1 H4, REVIEW-2 N4). The app also runs `cli.ts purge` at launch, and the observer purges expired brain keys.
  const stopPurge = startPurgeSchedule(opts.home, now, { log, purge: purgeAll });
  // s09b run loop: starts due workflows (only active ones; see api/scheduler.ts). First tick right away.
  const interval = opts.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS;
  const tick = () => void brain.schedulerTick().catch((err: unknown) => log(`brain: scheduler failed: ${err instanceof Error ? err.message : String(err)}`));
  const timer = interval > 0 ? setInterval(tick, interval) : null;
  if (timer !== null) setTimeout(tick, 0);
  // s17: the Composio app list, re-synced in the background when it is older than a day (checked every hour).
  const universeTimer = opts.universe?.autoRefresh === true ? setInterval(() => void brain.refreshUniverseIfStale(), 60 * 60_000) : null;
  if (opts.universe?.autoRefresh === true) setTimeout(() => void brain.refreshUniverseIfStale(), 0);
  // s11: the caption worker polls for keyframes in the background (local captioner only).
  const stopVision = opts.vision?.start?.() ?? (() => {});
  // S2-02: background sync flushes (a no-op until this Mac is connected to a company).
  const stopSync = brain.sync.start();
  const listener = Bun.serve({
    hostname: LOOPBACK,
    port: opts.port ?? 0,
    fetch: (req) => brain.handle(req),
    error(err) {
      console.error("brain: server error", err);
      return secure(error(500, "internal"));
    },
  });
  const port = Number(listener.port);
  return {
    hostname: LOOPBACK,
    port,
    url: `http://${LOOPBACK}:${port}/`,
    stop: async () => {
      if (timer !== null) clearInterval(timer);
      if (universeTimer !== null) clearInterval(universeTimer);
      stopVision();
      stopSync();
      stopPurge();
      await listener.stop(true);
    },
  };
}
