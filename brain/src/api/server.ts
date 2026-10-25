// The brain's local API: Bun.serve on 127.0.0.1, bearer token, read-only GET routes (brain/API.md).
import { localDay, migrateBrainKeys, startPurgeSchedule } from "../store/vault.ts";
import type { ObserverEnv } from "../store/observer.ts";
import { observerControl, observerStatus } from "./observer-route.ts";
import { SCHEDULER_INTERVAL_MS, schedulerTick, type SchedulerTick } from "./scheduler.ts";
import { randomBytes } from "node:crypto";
import { analyzeHome, type Analysis, type AnalyzeOptions } from "../analyze.ts";
import { DAY_RE, storeFingerprint } from "../store/reader.ts";
import type { Env } from "../connectors/config.ts";
import { AgentSdkModel, StubModel, type Model } from "../models/model.ts";
import { AgentSdkExecutor, type Executor } from "../workflows/executor.ts";
import { dashboard } from "../workflows/service.ts";
import { toEvidence, toInsights, toStatus, toTimeline } from "./dto.ts";
import { BRAIN_READY_PREFIX, MODEL_HEADER, type BrainReadyDTO, type ModelLabel } from "./types.ts";
import { authorized, error, gate, json, LOOPBACK, secure } from "./http.ts";
import { workflowRoute } from "./workflow-routes.ts";

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
}

export interface Brain {
  handle(req: Request): Promise<Response>;
  /** Resolves when background work (sending approved batches) has finished. */
  idle(): Promise<void>;
  /** s09b: one pass of the run loop at `now()` (api/scheduler.ts). `serve` calls it every SCHEDULER_INTERVAL_MS. */
  schedulerTick(): Promise<SchedulerTick>;
  /** "stub" or "real": on every response (MODEL_HEADER, and `model` in 2xx JSON object bodies). */
  readonly modelLabel: ModelLabel;
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
    const key = `${storeFingerprint(opts.home)}#${localDay(now())}#${reviewSeconds ?? "default"}`;
    let hit = cache.get(key);
    if (hit === undefined) {
      if (cache.size >= 8) cache.clear();
      hit = analyzeHome(opts.home, { ...opts.analyze, now, ...(reviewSeconds === undefined ? {} : { reviewSeconds }) });
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
    }
    return hit;
  };

  const background = new Set<Promise<unknown>>();
  const env = opts.workflows?.env ?? process.env;
  const model = opts.workflows?.model ?? new AgentSdkModel();
  const modelLabel: ModelLabel = opts.workflows?.modelLabel ?? (model instanceof StubModel ? "stub" : "real");
  const observerEnv = opts.observerEnv ?? process.env;
  const wctx = {
    home: opts.home,
    env,
    model,
    modelLabel,
    executor: opts.workflows?.executor ?? new AgentSdkExecutor(),
    now,
    analysis: () => analysis(undefined),
    background: (p: Promise<unknown>) => {
      const tracked = p.catch((err: unknown) => console.error("brain: background run failed", err)).finally(() => background.delete(tracked));
      background.add(tracked);
    },
  };

  async function route(req: Request): Promise<Response> {
    const refused = gate(req);
    if (refused !== null) return refused;
    if (!authorized(req, opts.token)) return error(401, "unauthorized");
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
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
    if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method_not_allowed");

    if (path === "/status") return json(200, toStatus(await analysis(undefined), now()));
    if (path === "/observer") return json(200, await observerStatus(opts.home, observerEnv, now()));
    if (path === "/dashboard") return json(200, dashboard(await analysis(undefined), opts.home, env, now()));
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
  // Brain artefacts with OCR or mail text: purged at startup and every hour (store/vault.ts, REVIEW-1 H4).
  const stopPurge = startPurgeSchedule(opts.home, now, { log });
  // s09b run loop: starts due workflows (only active ones; see api/scheduler.ts). First tick right away.
  const interval = opts.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS;
  const tick = () => void brain.schedulerTick().catch((err: unknown) => log(`brain: scheduler failed: ${err instanceof Error ? err.message : String(err)}`));
  const timer = interval > 0 ? setInterval(tick, interval) : null;
  if (timer !== null) setTimeout(tick, 0);
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
      stopPurge();
      await listener.stop(true);
    },
  };
}
