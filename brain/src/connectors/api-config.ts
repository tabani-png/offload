// s13: the `apis` section of $OFFLOAD_HOME/connectors.json: direct HTTP access to a service, the third method of the
// connector chain. Like the rest of the file it never holds a secret: `auth` names an env var (fromEnv) or a macOS
// Keychain item (keychain: { service, account }). Every write operation declares its full argument schema (the gate's
// FieldSpec kinds) and where each argument comes from (`map`), so the gate can compare the canonical hash of the
// request with the approved item exactly like the MCP send tool. Pure module: no runtime imports beyond types.
import type { FieldSpec } from "../workflows/allowlist.ts";

export type SecretRef = { fromEnv: string } | { keychain: { service: string; account: string } };

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const KC_RE = /^[A-Za-z0-9 ._@:+-]{1,128}$/;

/** Why a reference is malformed, or null. `raw` is the object that carries fromEnv / keychain. */
export function secretRefError(where: string, raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${where} must name an env var (fromEnv) or a Keychain item (keychain)`;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).filter((k) => k === "fromEnv" || k === "keychain");
  if (keys.length !== 1) return `${where} needs exactly one of fromEnv or keychain`;
  if (keys[0] === "fromEnv") return typeof r.fromEnv === "string" && ENV_NAME_RE.test(r.fromEnv) ? null : `${where}.fromEnv must be an env var name (UPPER_SNAKE)`;
  const kc = r.keychain as Record<string, unknown> | null;
  if (typeof kc !== "object" || kc === null || Array.isArray(kc)) return `${where}.keychain must be { service, account }`;
  for (const k of Object.keys(kc)) if (k !== "service" && k !== "account") return `${where}.keychain: unknown key ${k}`;
  if (typeof kc.service !== "string" || !KC_RE.test(kc.service) || typeof kc.account !== "string" || !KC_RE.test(kc.account)) return `${where}.keychain needs a service and an account (letters, digits, space . _ @ : + -)`;
  return null;
}

const refOf = (r: Record<string, unknown>): SecretRef =>
  typeof r.fromEnv === "string" ? { fromEnv: r.fromEnv } : { keychain: { service: String((r.keychain as Record<string, unknown>).service), account: String((r.keychain as Record<string, unknown>).account) } };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiRole = "read" | "send" | "log";
export type ApiBody = "json" | "gmail-raw" | "none";

export interface ApiAuth {
  type: "bearer" | "header";
  /** For type header: the header name, e.g. x-api-key. */
  header: string | null;
  secret: SecretRef;
}

export interface ApiOperation {
  /** Canonical capability name, e.g. mail.send. */
  capability: string;
  operationId: string;
  method: HttpMethod;
  /** Starts with /; `{arg}` is replaced by that argument (URL-encoded). */
  path: string;
  role: ApiRole;
  /** Every argument the operation takes and how the gate canonicalises it. Writes may not use `any`. */
  fields: Record<string, FieldSpec>;
  body: ApiBody;
  /** Argument -> source: "$item.to" | "$item.subject" | "$item.body" | "$item.commit.<label>" | "$crm.row" |
   * "$crm.spreadsheetId" | "$crm.range", or a literal string / boolean. Reads need none. */
  map: Record<string, string | boolean>;
}

export interface ApiEntry {
  baseUrl: string;
  auth: ApiAuth | null;
  health: { method: "GET"; path: string } | null;
  operations: ApiOperation[];
  /** A local OpenAPI 3 JSON file; its GET operations add read capabilities `api.<operationId>`. */
  openapi: string | null;
}

export type ApisConfig = Record<string, ApiEntry>;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const TARGET_RE = /^(?:[a-z][a-z0-9-]{0,30}|(?:app|web)-[a-z0-9-]{1,40})$/;
const OP_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CAP_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const ARG_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SOURCE_RE = /^\$(?:item\.(?:to|subject|body|commit\.[a-z0-9 _-]{1,40})|crm\.(?:row|spreadsheetId|range))$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const SECRETISH = [/\bsk-[A-Za-z0-9_-]{12,}/, /\bBearer\s+\S+/i, /[A-Za-z0-9_]{32,}/, /[?&](?:api[_-]?key|token|secret|key|access_token)=/i];
const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const KINDS = ["addresses", "text", "id", "rows", "empty", "any"] as const;

function fieldSpec(where: string, raw: unknown, write: boolean, errors: string[]): FieldSpec | null {
  if (typeof raw === "string" && (KINDS as readonly string[]).includes(raw)) {
    if (raw === "any" && write) {
      errors.push(`${where}: a write argument must have a schema (addresses, text, id, rows, empty or fixed), not any`);
      return null;
    }
    return { kind: raw } as FieldSpec;
  }
  if (isObj(raw) && Array.isArray(raw.fixed) && raw.fixed.length > 0 && raw.fixed.every((v) => typeof v === "string" || typeof v === "boolean") && Object.keys(raw).length === 1) {
    return { kind: "fixed", values: raw.fixed as Array<string | boolean> };
  }
  errors.push(`${where} must be one of ${KINDS.join(", ")} or { fixed: [...] }`);
  return null;
}

function parseOperation(where: string, capability: string, raw: unknown, errors: string[]): ApiOperation | null {
  if (!CAP_RE.test(capability)) errors.push(`${where}: capability names look like mail.send`);
  if (!isObj(raw)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  for (const k of Object.keys(raw)) if (!["operationId", "method", "path", "role", "fields", "body", "map"].includes(k)) errors.push(`${where}: unknown key ${k}`);
  const operationId = typeof raw.operationId === "string" && OP_RE.test(raw.operationId) ? raw.operationId : null;
  if (operationId === null) errors.push(`${where}.operationId must be letters, digits, . _ -`);
  const method = typeof raw.method === "string" && (METHODS as readonly string[]).includes(raw.method) ? (raw.method as HttpMethod) : null;
  if (method === null) errors.push(`${where}.method must be one of ${METHODS.join(", ")}`);
  const path = typeof raw.path === "string" && raw.path.startsWith("/") && !/\s/.test(raw.path) ? raw.path : null;
  if (path === null) errors.push(`${where}.path must start with /`);
  else if (SECRETISH.some((re) => re.test(path))) errors.push(`${where}.path looks like it holds a secret`);
  const role = raw.role === "read" || raw.role === "send" || raw.role === "log" ? raw.role : null;
  if (role === null) errors.push(`${where}.role must be read, send or log`);
  if (role === "read" && method !== null && method !== "GET") errors.push(`${where}: a read must be a GET`);
  const write = role !== "read";
  const fields: Record<string, FieldSpec> = {};
  if (!isObj(raw.fields)) errors.push(`${where}.fields must list every argument`);
  else
    for (const [k, v] of Object.entries(raw.fields)) {
      if (!ARG_RE.test(k)) errors.push(`${where}.fields: bad argument name ${JSON.stringify(k)}`);
      const f = fieldSpec(`${where}.fields.${k}`, v, write, errors);
      if (f !== null) fields[k] = f;
    }
  const body: ApiBody = raw.body === undefined ? (method === "GET" ? "none" : "json") : raw.body === "json" || raw.body === "gmail-raw" || raw.body === "none" ? raw.body : "json";
  if (raw.body !== undefined && body !== raw.body) errors.push(`${where}.body must be json, gmail-raw or none`);
  const map: Record<string, string | boolean> = {};
  if (raw.map !== undefined && !isObj(raw.map)) errors.push(`${where}.map must be an object`);
  for (const [k, v] of Object.entries(isObj(raw.map) ? raw.map : {})) {
    if (!(k in fields)) errors.push(`${where}.map.${k} is not one of its fields`);
    if (typeof v === "boolean") map[k] = v;
    else if (typeof v === "string" && (v.startsWith("$") ? SOURCE_RE.test(v) : !SECRETISH.some((re) => re.test(v)))) map[k] = v;
    else errors.push(`${where}.map.${k} must be a literal or one of $item.to, $item.subject, $item.body, $item.commit.<label>, $crm.row, $crm.spreadsheetId, $crm.range`);
  }
  if (write)
    for (const [k, f] of Object.entries(fields)) {
      const required = f.kind === "addresses" || f.kind === "text" || f.kind === "id" || f.kind === "rows";
      if (required && !(k in map)) errors.push(`${where}.map must say where ${k} comes from`);
    }
  if (body === "gmail-raw" && write && !(fields.to?.kind === "addresses" && fields.subject?.kind === "text" && fields.body?.kind === "text"))
    errors.push(`${where}: gmail-raw needs fields to (addresses), subject (text) and body (text)`);
  if (operationId === null || method === null || path === null || role === null) return null;
  return { capability, operationId, method, path, role, fields, body, map };
}

function parseEntry(id: string, raw: unknown, errors: string[]): ApiEntry | null {
  const at = `apis.${id}`;
  if (!TARGET_RE.test(id)) errors.push(`${at}: the key must be a catalog id or an app target id (app-…, web-…)`);
  if (!isObj(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  for (const k of Object.keys(raw)) if (!["baseUrl", "auth", "health", "operations", "openapi"].includes(k)) errors.push(`${at}: unknown key ${k}`);
  let baseUrl = "";
  if (typeof raw.baseUrl !== "string") errors.push(`${at}.baseUrl is required`);
  else {
    baseUrl = raw.baseUrl.replace(/\/+$/, "");
    if (SECRETISH.some((re) => re.test(baseUrl))) errors.push(`${at}.baseUrl looks like it holds a secret: name an env var or a Keychain item in auth instead`);
    try {
      const u = new URL(baseUrl);
      const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
      if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) errors.push(`${at}.baseUrl must be https (plain http only on 127.0.0.1)`);
      if (u.username !== "" || u.password !== "") errors.push(`${at}.baseUrl must not carry a user or password`);
    } catch {
      errors.push(`${at}.baseUrl is not a URL`);
    }
  }
  let auth: ApiAuth | null = null;
  if (raw.auth !== undefined) {
    const a = raw.auth;
    if (!isObj(a)) errors.push(`${at}.auth must be an object`);
    else {
      for (const k of Object.keys(a)) if (!["type", "header", "fromEnv", "keychain"].includes(k)) errors.push(`${at}.auth: unknown key ${k} (raw secrets are not allowed; name an env var or a Keychain item)`);
      const type = a.type === "bearer" || a.type === "header" ? a.type : null;
      if (type === null) errors.push(`${at}.auth.type must be bearer or header`);
      const header = type === "header" ? (typeof a.header === "string" && HEADER_RE.test(a.header) ? a.header : null) : null;
      if (type === "header" && header === null) errors.push(`${at}.auth.header must be a header name`);
      const err = secretRefError(`${at}.auth`, a);
      if (err !== null) errors.push(err);
      if (type !== null && err === null && (type === "bearer" || header !== null)) auth = { type, header, secret: refOf(a) };
    }
  }
  let health: ApiEntry["health"] = null;
  if (raw.health !== undefined) {
    const h = raw.health;
    if (!isObj(h) || (h.method !== undefined && h.method !== "GET") || typeof h.path !== "string" || !h.path.startsWith("/")) errors.push(`${at}.health must be { method: "GET", path: "/..." }`);
    else health = { method: "GET", path: h.path };
  }
  const operations: ApiOperation[] = [];
  if (raw.operations !== undefined && !isObj(raw.operations)) errors.push(`${at}.operations must be an object of capability -> operation`);
  for (const [cap, op] of Object.entries(isObj(raw.operations) ? raw.operations : {})) {
    const parsed = parseOperation(`${at}.operations.${cap}`, cap, op, errors);
    if (parsed !== null) operations.push(parsed);
  }
  const ids = operations.map((o) => o.operationId);
  if (new Set(ids).size !== ids.length) errors.push(`${at}.operations: every operationId must be different`);
  let openapi: string | null = null;
  if (raw.openapi !== undefined) {
    if (typeof raw.openapi !== "string" || !raw.openapi.startsWith("/") || !raw.openapi.endsWith(".json")) errors.push(`${at}.openapi must be an absolute path to a local .json file`);
    else openapi = raw.openapi;
  }
  return { baseUrl, auth, health, operations, openapi };
}

/** Parses connectors.json `apis`; appends problems to `errors`. */
export function parseApis(raw: unknown, errors: string[]): ApisConfig {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    errors.push("apis must be an object of target id -> api");
    return {};
  }
  const out: ApisConfig = {};
  for (const [id, entry] of Object.entries(raw)) {
    const e = parseEntry(id, entry, errors);
    if (e !== null) out[id] = e;
  }
  return out;
}
