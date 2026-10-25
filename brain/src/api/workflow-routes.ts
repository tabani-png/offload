// s05 routes: workflows, dry run, approval, run, pause/resume, delete, connectors (brain/API.md).
// s05c: GET/PUT /workflows/:id/tone (the style card) and /workflows/:id/skill (SKILL.md text only).
// s09b: GET /workflows/:id/dry-runs/latest (the last sealed dry run, opened for the response only).
// Writes are POST/PUT/DELETE with a JSON body of at most 64 KB. The approval gate itself lives in workflows/gate.ts.
import type { Analysis } from "../analyze.ts";
import { loadConnectorsConfig, toMcpServers, type Env } from "../connectors/config.ts";
import type { Model } from "../models/model.ts";
import { draftWorkflow, NotFoundError } from "../workflows/drafter.ts";
import { dryRun, DryRunError, readLastDryRun } from "../workflows/dryrun.ts";
import type { Executor } from "../workflows/executor.ts";
import { approveBatch, executeBatch, prepareLiveBatch, releaseUnknown, requestCancel, RunError } from "../workflows/runner.ts";
import { batchSummary, connectorStatus, connectorsResponse, detailOf, summaryOf } from "../workflows/service.ts";
import { deleteWorkflow, listWorkflows, readBatch, readWorkflow, updateWorkflow, WORKFLOW_ID_RE } from "../workflows/store.ts";
import { applySkillUpdate, SkillEditError, skillDTO } from "../workflows/skill.ts";
import { MAX_TONE_CARD_BYTES, readStyleCard, writeStyleCard, type StyleCard } from "../tone/pack.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { error, json } from "./http.ts";
import { API_VERSION, type ApproveResponse, type ModelLabel, type RunResponse, type ToneCardDTO, type WorkflowsResponse } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export interface WorkflowContext {
  home: string;
  env: Env;
  model: Model;
  /** s09b: "stub" when `model` is the deterministic test model, else "real". */
  modelLabel: ModelLabel;
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
    if (err instanceof SkillEditError) return error(400, "bad_request", err.message);
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
    const res: WorkflowsResponse = { version: API_VERSION, workflows: listWorkflows(ctx.home).map((w) => summaryOf(ctx.home, w, st, ctx.now())) };
    return json(200, res);
  }
  if (path === "/workflows/draft") {
    methods(req, "POST");
    const b = await body(req);
    if (typeof b.insightId !== "string" || !/^ins_[A-Za-z0-9_-]{1,64}$/.test(b.insightId)) throw new HttpError(400, "bad_request", "insightId is required");
    const { workflow, created } = draftWorkflow({ home: ctx.home, analysis: await ctx.analysis(), insightId: b.insightId, now: ctx.now });
    return json(created ? 201 : 200, detailOf(ctx.home, workflow, status(), ctx.now()));
  }

  const latest = /^\/workflows\/([^/]+)\/dry-runs\/latest$/.exec(path);
  if (latest !== null) {
    methods(req, "GET");
    const wf = mustWorkflow(ctx.home, latest[1]!);
    // Opened with the day's brain key for this response only; a purged (older than 7 local days) one reads as none.
    const last = readLastDryRun(ctx.home, wf.id, ctx.now());
    if (last === null) throw new HttpError(404, "not_found", "no dry run in the last 7 days: run one");
    return json(200, last);
  }

  const m = /^\/workflows\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (m === null) throw new HttpError(404, "not_found", "unknown path");
  const id = m[1]!;
  const action = m[2];

  if (action === undefined) {
    methods(req, "GET", "DELETE");
    const wf = mustWorkflow(ctx.home, id);
    if (req.method === "DELETE") {
      // Stop a running batch before the folder goes (REVIEW-1 M2).
      requestCancel(ctx.home, wf.id);
      deleteWorkflow(ctx.home, wf.id);
      return json(200, { version: API_VERSION, deleted: wf.id });
    }
    return json(200, detailOf(ctx.home, wf, status(), ctx.now()));
  }

  if (action === "tone" || action === "skill") {
    methods(req, "GET", "PUT");
    const wf = mustWorkflow(ctx.home, id);
    if (action === "skill") return json(200, req.method === "PUT" ? applySkillUpdate(ctx.home, wf.id, await body(req), ctx.now()) : skillDTO(ctx.home, wf));
    if (req.method === "PUT") return json(200, toneDTO(wf, writeStyleCard(ctx.home, wf.bucket, toneText(await body(req)))));
    return json(200, toneDTO(wf, readStyleCard(ctx.home, wf.bucket)));
  }

  methods(req, "POST");
  const wf = mustWorkflow(ctx.home, id);
  const b = await body(req);
  const now = ctx.now();

  switch (action) {
    case "dry-run": {
      const limit = b.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) throw new HttpError(400, "bad_request", "limit must be an integer in [1, 50]");
      return json(200, await dryRun({ home: ctx.home, analysis: await ctx.analysis(), workflowId: wf.id, model: ctx.model, modelLabel: ctx.modelLabel, now: ctx.now, ...(limit === undefined ? {} : { limit }) }));
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
      const missing = summaryOf(ctx.home, pre, status(), ctx.now()).connectors.filter((c) => c.required && c.status !== "connected");
      if (readBatch(ctx.home, wf.id, hash, now)?.kind === "live" && missing.length > 0) throw new HttpError(409, "conflict", `connect ${missing.map((c) => c.name).join(", ")} first (brain/CONNECTORS.md)`);
      const { batch, workflow, token } = approveBatch(ctx.home, wf.id, hash, now);
      if (batch.kind === "live") ctx.background(sendBatch(ctx, wf.id, hash, token, workflow.connectors));
      const res: ApproveResponse = { version: API_VERSION, workflowId: wf.id, batchHash: hash, kind: batch.kind, result: batch.kind === "live" ? "sending" : "activated", workflow: summaryOf(ctx.home, readWorkflow(ctx.home, wf.id)!, status(), ctx.now()) };
      return json(200, res);
    }
    case "release": {
      // Explicit user action: these recipients' sends are "unknown" and the user confirms they did not go out.
      if (typeof b.batchHash !== "string" || !/^[0-9a-f]{64}$/.test(b.batchHash)) throw new HttpError(400, "bad_request", "batchHash (64 hex chars) is required");
      const keys = b.keys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 500 || !keys.every((k) => typeof k === "string" && k.length <= 320)) throw new HttpError(400, "bad_request", "keys (the recipient addresses to release) are required");
      const batch = releaseUnknown(ctx.home, wf.id, b.batchHash, keys as string[], now);
      return json(200, { version: API_VERSION, workflowId: wf.id, batch: batchSummary(batch) });
    }
    case "pause":
    case "resume": {
      // Pausing stops a running batch before its next item (REVIEW-1 M2); the gate also re-reads the status.
      if (action === "pause") requestCancel(ctx.home, wf.id);
      const updated = updateWorkflow(ctx.home, wf.id, (w) => {
        if (action === "pause") {
          w.status = "paused";
          w.pausedAt = now;
        } else if (w.status === "paused") {
          w.status = w.activatedAt === null ? "ready_for_review" : "active";
          w.pausedAt = null;
          // s09b: slots missed while paused are not caught up by the run loop.
          w.lastScheduledAt = now;
        }
      }, now);
      return json(200, summaryOf(ctx.home, updated, status(), ctx.now()));
    }
    case "auto-run": {
      if (typeof b.enabled !== "boolean") throw new HttpError(400, "bad_request", "enabled (boolean) is required");
      const enabled = b.enabled;
      const updated = updateWorkflow(ctx.home, wf.id, (w) => void (w.autoRun = enabled), now);
      return json(200, summaryOf(ctx.home, updated, status(), ctx.now()));
    }
    default:
      throw new HttpError(404, "not_found", "unknown workflow action");
  }
}

// Control characters other than tab, newline and carriage return.
const CARD_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** The card text of a PUT body, validated: only `text`, a non-blank string of at most MAX_TONE_CARD_BYTES. */
function toneText(b: Record<string, unknown>): string {
  for (const k of Object.keys(b)) if (k !== "text") throw new HttpError(400, "bad_request", `${k} is not a tone card field (send { text })`);
  if (typeof b.text !== "string") throw new HttpError(400, "bad_request", "text (the style card markdown) is required");
  if (b.text.trim() === "") throw new HttpError(400, "bad_request", "text must not be blank");
  if (Buffer.byteLength(b.text, "utf8") > MAX_TONE_CARD_BYTES) throw new HttpError(413, "payload_too_large", `a style card is at most ${MAX_TONE_CARD_BYTES} bytes`);
  if (CARD_CONTROL_RE.test(b.text)) throw new HttpError(400, "bad_request", "text has control characters");
  return b.text;
}

function toneDTO(wf: WorkflowJson, card: StyleCard): ToneCardDTO {
  return { version: API_VERSION, workflowId: wf.id, bucket: card.bucket, text: card.text, edited: card.edited, path: card.path, updatedAt: card.updatedAt, maxBytes: MAX_TONE_CARD_BYTES };
}

/** Sends one live batch through the gate with the connectors.json MCP servers. Used by approve, run and the s09b run loop. */
export async function sendBatch(ctx: WorkflowContext, id: string, hash: string, token: string | null, connectors: ReadonlyArray<{ id: string; required: boolean }>): Promise<void> {
  const { config } = loadConnectorsConfig(ctx.home);
  let mcpServers;
  try {
    mcpServers = config === null ? {} : toMcpServers(config, ctx.env, connectors.filter((c) => c.required).map((c) => c.id));
  } catch (err) {
    console.error("brain: cannot resolve MCP servers for", id, err instanceof Error ? err.message : err);
    mcpServers = {};
  }
  // The gate allows a tool only on a server that covers its connector, per connectors.json.
  const servers: Record<string, string[]> = {};
  for (const name of Object.keys(mcpServers)) servers[name] = [...(config?.servers[name]?.catalog ?? [])];
  await executeBatch({ home: ctx.home, workflowId: id, hash, token, executor: ctx.executor, mcpServers, servers, now: ctx.now });
}
