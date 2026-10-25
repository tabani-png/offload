// s17: the Connections center's state and checks. One record per connection the person set up, in
// $OFFLOAD_HOME/connections.json (0600, version 1). The file NEVER holds a secret: an API key lives in the macOS
// Keychain (the app writes it there with the Security framework) and the record names the item; a connector server's
// headers and env values are references too. Every value the person sends is scanned with the connectors.json secret
// patterns; a body that carries a value where a reference belongs is refused without echoing it.
// A connection id is the catalog id when Offload maps the app (gmail, slack, ...), else `tk-<toolkit>`.
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../workflows/store.ts";
import { secretRefError, type SecretRef } from "./api-config.ts";
import { CONNECTORS, connectorById, type Connector } from "./catalog.ts";
import { parseConnections, pickAccount, readOnlyRunner } from "./composio.ts";
import { looksLikeSecret, type Env } from "./config.ts";
import { composioToolkit, linkEnv, type LinkRunner } from "./link.ts";
import type { McpLister } from "./mcp-probe.ts";
import type { SecretReader } from "./secrets.ts";
import { isUniverseId, toolkitOfUniverseId, universeTargetId } from "./targets.ts";
import type { UniverseIndex } from "./universe.ts";

export const CONNECTIONS_FILE = "connections.json";
export const connectionsPath = (home: string) => join(home, CONNECTIONS_FILE);
export const KEYCHAIN_SERVICE_PREFIX = "offload.connection.";
/** Where the app stores a connection's API key (generic password item). The brain only ever gets this name. */
export const keychainRefFor = (id: string) => ({ service: `${KEYCHAIN_SERVICE_PREFIX}${id}`, account: "api-key" });

export type SetupMethod = "composio" | "api_key" | "mcp";
export const SETUP_METHODS: readonly SetupMethod[] = ["composio", "api_key", "mcp"];

export interface ApiSetup {
  secret: SecretRef;
  baseUrl: string | null;
  healthPath: string | null;
  /** The header the key goes in (raw value). null = Authorization: Bearer <key>. */
  header: string | null;
}

export type ServerSetup = { type: "http"; url: string; headers: Record<string, SecretRef> } | { type: "stdio"; command: string; args: string[]; env: Record<string, SecretRef> };

export interface TestResult {
  at: number;
  ok: boolean;
  detail: string;
  tools: number | null;
}

export interface ConnectionRecord {
  id: string;
  method: SetupMethod;
  toolkit: string | null;
  startedAt: number;
  api?: ApiSetup;
  server?: ServerSetup;
  test: TestResult | null;
}

// ---------- ids ----------

/** The connection id for a Composio toolkit: the catalog id when Offload maps it, else tk-<toolkit>. */
export function connectionIdFor(toolkit: string): string {
  const c = CONNECTORS.find((x) => composioToolkit(x) === toolkit);
  return c?.id ?? universeTargetId(toolkit);
}

/** The Composio toolkit behind a connection id, or null. */
export function toolkitOfConnection(id: string): string | null {
  const c = connectorById(id);
  if (c !== undefined) return composioToolkit(c);
  return toolkitOfUniverseId(id);
}

export interface ConnectionInfo {
  id: string;
  name: string;
  toolkit: string | null;
  description: string;
  catalog: Connector | null;
}

/** A connection id the center knows: a catalog id, or a tk-<toolkit> in the index (never Composio's helper toolkit). */
export function connectionInfo(id: string, idx: UniverseIndex | null): ConnectionInfo | null {
  const c = connectorById(id);
  if (c !== undefined) {
    const tk = composioToolkit(c);
    return { id, name: c.name, toolkit: tk, description: idx?.toolkits[tk]?.description ?? "", catalog: c };
  }
  const tk = toolkitOfUniverseId(id);
  if (tk === null || tk === "composio") return null;
  const t = idx?.toolkits[tk];
  if (t === undefined) return null;
  // A toolkit the catalog maps is reached through its catalog id.
  if (connectionIdFor(tk) !== id) return null;
  return { id, name: t.name, toolkit: tk, description: t.description, catalog: null };
}

// ---------- store ----------

export function readConnections(home: string): Record<string, ConnectionRecord> {
  const p = connectionsPath(home);
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as { version?: unknown; connections?: unknown };
    if (v.version !== 1 || typeof v.connections !== "object" || v.connections === null) return {};
    const out: Record<string, ConnectionRecord> = {};
    for (const [id, r] of Object.entries(v.connections as Record<string, ConnectionRecord>)) if ((connectorById(id) !== undefined || isUniverseId(id)) && SETUP_METHODS.includes(r.method)) out[id] = r;
    return out;
  } catch {
    return {};
  }
}

export function writeConnection(home: string, rec: ConnectionRecord): void {
  const all = { ...readConnections(home), [rec.id]: rec };
  writePrivate(connectionsPath(home), JSON.stringify({ version: 1, connections: all }, null, 2) + "\n");
}

// ---------- the setup body ----------

export class SetupError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
/** Field names that would carry a secret value: the brain never takes one. */
const SECRET_FIELD = /^(keys?|secrets?|tokens?|passwords?|passphrase|values?|api[_-]?keys?|apikey|access[_-]?tokens?|credentials?|bearer)$/i;
const EXTRA_SECRET = [/--?(?:api[_-]?key|token|secret|password|access[_-]?token)=/i, /\b(?:lin|sk|pk|rk|xoxb|xoxp|ghp|glpat|shpat|ntn|secret)_[A-Za-z0-9_]{12,}/];
const secretish = (v: string) => looksLikeSecret(v) || EXTRA_SECRET.some((re) => re.test(v));
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._@:+-]{1,64}$/;
const PATH_RE = /^\/[A-Za-z0-9/_.~-]{0,200}$/;

function httpsUrl(where: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) throw new SetupError(`${where} must be an address`);
  if (secretish(raw)) throw new SetupError(`${where} looks like it holds a secret: put the secret in the Keychain and name it instead`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SetupError(`${where} is not an address`);
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new SetupError(`${where} must start with https:// (plain http only on this Mac)`);
  if (u.username !== "" || u.password !== "") throw new SetupError(`${where} must not carry a user name or password`);
  return raw;
}

/** A reference to this connection's own secret: a Keychain item `offload.connection.<id>` or an env var name. */
function ref(where: string, raw: unknown, id: string, account?: string): SecretRef {
  if (!isObj(raw)) throw new SetupError(`${where} must name a Keychain item or a setting, never the value itself`);
  const err = secretRefError(where, raw);
  if (err !== null) throw new SetupError(err);
  if ("fromEnv" in raw) {
    if (typeof raw.fromEnv !== "string" || !ENV_NAME_RE.test(raw.fromEnv)) throw new SetupError(`${where}.fromEnv must be a setting name`);
    return { fromEnv: raw.fromEnv };
  }
  const kc = raw.keychain as { service: string; account: string };
  const own = keychainRefFor(id);
  if (kc.service !== own.service) throw new SetupError(`${where} must be this connection's own Keychain item (${own.service})`);
  if (account !== undefined ? kc.account !== account : !ACCOUNT_RE.test(kc.account)) throw new SetupError(`${where} names another Keychain item`);
  return { keychain: { service: kc.service, account: kc.account } };
}

function refMap(where: string, raw: unknown, id: string, keyRe: RegExp): Record<string, SecretRef> {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new SetupError(`${where} must be a map of names to references`);
  const out: Record<string, SecretRef> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!keyRe.test(k)) throw new SetupError(`${where} has a name that is not allowed`);
    out[k] = ref(`${where}.${k}`, v, id);
  }
  if (Object.keys(out).length > 20) throw new SetupError(`${where} has too many entries`);
  return out;
}

/** Every string anywhere in the body, for the secret scan. */
function strings(x: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out, depth + 1);
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) {
    out.push(k);
    strings(v, out, depth + 1);
  }
  return out;
}

/** Validates a setup body into a record (no test yet). Throws SetupError with words that never contain a value. */
export function parseSetup(id: string, toolkit: string | null, body: Obj, now: number): ConnectionRecord {
  // `secret` is the reference field (checked by shape below); every other secret-sounding field is refused.
  for (const k of Object.keys(body)) if (k !== "secret" && SECRET_FIELD.test(k)) throw new SetupError(`${k} is not taken here: the app saves the secret in your Keychain and sends only its name`);
  const method = body.method;
  if (typeof method !== "string" || !(SETUP_METHODS as readonly string[]).includes(method)) throw new SetupError(`method must be one of ${SETUP_METHODS.join(", ")}`);
  // The reference objects are checked by shape; every other string must not look like a secret.
  const scan = { ...body };
  delete scan.secret;
  delete scan.headers;
  delete scan.env;
  if (strings(scan).some(secretish)) throw new SetupError("a value looks like a secret: put the secret in the Keychain and name it instead");
  for (const m of [body.headers, body.env]) if (isObj(m) && Object.values(m).some((v) => typeof v === "string")) throw new SetupError("a header or setting must name a Keychain item, never hold the value");
  const allow = (keys: string[]) => {
    for (const k of Object.keys(body)) if (!keys.includes(k)) throw new SetupError(`${k} is not a ${method} setup field`);
  };
  const base = { id, method: method as SetupMethod, toolkit, startedAt: now, test: null };
  if (method === "composio") {
    allow(["method", "restart"]);
    return base;
  }
  if (method === "api_key") {
    allow(["method", "secret", "baseUrl", "healthPath", "header"]);
    const secret = ref("secret", body.secret, id, keychainRefFor(id).account);
    const baseUrl = body.baseUrl === undefined || body.baseUrl === null || body.baseUrl === "" ? null : httpsUrl("baseUrl", body.baseUrl);
    let healthPath: string | null = null;
    if (body.healthPath !== undefined && body.healthPath !== null && body.healthPath !== "") {
      if (typeof body.healthPath !== "string" || !PATH_RE.test(body.healthPath)) throw new SetupError("healthPath must be a path like /me (no query)");
      if (baseUrl === null) throw new SetupError("healthPath needs a baseUrl");
      healthPath = body.healthPath;
    }
    let header: string | null = null;
    if (body.header !== undefined && body.header !== null && body.header !== "") {
      if (typeof body.header !== "string" || !HEADER_RE.test(body.header)) throw new SetupError("header must be a header name");
      header = body.header;
    }
    return { ...base, api: { secret, baseUrl, healthPath, header } };
  }
  // mcp: a connector server, by https address or by a command on this Mac.
  if (body.url !== undefined) {
    allow(["method", "url", "headers"]);
    return { ...base, server: { type: "http", url: httpsUrl("url", body.url), headers: refMap("headers", body.headers, id, HEADER_RE) } };
  }
  allow(["method", "command", "args", "env"]);
  if (typeof body.command !== "string" || body.command.trim() === "" || body.command.length > 200 || /[\n\r]/.test(body.command)) throw new SetupError("command must be one program name or path");
  const args = body.args === undefined ? [] : body.args;
  if (!Array.isArray(args) || args.length > 40 || !args.every((a) => typeof a === "string" && a.length <= 500)) throw new SetupError("args must be a list of words");
  return { ...base, server: { type: "stdio", command: body.command, args: args as string[], env: refMap("env", body.env, id, ENV_NAME_RE) } };
}

/** Plain words for where the secret lives (the name, never the value). */
export const secretWhere = (r: SecretRef) => ("fromEnv" in r ? `Setting: ${r.fromEnv}` : `Keychain: ${r.keychain.service}`);

// ---------- tests (read-only) ----------

export interface TestDeps {
  runner: LinkRunner;
  env: Env;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  secrets: SecretReader;
  mcp: McpLister;
  simulated: boolean;
  now: () => number;
  timeoutMs: number;
}

const CHECK_TIMEOUT_MS = 10_000;

async function readAll(refs: Record<string, SecretRef>, secrets: SecretReader): Promise<Record<string, string> | null> {
  const out: Record<string, string> = {};
  try {
    for (const [k, r] of Object.entries(refs)) out[k] = await secrets.read(r);
  } catch {
    return null;
  }
  return out;
}

/** The connector server with its secrets resolved in memory (for one tools/list), or null when one is missing. */
export async function resolveServer(s: ServerSetup, secrets: SecretReader, env: Env): Promise<McpServerConfig | null> {
  if (s.type === "http") {
    const headers = await readAll(s.headers, secrets);
    if (headers === null) return null;
    return Object.keys(headers).length === 0 ? { type: "http", url: s.url } : { type: "http", url: s.url, headers };
  }
  const vals = await readAll(s.env, secrets);
  if (vals === null) return null;
  const childEnv: Record<string, string> = {};
  for (const k of ["PATH", "HOME"]) if (env[k] !== undefined) childEnv[k] = env[k]!;
  return { type: "stdio", command: s.command, args: [...s.args], env: { ...childEnv, ...vals } };
}

/** One read-only check of a connection: Composio account status, the key's presence or one GET, or tools/list. */
export async function testConnection(rec: ConnectionRecord, name: string, d: TestDeps): Promise<TestResult> {
  const at = d.now();
  const done = (ok: boolean, detail: string, tools: number | null = null): TestResult => ({ at, ok, detail, tools });
  if (d.simulated) return done(true, `Demo test for ${name}: nothing was read or started.`);
  if (rec.method === "composio") {
    if (rec.toolkit === null) return done(false, `${name} has no Composio app.`);
    const r = await readOnlyRunner(d.runner).run(["composio", "connections", "list", "--toolkit", rec.toolkit], { timeoutMs: d.timeoutMs, env: linkEnv(d.env) });
    if (r.spawnError !== undefined) return done(false, "Composio is not installed on this Mac.");
    if (r.timedOut || r.code !== 0) return done(false, "Composio did not answer. Try again in a moment.");
    const account = pickAccount(parseConnections(r.stdout, rec.toolkit));
    if (account === null) return done(false, `${name} is not signed in to Composio yet. Sign in, then test again.`);
    return done(true, account.askEveryCall ? `${name} is signed in. Composio asks before every action on it, so Offload only reads through it.` : `${name} is signed in to Composio.`);
  }
  if (rec.method === "api_key" && rec.api !== undefined) {
    const a = rec.api;
    if (a.baseUrl !== null && a.healthPath !== null) {
      let value: string;
      try {
        value = await d.secrets.read(a.secret);
      } catch {
        return done(false, `The key for ${name} is not saved yet. Paste it again.`);
      }
      try {
        const res = await d.fetch(`${a.baseUrl.replace(/\/$/, "")}${a.healthPath}`, { method: "GET", headers: a.header === null ? { Authorization: `Bearer ${value}` } : { [a.header]: value }, redirect: "manual", signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        // The body is never read: it may echo the key.
        if (res.status >= 200 && res.status < 300) return done(true, `${name} answered. The key works.`);
        if (res.status === 401 || res.status === 403) return done(false, `${name} refused the sign-in. Check the API key in ${name}'s settings and save it again.`);
        return done(false, `${name} did not answer as expected (status ${res.status}).`);
      } catch {
        return done(false, `${name} did not answer.`);
      }
    }
    if ("fromEnv" in a.secret) return done(d.env[a.secret.fromEnv] !== undefined && d.env[a.secret.fromEnv] !== "", d.env[a.secret.fromEnv] ? "The key's setting is there." : "The key's setting is not there yet.");
    // Presence only: without -w `security` prints the item's attributes, never the password.
    const r = await d.runner.run(["security", "find-generic-password", "-s", a.secret.keychain.service, "-a", a.secret.keychain.account], { timeoutMs: d.timeoutMs, env: linkEnv(d.env) });
    return r.code === 0 ? done(true, `The key for ${name} is saved in your Keychain.`) : done(false, `The key for ${name} is not in your Keychain yet. Paste it again.`);
  }
  if (rec.method === "mcp" && rec.server !== undefined) {
    const server = await resolveServer(rec.server, d.secrets, d.env);
    if (server === null) return done(false, `A sign-in for ${name}'s connector server is not saved yet.`);
    try {
      const tools = await d.mcp.listTools(`conn_${rec.id.replace(/[^a-z0-9]/g, "_")}`, server, d.timeoutMs);
      return done(tools.length > 0, tools.length > 0 ? `${name}'s connector server answered with ${tools.length} tools.` : `${name}'s connector server answered but offers no tools.`, tools.length);
    } catch {
      return done(false, `${name}'s connector server did not answer.`);
    }
  }
  return done(false, `${name} is not set up yet.`);
}
