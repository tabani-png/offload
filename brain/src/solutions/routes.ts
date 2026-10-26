// s22 routes (additive, brain/API.md "Solutions (s22)"):
//   GET  /insights/:id/solutions                 SolutionSet: rules + the design pass with the serve model
//   POST /insights/:id/solutions/choose {kind}   workflow -> the drafter's WorkflowDetailDTO; else the draft brief
//   GET  /solutions/:id                          the brief
//   POST /solutions/:id/approve {briefHash}      approve the exact brief -> {brief, token} (token shown once)
//   POST /solutions/:id/handoff {token}          consume the token once -> {brief, builderPrompt, briefMd}
// `:id` of an insight is its `ins_…` id (insights and held-back tasks). Returns null for every other request.
import type { Analysis } from "../analyze.ts";
import { error, json } from "../api/http.ts";
import type { Env } from "../connectors/config.ts";
import { readUserContext } from "../context/store.ts";
import { DEFAULT_MODELS, loadModelConfig, type Model, type ModelConfig } from "../models/model.ts";
import { NotFoundError } from "../workflows/drafter.ts";
import { connectorStatus, detailOf } from "../workflows/service.ts";
import { approveBrief, BRIEF_ID_RE, BriefError, handOffBrief, readBrief } from "./brief.ts";
import { ChooseError, chooseSolution, designSolutions, parseKind } from "./service.ts";

export interface SolutionsContext {
  home: string;
  env: Env;
  model: Model;
  modelLabel: "stub" | "real";
  now: () => number;
  analysis: () => Promise<Analysis>;
  models?: ModelConfig;
}

const MAX_BODY = 16 * 1024;

async function body(req: Request, allowed: readonly string[]): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "payload_too_large", `body over ${MAX_BODY} bytes`);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(400, "bad_request", "content-type must be application/json");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return error(400, "bad_request", "body is not JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return error(400, "bad_request", "body must be a JSON object");
  for (const k of Object.keys(v)) if (!allowed.includes(k)) return error(400, "bad_request", `${k} is not allowed (send ${allowed.join(", ")})`);
  return v as Record<string, unknown>;
}

function modelsOf(ctx: SolutionsContext): ModelConfig {
  try {
    return ctx.models ?? loadModelConfig(ctx.home);
  } catch {
    // A broken models.json: the defaults are used.
    return { ...DEFAULT_MODELS };
  }
}

function briefError(err: unknown): Response {
  if (err instanceof BriefError) return error(err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : err.code === "bad_request" ? 400 : 409, err.code, err.message);
  if (err instanceof NotFoundError) return error(404, "not_found", err.message);
  if (err instanceof ChooseError) return error(409, "conflict", err.message);
  throw err;
}

export async function solutionsRoute(req: Request, path: string, ctx: SolutionsContext): Promise<Response | null> {
  const ins = /^\/insights\/(ins_[A-Za-z0-9_-]{1,64})\/solutions(\/choose)?$/.exec(path);
  if (ins !== null) {
    const choose = ins[2] !== undefined;
    if (choose ? req.method !== "POST" : req.method !== "GET") return error(405, "method_not_allowed", choose ? "use POST" : "use GET");
    let kind = null;
    if (choose) {
      const b = await body(req, ["kind"]);
      if (b instanceof Response) return b;
      kind = parseKind(b.kind);
      if (kind === null) return error(400, "bad_request", "kind must be workflow, tool, setup, remove_step or leave_alone");
    }
    const user = readUserContext(ctx.home).context;
    try {
      const a = await ctx.analysis();
      const { set } = await designSolutions({ analysis: a, ref: ins[1]!, model: ctx.model, models: modelsOf(ctx), ...(user === undefined ? {} : { user }) });
      if (kind === null) return json(200, set);
      const r = await chooseSolution({ home: ctx.home, analysis: a, set, kind, model: ctx.model, models: modelsOf(ctx), now: ctx.now, ...(user === undefined ? {} : { user }) });
      if (r.kind === "workflow") return json(r.created ? 201 : 200, { kind: "workflow", workflow: detailOf(ctx.home, r.workflow, connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub"), ctx.now()) });
      return json(r.created ? 201 : 200, { kind: r.kind, brief: r.brief });
    } catch (err) {
      return briefError(err);
    }
  }
  const sm = /^\/solutions\/([^/]+)(?:\/(approve|handoff))?$/.exec(path);
  if (sm === null) return null;
  const id = sm[1]!;
  if (!BRIEF_ID_RE.test(id)) return error(404, "not_found", "unknown brief id");
  const action = sm[2];
  try {
    if (action === undefined) {
      if (req.method !== "GET") return error(405, "method_not_allowed", "use GET");
      const b = readBrief(ctx.home, id);
      return b === null ? error(404, "not_found", "unknown brief id") : json(200, b);
    }
    if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
    if (action === "approve") {
      const b = await body(req, ["briefHash"]);
      if (b instanceof Response) return b;
      if (typeof b.briefHash !== "string" || !/^[0-9a-f]{64}$/.test(b.briefHash)) return error(400, "bad_request", "briefHash must be the brief's sha256");
      return json(200, approveBrief(ctx.home, id, b.briefHash, ctx.now()));
    }
    const b = await body(req, ["token"]);
    if (b instanceof Response) return b;
    if (typeof b.token !== "string" || b.token === "") return error(400, "bad_request", "token is required");
    return json(200, handOffBrief(ctx.home, id, b.token, ctx.now()));
  } catch (err) {
    return briefError(err);
  }
}
