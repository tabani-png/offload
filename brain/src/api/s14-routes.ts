// s14 routes (additive, brain/API.md "s14"):
//   GET  /context                      the onboarding context {role, industry} + suggestions
//   PUT  /context {role?, industry?}   store it (null or "" clears a field; unknown keys are refused)
//   POST /workflows/draft {insightId}  for a general insight (not an s05 email template): build the plan, write the
//                                      folder, 201 with the detail; email insights fall through to the s05 route
//   POST /workflows/:id/plan {variant} keep the other variant ("a" | "b"); returns the detail
// Called from server.ts before the s05 workflow routes; returns null for every other request.
import type { Analysis } from "../analyze.ts";
import { ContextError, contextResponse, parseContextBody, readUserContext, writeUserContext } from "../context/store.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import type { ModelRouter } from "../models/router.ts";
import { DEFAULT_MODELS, loadModelConfig } from "../models/model.ts";
import type { CapabilityResolver } from "../plan/capabilities.ts";
import { chooseVariant, draftGeneralWorkflow, isGeneralInsight, NotFoundError } from "../workflows/drafter.ts";
import { connectorStatus, detailOf } from "../workflows/service.ts";
import { readWorkflow, updateWorkflow, WORKFLOW_ID_RE } from "../workflows/store.ts";
import { chooseTool } from "../plan/tools.ts";
import type { Env } from "../connectors/config.ts";
import { error, json } from "./http.ts";

export interface S14Context {
  home: string;
  env: Env;
  model: Model;
  modelLabel: "stub" | "real";
  now: () => number;
  analysis: () => Promise<Analysis>;
  resolver?: CapabilityResolver;
  models?: ModelConfig;
  /** s14 model router (ADR 0008): GET /models/usage. */
  router?: ModelRouter;
}

const MAX_BODY = 16 * 1024;

async function jsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "payload_too_large", `body over ${MAX_BODY} bytes`);
  if (text.trim() === "") return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(400, "bad_request", "content-type must be application/json");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return error(400, "bad_request", "body is not JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return error(400, "bad_request", "body must be a JSON object");
  return v as Record<string, unknown>;
}

function modelsOf(ctx: S14Context): ModelConfig {
  try {
    return ctx.models ?? loadModelConfig(ctx.home);
  } catch {
    // A broken models.json: the defaults (claude-opus-5-5 / claude-sonnet-5-5) are used.
    return { ...DEFAULT_MODELS };
  }
}

export async function s14Route(req: Request, path: string, ctx: S14Context): Promise<Response | null> {
  if (path === "/models/usage") {
    if (req.method !== "GET" && req.method !== "HEAD") return error(405, "method_not_allowed", "use GET");
    if (ctx.router === undefined) return error(404, "not_found", "no model router in this brain");
    return json(200, { version: 1, ...ctx.router.usage() });
  }
  if (path === "/context") {
    if (req.method === "GET" || req.method === "HEAD") return json(200, contextResponse(ctx.home));
    if (req.method !== "PUT") return error(405, "method_not_allowed", "use GET or PUT");
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    try {
      const next = parseContextBody(b, readUserContext(ctx.home).context);
      writeUserContext(ctx.home, next, ctx.now());
    } catch (err) {
      if (err instanceof ContextError) return error(400, "bad_request", err.message);
      throw err;
    }
    return json(200, contextResponse(ctx.home));
  }

  if (path === "/workflows/draft" && req.method === "POST") {
    // Read the body from a clone so the s05 route can still read it when this is an email insight.
    const b = await jsonBody(req.clone() as unknown as Request);
    if (b instanceof Response) return null;
    if (typeof b.insightId !== "string" || !/^ins_[A-Za-z0-9_-]{1,64}$/.test(b.insightId)) return null;
    const a = await ctx.analysis();
    if (!isGeneralInsight(a, b.insightId)) return null;
    const user = readUserContext(ctx.home).context;
    try {
      const { workflow, created } = await draftGeneralWorkflow({ home: ctx.home, analysis: a, insightId: b.insightId, model: ctx.model, models: modelsOf(ctx), now: ctx.now, ...(user === undefined ? {} : { user }), ...(ctx.resolver === undefined ? {} : { resolver: ctx.resolver }) });
      return json(created ? 201 : 200, detailOf(ctx.home, workflow, connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub"), ctx.now()));
    } catch (err) {
      if (err instanceof NotFoundError) return error(404, "not_found", err.message);
      throw err;
    }
  }

  const tm = /^\/workflows\/([^/]+)\/tools$/.exec(path);
  if (tm !== null) {
    if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
    const wf = WORKFLOW_ID_RE.test(tm[1]!) ? readWorkflow(ctx.home, tm[1]!) : null;
    if (wf === null) return error(404, "not_found", "unknown workflow id");
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    for (const k of Object.keys(b)) if (k !== "stepId" && k !== "toolId") return error(400, "bad_request", `${k} is not a tools field (send { "stepId", "toolId" })`);
    if (typeof b.stepId !== "string" || typeof b.toolId !== "string") return error(400, "bad_request", "stepId and toolId are required");
    const next = chooseTool(wf.tools ?? [], b.stepId, b.toolId, wf.plan === undefined);
    if (next === null) return error(400, "bad_request", "no such step or tool option in this workflow");
    const updated = updateWorkflow(ctx.home, wf.id, (w) => {
      w.tools = next;
      // A different tool is a different workflow to review: the last dry run no longer stands for it.
      w.lastDryRunHash = null;
      if (w.status === "active") w.status = "ready_for_review";
    }, ctx.now());
    return json(200, detailOf(ctx.home, updated, connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub"), ctx.now()));
  }

  const m = /^\/workflows\/([^/]+)\/plan$/.exec(path);
  if (m !== null) {
    if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
    const id = m[1]!;
    if (!WORKFLOW_ID_RE.test(id) || readWorkflow(ctx.home, id) === null) return error(404, "not_found", "unknown workflow id");
    const b = await jsonBody(req);
    if (b instanceof Response) return b;
    for (const k of Object.keys(b)) if (k !== "variant") return error(400, "bad_request", `${k} is not a plan field (send { "variant": "a" | "b" })`);
    if (b.variant !== "a" && b.variant !== "b") return error(400, "bad_request", 'variant must be "a" or "b"');
    try {
      const wf = chooseVariant(ctx.home, id, b.variant, ctx.now());
      return json(200, detailOf(ctx.home, wf, connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub"), ctx.now()));
    } catch (err) {
      if (err instanceof NotFoundError) return error(409, "conflict", err.message);
      throw err;
    }
  }
  return null;
}
