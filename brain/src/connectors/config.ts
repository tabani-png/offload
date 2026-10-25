// $OFFLOAD_HOME/connectors.json: the MCP servers the user connected, mapped to catalog ids (gmail, google-calendar…).
// The file never holds a secret: headers and env values are NAMED by env var and resolved in memory at run time.
// Setup guide: brain/CONNECTORS.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { parseApis, type ApisConfig } from "./api-config.ts";
import { CONNECTORS, connectorById } from "./catalog.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export interface StdioServer {
  type: "stdio";
  command: string;
  args: string[];
  /** Child env var -> name of the brain's env var that holds the value. */
  envFromEnv: Record<string, string>;
  catalog: string[];
}

export interface HttpServer {
  type: "http";
  url: string;
  /** Header -> name of the env var that holds the value. */
  headersFromEnv: Record<string, string>;
  catalog: string[];
}

export type ServerEntry = StdioServer | HttpServer;

export interface MailSourceConfig {
  server: string;
  listTool: string;
  args: Record<string, unknown>;
  limitArg?: string;
}

export interface ConnectorsConfig {
  version: 1;
  servers: Record<string, ServerEntry>;
  /** Which server and read tool the tone pack reads Sent mail from. */
  mail?: MailSourceConfig;
  /** s13: direct HTTP access per target id (api-config.ts). Names env vars / Keychain items, never a value. */
  apis?: ApisConfig;
}

export type ConnectorStatus = "connected" | "missing_env" | "missing";

export const connectorsPath = (home: string) => join(home, "connectors.json");

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const SECRET_RES = [/\bsk-[A-Za-z0-9_-]{12,}/, /\bBearer\s+\S+/i, /[A-Za-z0-9_]{32,}/, /[?&](?:api[_-]?key|token|secret|key|access_token)=/i, /\b(?:ghp|gho|xox[abp])[_-][A-Za-z0-9-]{10,}/];

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

function scanSecrets(where: string, value: string, errors: string[]): void {
  if (SECRET_RES.some((re) => re.test(value))) errors.push(`${where} looks like a secret: name an env var instead (envFromEnv / headersFromEnv)`);
}

function envMap(where: string, raw: unknown, keyRe: RegExp, errors: string[]): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    errors.push(`${where} must be an object`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!keyRe.test(k)) errors.push(`${where}: bad key ${JSON.stringify(k)}`);
    if (typeof v !== "string" || !ENV_NAME_RE.test(v)) errors.push(`${where}.${k}: value must be an env var name (UPPER_SNAKE), got ${JSON.stringify(v)}`);
    else out[k] = v;
  }
  return out;
}

function parseServer(name: string, raw: unknown, errors: string[]): ServerEntry | null {
  const at = `servers.${name}`;
  if (!SERVER_NAME_RE.test(name)) errors.push(`${at}: server names are lowercase letters, digits, - and _`);
  if (!isObj(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  for (const k of ["env", "headers"]) if (k in raw) errors.push(`${at}.${k}: raw secrets are not allowed in connectors.json; use ${k === "env" ? "envFromEnv" : "headersFromEnv"} with env var names`);
  const catalog: string[] = [];
  if (!Array.isArray(raw.catalog) || raw.catalog.length === 0) errors.push(`${at}.catalog must list catalog ids`);
  else
    for (const id of raw.catalog) {
      if (typeof id !== "string" || connectorById(id) === undefined) errors.push(`${at}.catalog: unknown catalog id ${String(id)} (known: ${CONNECTORS.map((c) => c.id).join(", ")})`);
      else catalog.push(id);
    }
  if (raw.type === "stdio") {
    for (const k of Object.keys(raw)) if (!["type", "command", "args", "envFromEnv", "catalog", "env"].includes(k)) errors.push(`${at}: unknown key ${k}`);
    if (typeof raw.command !== "string" || raw.command === "") errors.push(`${at}.command is required`);
    else scanSecrets(`${at}.command`, raw.command, errors);
    const args: string[] = [];
    if (raw.args !== undefined && !Array.isArray(raw.args)) errors.push(`${at}.args must be a list of strings`);
    for (const [i, a] of (Array.isArray(raw.args) ? raw.args : []).entries()) {
      if (typeof a !== "string") errors.push(`${at}.args[${i}] must be a string`);
      else {
        scanSecrets(`${at}.args[${i}]`, a, errors);
        args.push(a);
      }
    }
    return { type: "stdio", command: typeof raw.command === "string" ? raw.command : "", args, envFromEnv: envMap(`${at}.envFromEnv`, raw.envFromEnv, ENV_NAME_RE, errors), catalog };
  }
  if (raw.type === "http") {
    for (const k of Object.keys(raw)) if (!["type", "url", "headersFromEnv", "catalog", "headers"].includes(k)) errors.push(`${at}: unknown key ${k}`);
    let url = "";
    if (typeof raw.url !== "string") errors.push(`${at}.url is required`);
    else {
      url = raw.url;
      scanSecrets(`${at}.url`, url, errors);
      try {
        const u = new URL(url);
        const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
        if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) errors.push(`${at}.url must be https (plain http only on 127.0.0.1)`);
      } catch {
        errors.push(`${at}.url is not a URL`);
      }
    }
    return { type: "http", url, headersFromEnv: envMap(`${at}.headersFromEnv`, raw.headersFromEnv, HEADER_RE, errors), catalog };
  }
  errors.push(`${at}.type must be "stdio" or "http"`);
  return null;
}

export function parseConnectorsConfig(raw: unknown): { config: ConnectorsConfig | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { config: null, errors: ["connectors.json must be an object"] };
  if (raw.version !== 1) errors.push("version must be 1");
  const servers: Record<string, ServerEntry> = {};
  if (!isObj(raw.servers)) errors.push("servers must be an object");
  else
    for (const [name, s] of Object.entries(raw.servers)) {
      const parsed = parseServer(name, s, errors);
      if (parsed !== null) servers[name] = parsed;
    }
  let mail: MailSourceConfig | undefined;
  if (raw.mail !== undefined) {
    const m = raw.mail;
    if (!isObj(m) || typeof m.server !== "string" || typeof m.listTool !== "string") errors.push("mail needs server and listTool");
    else {
      if (servers[m.server] === undefined) errors.push(`mail.server ${m.server} is not in servers`);
      const args = isObj(m.args) ? m.args : {};
      for (const [k, v] of Object.entries(args)) if (typeof v === "string") scanSecrets(`mail.args.${k}`, v, errors);
      mail = { server: m.server, listTool: m.listTool, args, ...(typeof m.limitArg === "string" ? { limitArg: m.limitArg } : {}) };
    }
  }
  const apis = parseApis(raw.apis, errors);
  if (errors.length > 0) return { config: null, errors };
  return { config: { version: 1, servers, ...(mail === undefined ? {} : { mail }), ...(Object.keys(apis).length === 0 ? {} : { apis }) }, errors };
}

export function loadConnectorsConfig(home: string): { config: ConnectorsConfig | null; errors: string[]; path: string } {
  const path = connectorsPath(home);
  if (!existsSync(path)) return { config: null, errors: [], path };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { config: null, errors: [`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`], path };
  }
  return { ...parseConnectorsConfig(raw), path };
}

export function envNames(s: ServerEntry): string[] {
  return Object.values(s.type === "stdio" ? s.envFromEnv : s.headersFromEnv);
}

export function missingEnv(s: ServerEntry, env: Env): string[] {
  return envNames(s).filter((n) => env[n] === undefined || env[n] === "");
}

/** Status of every catalog id. */
export function catalogStatus(cfg: ConnectorsConfig | null, env: Env): Record<string, ConnectorStatus> {
  const out: Record<string, ConnectorStatus> = {};
  for (const c of CONNECTORS) {
    const servers = Object.values(cfg?.servers ?? {}).filter((s) => s.catalog.includes(c.id));
    out[c.id] = servers.length === 0 ? "missing" : servers.some((s) => missingEnv(s, env).length === 0) ? "connected" : "missing_env";
  }
  return out;
}

function resolve(name: string, s: ServerEntry, env: Env): McpServerConfig {
  const missing = missingEnv(s, env);
  if (missing.length > 0) throw new Error(`server ${name} needs env ${missing.join(", ")}`);
  if (s.type === "http") {
    const headers: Record<string, string> = {};
    for (const [h, n] of Object.entries(s.headersFromEnv)) headers[h] = env[n]!;
    return Object.keys(headers).length === 0 ? { type: "http", url: s.url } : { type: "http", url: s.url, headers };
  }
  const childEnv: Record<string, string> = {};
  for (const k of ["PATH", "HOME"]) if (env[k] !== undefined) childEnv[k] = env[k]!;
  for (const [k, n] of Object.entries(s.envFromEnv)) childEnv[k] = env[n]!;
  return { type: "stdio", command: s.command, args: [...s.args], env: childEnv };
}

/**
 * Agent SDK `mcpServers` with secrets resolved from env (memory only). Without `only`, every server must resolve.
 * With `only` (catalog ids), the connected servers covering them; an id with no connected server throws.
 */
export function toMcpServers(cfg: ConnectorsConfig, env: Env, only?: readonly string[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (only === undefined) {
    for (const [name, s] of Object.entries(cfg.servers)) out[name] = resolve(name, s, env);
    return out;
  }
  for (const id of only) {
    const entry = Object.entries(cfg.servers).find(([, s]) => s.catalog.includes(id) && missingEnv(s, env).length === 0);
    if (entry === undefined) throw new Error(`no connected MCP server for ${id} (see brain/CONNECTORS.md)`);
    out[entry[0]] = resolve(entry[0], entry[1], env);
  }
  return out;
}
