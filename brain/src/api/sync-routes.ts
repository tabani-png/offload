// Company sync routes of the local brain API (S2-02, brain/API.md "Company sync"). Same bearer token and loopback
// policy as every route (server.ts checks both before this runs). null = not a sync route.
import { SyncClient, SyncError } from "../sync/client.ts";
import { DeviceRevokedError } from "../sync/enroll.ts";
import { ControlError } from "../sync/http.ts";
import { error, json } from "./http.ts";

const MAX_BODY = 4096;

async function jsonBody(req: Request): Promise<Record<string, unknown> | string> {
  const text = await req.text();
  if (text.length > MAX_BODY) return `body over ${MAX_BODY} bytes`;
  if (text.trim() === "") return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return "content-type must be application/json";
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "body must be a JSON object";
    return v as Record<string, unknown>;
  } catch {
    return "body is not JSON";
  }
}

function failure(err: unknown): Response {
  if (err instanceof SyncError) {
    const status = err.code === "not_found" ? 404 : err.code === "bad_request" ? 400 : 409;
    return error(status, err.code === "not_found" ? "not_found" : err.code === "bad_request" ? "bad_request" : "conflict", err.message);
  }
  if (err instanceof DeviceRevokedError) return error(409, "conflict", err.message);
  if (err instanceof ControlError) return error(409, "conflict", `the control plane answered: ${err.message}`);
  throw err;
}

const METHOD = (m: string) => error(405, "method_not_allowed", `use ${m}`);

export async function syncRoute(req: Request, path: string, sync: SyncClient): Promise<Response | null> {
  const share = /^\/workflows\/([^/]+)\/share$/.exec(path);
  if (!path.startsWith("/sync/") && path !== "/sync" && share === null) return null;
  const url = new URL(req.url);
  try {
    if (share !== null) {
      if (req.method !== "POST") return METHOD("POST");
      const id = share[1]!;
      if (!sync.hasWorkflow(id)) return error(404, "not_found", "unknown workflow id");
      if (url.searchParams.get("confirm") !== "1") return json(200, { confirmed: false, proposal: sync.proposal(id) });
      const hash = url.searchParams.get("hash");
      if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) return error(400, "bad_request", "confirm needs &hash= the preview's definitionHash");
      return json(201, { confirmed: true, proposal: sync.share(id, hash) });
    }
    switch (path) {
      case "/sync/status":
        if (req.method !== "GET" && req.method !== "HEAD") return METHOD("GET");
        return json(200, sync.status());
      case "/sync/connect":
        if (req.method !== "POST") return METHOD("POST");
        return json(202, await sync.connect());
      case "/sync/pause":
      case "/sync/resume":
        if (req.method !== "POST") return METHOD("POST");
        return json(200, sync.setPaused(path === "/sync/pause"));
      case "/sync/preview":
        if (req.method !== "GET" && req.method !== "HEAD") return METHOD("GET");
        return json(200, await sync.preview());
      case "/sync/notice/ack": {
        if (req.method !== "POST") return METHOD("POST");
        const b = await jsonBody(req);
        if (typeof b === "string") return error(400, "bad_request", b);
        for (const k of Object.keys(b)) if (k !== "noticeVersionId") return error(400, "bad_request", `${k} is not a field here (send { "noticeVersionId": ... })`);
        if (typeof b.noticeVersionId !== "string" || !/^[0-9a-f-]{36}$/.test(b.noticeVersionId)) return error(400, "bad_request", "noticeVersionId must be the notice's uuid");
        return json(201, { ack: await sync.acknowledgeNotice(b.noticeVersionId) });
      }
      default:
        return error(404, "not_found");
    }
  } catch (err) {
    return failure(err);
  }
}
