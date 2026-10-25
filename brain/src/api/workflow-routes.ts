// s05 routes: workflows, dry run, approval, run, pause/resume, delete, connectors (brain/API.md).
// Writes are POST/DELETE with a JSON body of at most 64 KB. The approval gate itself lives in workflows/gate.ts.
import type { Analysis } from "../analyze.ts";
import { loadConnectorsConfig, toMcpServers, type Env } from "../connectors/config.ts";
import type { Model } from "../models/model.ts";
import { draftWorkflow, NotFoundError } from "../workflows/drafter.ts";
import { dryRun, DryRunError } from "../workflows/dryrun.ts";
import type { Executor } from "../workflows/executor.ts";
import { approveBatch, executeBatch, prepareLiveBatch, RunError } from "../workflows/runner.ts";
import { batchSummary, connectorStatus, connectorsResponse, detailOf, summaryOf } from "../workflows/service.ts";
import { deleteWorkflow, listWorkflows, readBatch, readWorkflow, updateWorkflow, WORKFLOW_ID_RE } from "../workflows/store.ts";
import { error, json } from "./http.ts";
import { API_VERSION, type ApproveResponse, type RunResponse, type WorkflowsResponse } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export interface WorkflowContext {
  home: string;
  env: Env;
  model: Model;
  executor: Executor;
  now: () => number;
  analysis: () => Promise<Analysis>;
  /** Background work (sending an approved batch). The server keeps the promise so tests can wait. */
  background: (p: Promise<unknown>) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: "bad_request" | "not_found" | "conflict" | "payload_too_large" | "method_not_allowed",
    message: string,
  ) {
    super(message);
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", `body over ${MAX_BODY_BYTES} bytes`);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", `body over ${MAX_BODY_BYTES} bytes`);
  if (text.trim() === "") return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(400, "bad_request", "content-type must be application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_request", "body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "bad_request", "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

const methods = (req: Request, ...allowed: string[]) => {
  if (!allowed.includes(req.method) && !(req.method === "HEAD" && allowed.includes("GET"))) throw new HttpError(405, "method_not_allowed", `use ${allowed.join(" or ")}`);
};

function mustWorkflow(home: string, id: string) {
  const wf = WORKFLOW_ID_RE.test(id) ? readWorkflow(home, id) : null;
  if (wf === null) throw new HttpError(404, "not_found", "unknown workflow id");
  return wf;
}

/** Handles /workflows* and /connectors. Returns null for other paths. */
export async function workflowRoute(req: Request, path: string, ctx: WorkflowContext): Promise<Response | null> {
  if (path !== "/connectors" && path !== "/workflows" && !path.startsWith("/workflows/")) return null;
  try {
    return await route(req, path, ctx);
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.code, err.message);
    if (err instanceof NotFoundError || err instanceof DryRunError) return error(404, "not_found", err.message);
    if (err instanceof RunError) return error(err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400, err.code, err.message);
    throw err;
  }
}

async function route(req: Request, path: string, ctx: WorkflowContext): Promise<Response> {
  const status = () => connectorStatus(ctx.home, ctx.env);

  if (path === "/connectors") {
    methods(req, "GET");
    return json(200, connectorsResponse(await ctx.analysis(), ctx.home, ctx.env));
  }
  if (path === "/workflows") {
    methods(req, "GET");
    const st = status();
    const res: WorkflowsResponse = { version: API_VERSION, workflows: listWorkflows(ctx.home).map((w) => summaryOf(ctx.home, w, st)) };
    return json(200, res);
  }
  if (path === "/workflows/draft") {
    methods(req, "POST");
    const b = await body(req);
    if (typeof b.insightId !== "string" || !/^ins_[A-Za-z0-9_-]{1,64}$/.test(b.insightId)) throw new HttpError(400, "bad_request", "insightId is required");
    const { workflow, created } = draftWorkflow({ home: ctx.home, analysis: await ctx.analysis(), insightId: b.insightId, now: ctx.now });
    return json(created ? 201 : 200, detailOf(ctx.home, workflow, status()));
  }

  const m = /^\/workflows\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (m === null) throw new HttpError(404, "not_found", "unknown path");
  const id = m[1]!;
  const action = m[2];

  if (action === undefined) {
    methods(req, "GET", "DELETE");
    const wf = mustWorkflow(ctx.home, id);
    if (req.method === "DELETE") {
      deleteWorkflow(ctx.home, wf.id);
      return json(200, { version: API_VERSION, deleted: wf.id });
    }
    return json(200, detailOf(ctx.home, wf, status()));
  }

  methods(req, "POST");
  const wf = mustWorkflow(ctx.home, id);
  const b = await body(req);
  const now = ctx.now();

  switch (action) {
    case "dry-run": {
      const limit = b.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) throw new HttpError(400, "bad_request", "limit must be an integer in [1, 50]");
      return json(200, await dryRun({ home: ctx.home, analysis: await ctx.analysis(), workflowId: wf.id, model: ctx.model, now: ctx.now, ...(limit === undefined ? {} : { limit }) }));
    }
    case "run": {
      const batch = await prepareLiveBatch({ home: ctx.home, workflowId: wf.id, model: ctx.model, now: ctx.now });
      if (wf.autoRun) ctx.background(sendBatch(ctx, wf.id, batch.hash, null, wf.connectors));
      const res: RunResponse = { version: API_VERSION, workflowId: wf.id, batch: batchSummary(batch), items: batch.items.map((i) => ({ key: i.key, to: i.to, subject: i.subject, body: i.body, warnings: [...i.warnings] })) };
      return json(201, res);
    }
    case "approve": {
      if (typeof b.batchHash !== "string" || !/^[0-9a-f]{64}$/.test(b.batchHash)) throw new HttpError(400, "bad_request", "batchHash (64 hex chars) is required");
      const hash = b.batchHash;
      // A live batch can only be approved when its connectors can actually be reached.
      const pre = readWorkflow(ctx.home, wf.id)!;
      const missing = summaryOf(ctx.home, pre, status()).connectors.filter((c) => c.required && c.status !== "connected");
      if (readBatch(ctx.home, wf.id, hash)?.kind === "live" && missing.length > 0) throw new HttpError(409, "conflict", `connect ${missing.map((c) => c.name).join(", ")} first (brain/CONNECTORS.md)`);
      const { batch, workflow, token } = approveBatch(ctx.home, wf.id, hash, now);
      if (batch.kind === "live") ctx.background(sendBatch(ctx, wf.id, hash, token, workflow.connectors));
      const res: ApproveResponse = { version: API_VERSION, workflowId: wf.id, batchHash: hash, kind: batch.kind, result: batch.kind === "live" ? "sending" : "activated", workflow: summaryOf(ctx.home, readWorkflow(ctx.home, wf.id)!, status()) };
      return json(200, res);
    }
    case "pause":
    case "resume": {
      const updated = updateWorkflow(ctx.home, wf.id, (w) => {
        if (action === "pause") {
          w.status = "paused";
          w.pausedAt = now;
        } else if (w.status === "paused") {
          w.status = w.activatedAt === null ? "ready_for_review" : "active";
          w.pausedAt = null;
        }
      }, now);
      return json(200, summaryOf(ctx.home, updated, status()));
    }
    case "auto-run": {
      if (typeof b.enabled !== "boolean") throw new HttpError(400, "bad_request", "enabled (boolean) is required");
      const enabled = b.enabled;
      const updated = updateWorkflow(ctx.home, wf.id, (w) => void (w.autoRun = enabled), now);
      return json(200, summaryOf(ctx.home, updated, status()));
    }
    default:
      throw new HttpError(404, "not_found", "unknown workflow action");
  }
}

async function sendBatch(ctx: WorkflowContext, id: string, hash: string, token: string | null, connectors: ReadonlyArray<{ id: string; required: boolean }>): Promise<void> {
  const { config } = loadConnectorsConfig(ctx.home);
  let mcpServers;
  try {
    mcpServers = config === null ? {} : toMcpServers(config, ctx.env, connectors.filter((c) => c.required).map((c) => c.id));
  } catch (err) {
    console.error("brain: cannot resolve MCP servers for", id, err instanceof Error ? err.message : err);
    mcpServers = {};
  }
  await executeBatch({ home: ctx.home, workflowId: id, hash, token, executor: ctx.executor, mcpServers, now: ctx.now });
}
