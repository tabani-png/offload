import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Validator } from "./registry.ts";
import { b64url, fromB64url } from "./encoding.ts";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "consent_missing"
  | "feature_disabled"
  | "group_floor"
  | "forbidden_binding"
  | "recipient_not_allowed"
  | "hash_mismatch"
  | "token_used"
  | "kill_switch_active"
  | "budget_exceeded"
  | "rate_limited"
  | "replay"
  | "bad_signature"
  | "server_error";

/** Thrown by handlers; rendered as error.schema.json by the app's error handler. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const unauthorized = (m = "sign in required") => new HttpError(401, "unauthorized", m);
export const forbidden = (m = "not allowed") => new HttpError(403, "forbidden", m);
export const notFound = (m = "not found") => new HttpError(404, "not_found", m);
export const conflict = (m: string) => new HttpError(409, "conflict", m);
export const invalid = (m: string, errors?: string[]) =>
  new HttpError(400, "validation_failed", m, errors ? { errors } : undefined);

export const ERROR_SCHEMA = "offload/stage2/error.schema.json";

export function errorBody(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return { error: { code, message: message.slice(0, 2000), ...(details ? { details } : {}) } };
}

/** Reads and validates a JSON body. Malformed JSON and unknown fields are 400 validation_failed. */
export async function readBody<T>(c: Context, validator: Validator, ref: string): Promise<T> {
  let data: unknown;
  try {
    const text = await c.req.text();
    data = text === "" ? {} : JSON.parse(text);
  } catch {
    throw invalid("body is not valid JSON");
  }
  const r = validator.validate(ref, data);
  if (!r.ok) throw invalid("request body does not match its schema", r.errors);
  return data as T;
}

/** Sends JSON, validating it against `ref` when response validation is on (always in tests). */
export function send(
  c: Context,
  validator: Validator,
  validateResponses: boolean,
  status: ContentfulStatusCode,
  body: unknown,
  ref: string,
): Response {
  if (validateResponses) {
    const r = validator.validate(ref, body);
    if (!r.ok) throw new Error(`response for ${c.req.method} ${c.req.path} does not match ${ref}: ${r.errors.join("; ")}`);
  }
  return c.json(body as object, status);
}

export interface PageParams {
  limit: number;
  cursor: Record<string, unknown> | null;
}

/** `?cursor=&limit=` (limit 1..200, default 50). Cursors are opaque base64url JSON. */
export function pageParams(c: Context): PageParams {
  const l = c.req.query("limit");
  const limit = l === undefined ? 50 : Number(l);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("limit must be an integer 1..200");
  const raw = c.req.query("cursor");
  if (!raw) return { limit, cursor: null };
  try {
    const cursor = JSON.parse(new TextDecoder().decode(fromB64url(raw))) as unknown;
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) throw new Error("bad");
    return { limit, cursor: cursor as Record<string, unknown> };
  } catch {
    throw invalid("bad cursor");
  }
}

export function encodeCursor(v: Record<string, unknown>): string {
  return b64url(new TextEncoder().encode(JSON.stringify(v)));
}

/** Slices `limit + 1` fetched rows into a page and the next cursor. */
export function page<T>(rows: T[], limit: number, cursorOf: (last: T) => Record<string, unknown>) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, page: { nextCursor: more && last !== undefined ? encodeCursor(cursorOf(last)) : null } };
}
