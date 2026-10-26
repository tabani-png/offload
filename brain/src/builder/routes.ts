// s24 routes (additive, brain/API.md "Builds (s24)"):
//   POST /solutions/:id/checks                          write the frozen check script -> {checks, content, buildMd}
//   POST /solutions/:id/build/approve {briefHash, checkHash}  -> {briefHash, checkHash, token} (token shown once)
//   POST /solutions/:id/build {token}                   dry-run build -> the run record (201)
//   GET  /builds/:runId                                 the run record
// Returns null for every other request.
import { error, json } from "../api/http.ts";
import { DEFAULT_MODELS, type Model, type ModelConfig } from "../models/model.ts";
import { BRIEF_ID_RE, BriefError } from "../solutions/brief.ts";
import { approveBuild } from "./approval.ts";
import { writeChecks } from "./checks.ts";
import { readRunRecord } from "./record.ts";
import { runBuild, type BuilderQuery } from "./runner.ts";
import { profileFromEnv, UnsafeProfileError } from "./sandbox.ts";
import { builderQuery } from "./service.ts";

export interface BuildContext {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  model: Model;
  modelLabel: string;
  models?: ModelConfig;
  now: () => number;
  query?: BuilderQuery;
}

const MAX_BODY = 16 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

async function body(req: Request, allowed: readonly string[]): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "payload_too_large", `body over ${MAX_BODY} bytes`);
  if (text.trim() === "" && allowed.length === 0) return {};
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

export async function buildRoute(req: Request, path: string, ctx: BuildContext): Promise<Response | null> {
  const run = /^\/builds\/([^/]+)$/.exec(path);
  if (run !== null) {
    if (req.method !== "GET") return error(405, "method_not_allowed", "use GET");
    const r = readRunRecord(ctx.home, run[1]!);
    return r === null ? error(404, "not_found", "unknown run id") : json(200, r);
  }
  const m = /^\/solutions\/([^/]+)\/(checks|build|build\/approve)$/.exec(path);
  if (m === null) return null;
  if (!BRIEF_ID_RE.test(m[1]!)) return error(404, "not_found", "unknown brief id");
  if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
  const id = m[1]!;
  try {
    if (m[2] === "checks") {
      const b = await body(req, []);
      if (b instanceof Response) return b;
      return json(201, await writeChecks({ home: ctx.home, briefId: id, model: ctx.model, models: ctx.models ?? { ...DEFAULT_MODELS }, modelLabel: ctx.modelLabel, now: ctx.now() }));
    }
    if (m[2] === "build/approve") {
      const b = await body(req, ["briefHash", "checkHash"]);
      if (b instanceof Response) return b;
      if (typeof b.briefHash !== "string" || !HEX64.test(b.briefHash) || typeof b.checkHash !== "string" || !HEX64.test(b.checkHash)) return error(400, "bad_request", "briefHash and checkHash must be sha256 hex");
      return json(200, approveBuild(ctx.home, id, b.briefHash, b.checkHash, ctx.now()));
    }
    const b = await body(req, ["token"]);
    if (b instanceof Response) return b;
    if (typeof b.token !== "string" || b.token === "") return error(400, "bad_request", "token is required");
    const rec = await runBuild({ home: ctx.home, briefId: id, token: b.token, query: ctx.query ?? (await builderQuery(ctx.env)), profile: profileFromEnv(ctx.env), env: ctx.env, now: ctx.now });
    return json(201, rec);
  } catch (err) {
    if (err instanceof UnsafeProfileError) return error(403, "forbidden", err.message);
    if (err instanceof BriefError) return error(err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : err.code === "bad_request" ? 400 : 409, err.code, err.message);
    throw err;
  }
}
