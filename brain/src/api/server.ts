// The brain's local API: Bun.serve on 127.0.0.1, bearer token, read-only GET routes (brain/API.md).
import { randomBytes } from "node:crypto";
import { analyzeHome, type Analysis, type AnalyzeOptions } from "../analyze.ts";
import { DAY_RE, storeFingerprint } from "../store/reader.ts";
import { toDashboard, toEvidence, toInsights, toStatus, toTimeline } from "./dto.ts";
import { authorized, error, gate, json, LOOPBACK, secure } from "./http.ts";

export interface BrainOptions {
  home: string;
  token: string;
  now?: () => number;
  analyze?: Omit<AnalyzeOptions, "reviewSeconds" | "now">;
}

export interface Brain {
  handle(req: Request): Promise<Response>;
}

export const MIN_TOKEN_LENGTH = 32;

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
    const key = `${storeFingerprint(opts.home)}#${reviewSeconds ?? "default"}`;
    let hit = cache.get(key);
    if (hit === undefined) {
      if (cache.size >= 8) cache.clear();
      hit = analyzeHome(opts.home, { ...opts.analyze, now, ...(reviewSeconds === undefined ? {} : { reviewSeconds }) });
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
    }
    return hit;
  };

  async function route(req: Request): Promise<Response> {
    const refused = gate(req);
    if (refused !== null) return refused;
    if (!authorized(req, opts.token)) return error(401, "unauthorized");
    if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method_not_allowed");
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/status") return json(200, toStatus(await analysis(undefined), now()));
    if (path === "/dashboard") return json(200, toDashboard(await analysis(undefined)));
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
      await listener.stop(true);
    },
  };
}
