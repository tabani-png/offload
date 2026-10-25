// Network policy for the brain's local API. Adapted (copied, not imported) from the Workpaper server shell
// (~/builds/workpaper/app/server/http.ts): Host and Origin must be this machine's loopback name, no CORS, no caching,
// no cross-origin reads (CORP), nosniff. The listener binds 127.0.0.1 only. Added here: bearer token check.
import { createHash, timingSafeEqual } from "node:crypto";
import type { ErrorCode, ErrorResponse } from "./types.ts";

export const LOOPBACK = "127.0.0.1";
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$/i;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function error(status: number, code: ErrorCode, message?: string): Response {
  const body: ErrorResponse = message === undefined ? { error: code } : { error: code, message };
  return json(status, body);
}

/** Foreign Host or Origin -> 403, OPTIONS (CORS preflight) -> 405. null = go on. */
export function gate(req: Request): Response | null {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOCAL_HOST_RE.test(host)) return error(403, "forbidden");
  const origin = req.headers.get("origin");
  if (origin !== null && origin.toLowerCase() !== `http://${host.toLowerCase()}`) return error(403, "forbidden");
  if (req.method === "OPTIONS") return error(405, "method_not_allowed");
  return null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time bearer check. Both sides are hashed first so lengths always match. */
export function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/.exec(header);
  if (m?.[1] === undefined) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

/** Header policy for every response: no-store, no Access-Control-*, no cookies, nosniff, same-origin CORP. */
export function secure(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n.startsWith("access-control-") || n === "set-cookie") return;
    headers.append(name, value);
  });
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
