// The brain's local API: Bun.serve on 127.0.0.1, bearer token, read-only GET routes (brain/API.md).
import { localDay, migrateBrainKeys, startPurgeSchedule } from "../store/vault.ts";
import type { ObserverEnv } from "../store/observer.ts";
import { observerStatus } from "./observer-route.ts";
import { randomBytes } from "node:crypto";
import { analyzeHome, type Analysis, type AnalyzeOptions } from "../analyze.ts";
import { DAY_RE, storeFingerprint } from "../store/reader.ts";
import type { Env } from "../connectors/config.ts";
import { AgentSdkModel, type Model } from "../models/model.ts";
import { AgentSdkExecutor, type Executor } from "../workflows/executor.ts";
import { dashboard } from "../workflows/service.ts";
import { toEvidence, toInsights, toStatus, toTimeline } from "./dto.ts";
import { BRAIN_READY_PREFIX, type BrainReadyDTO } from "./types.ts";
import { authorized, error, gate, json, LOOPBACK, secure } from "./http.ts";
import { workflowRoute } from "./workflow-routes.ts";

export interface BrainOptions {
  home: string;
  token: string;
  now?: () => number;
  analyze?: Omit<AnalyzeOptions, "reviewSeconds" | "now">;
  /** s05: model for drafts and cards (default: Agent SDK), executor for approved batches (default: Agent SDK),
   * env for connector secrets (default process.env). Tests pass StubModel and ScriptedExecutor. */
  workflows?: { model?: Model; executor?: Executor; env?: Env };
  /** OFFLOAD_OBSERVER_BIN for GET /observer (default process.env). */
  observerEnv?: ObserverEnv;
  /** Startup and purge log lines (default stderr, so nothing precedes the ready line on stdout). */
  log?: (line: string) => void;
}

export interface Brain {
  handle(req: Request): Promise<Response>;
  /** Resolves when background work (sending approved batches) has finished. */
  idle(): Promise<void>;
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
  const wctx = {
    home: opts.home,
    env,
    model: opts.workflows?.model ?? new AgentSdkModel(),
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
    if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method_not_allowed");

    if (path === "/status") return json(200, toStatus(await analysis(undefined), now()));
    if (path === "/observer") return json(200, await observerStatus(opts.home, opts.observerEnv ?? process.env, now()));
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

  return {
    async idle(): Promise<void> {
      while (background.size > 0) await Promise.all([...background]);
    },
    async handle(req: Request): Promise<Response> {
      try {
        return secure(await route(req));
      } catch (err) {
        console.error("brain: request failed", req.method, new URL(req.url).pathname, err);
        return secure(error(500, "internal"));
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

export async function startBrainServer(opts: BrainOptions & { port?: number }): Promise<RunningBrain> {
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
      stopPurge();
      await listener.stop(true);
    },
  };
}
