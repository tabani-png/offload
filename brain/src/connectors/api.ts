// s13: the api method: direct HTTP to a service, described in connectors.json `apis` (api-config.ts). A generic adapter:
// operations come from the config (and, for reads, from a local OpenAPI file). The credential is a reference to an env
// var or a Keychain item, read in memory per request (secrets.ts) and never logged, stored or returned. Every
// operation is a gate policy bound to the server name `api_<target>`; a write's full arguments are canonicalised and
// hashed like the MCP send tool and must equal the approved item's. The executor is deterministic (no model).
import { existsSync, readFileSync } from "node:fs";
import { crmRow, type ToolPolicy } from "../workflows/allowlist.ts";
import type { BatchItem } from "../workflows/batch.ts";
import type { ExecJob, ExecResult, Executor, ToolCallRecord } from "../workflows/executor.ts";
import type { ApiEntry, ApiOperation, ApisConfig } from "./api-config.ts";
import { CHAIN_WORDS, result, scrubError, withTimeout, type ChainDeps, type FetchLike, type MethodProbe, type ProbeResult } from "./chain.ts";
import { MethodFailed } from "./composio.ts";
import { loadConnectorsConfig, type ConnectorsConfig } from "./config.ts";
import { redact, type SecretReader } from "./secrets.ts";
import type { ChainTarget } from "./targets.ts";

export const apiServer = (targetId: string) => `api_${targetId.replace(/-/g, "_")}`;
export const API_REQUEST_TIMEOUT_MS = 30_000;

/** GET operations of a local OpenAPI 3 document: `api.<operationId>` read capabilities. Writes are never taken from it. */
export function openapiReads(doc: unknown): Array<{ operationId: string; path: string }> {
  const out: Array<{ operationId: string; path: string }> = [];
  const paths = (doc as { paths?: unknown } | null)?.paths;
  if (typeof paths !== "object" || paths === null) return out;
  for (const [path, ops] of Object.entries(paths as Record<string, unknown>)) {
    const get = (ops as { get?: { operationId?: unknown } } | null)?.get;
    if (typeof get?.operationId === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(get.operationId)) out.push({ operationId: get.operationId, path });
  }
  return out;
}

function readOpenapi(entry: ApiEntry): Array<{ operationId: string; path: string }> {
  if (entry.openapi === null || !existsSync(entry.openapi)) return [];
  try {
    return openapiReads(JSON.parse(readFileSync(entry.openapi, "utf8")));
  } catch {
    return [];
  }
}

/** The arguments an operation expects for an approved item, from its `map`; null when one cannot be built. */
export function mapArgs(op: ApiOperation, item: BatchItem, ctx: { batchHash: string; crmSheet?: { spreadsheetId: string; range: string } }): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, src] of Object.entries(op.map)) {
    if (typeof src === "boolean" || !src.startsWith("$")) {
      out[k] = src;
      continue;
    }
    if (src === "$item.to") out[k] = item.to;
    else if (src === "$item.subject") out[k] = item.subject;
    else if (src === "$item.body") out[k] = item.body;
    else if (src === "$crm.row") out[k] = [crmRow(item, ctx.batchHash)];
    else if (src === "$crm.spreadsheetId" || src === "$crm.range") {
      if (ctx.crmSheet === undefined) return null;
      out[k] = src === "$crm.range" ? ctx.crmSheet.range : ctx.crmSheet.spreadsheetId;
    } else if (src.startsWith("$item.commit.")) {
      const label = src.slice("$item.commit.".length);
      const f = item.commit?.fields.find(([l]) => l === label);
      if (f === undefined) return null;
      out[k] = f[1];
    } else return null;
  }
  return out;
}

/** s27: the one resolver of a direct connection's READ operations (configured reads, then OpenAPI GETs): the probe,
 * the gate policies and the read step all use it, so a read the probe advertises is a read the reader can run. */
export function apiReadOperations(entry: ApiEntry): Array<{ capability: string; operationId: string; path: string }> {
  const out = entry.operations.filter((o) => o.role === "read").map((o) => ({ capability: o.capability, operationId: o.operationId, path: o.path }));
  for (const r of readOpenapi(entry)) if (!out.some((o) => o.operationId === r.operationId)) out.push({ capability: `api.${r.operationId}`, operationId: r.operationId, path: r.path });
  return out;
}

/** Gate policies for every configured operation (and OpenAPI reads), each bound to its target's api server. */
export function apiPolicies(apis: ApisConfig | undefined): ToolPolicy[] {
  const out: ToolPolicy[] = [];
  for (const [id, entry] of Object.entries(apis ?? {})) {
    const server = apiServer(id);
    for (const op of entry.operations) {
      out.push({
        connector: id,
        flavor: "api",
        tool: op.operationId,
        role: op.role,
        verified: false,
        server,
        ...(op.role === "read" ? {} : { fields: op.fields, expected: (item: BatchItem, ctx: { batchHash: string; crmSheet?: { spreadsheetId: string; range: string } }) => mapArgs(op, item, ctx) }),
      });
    }
    for (const r of apiReadOperations(entry)) if (!out.some((p) => p.server === server && p.tool === r.operationId)) out.push({ connector: id, flavor: "api", tool: r.operationId, role: "read", verified: false, server });
  }
  return out;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** RFC 5322 plain-text message, base64url (Gmail users.messages.send `raw`). Subject RFC 2047 encoded. */
export function gmailRaw(to: string, subject: string, body: string): string {
  const mime = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64"),
  ].join("\r\n");
  return b64url(Buffer.from(mime, "utf8"));
}

/** The HTTP request for one operation. The secret goes only into the auth header. */
export function buildRequest(entry: ApiEntry, op: Pick<ApiOperation, "method" | "path" | "body">, args: Record<string, unknown>, secret: string | null): { url: string; init: RequestInit } {
  const used = new Set<string>();
  const path = op.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => {
    used.add(k);
    return encodeURIComponent(String(args[k] ?? ""));
  });
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "offload-brain/1" };
  if (entry.auth !== null && secret !== null) {
    if (entry.auth.type === "bearer") headers.authorization = `Bearer ${secret}`;
    else headers[entry.auth.header!.toLowerCase()] = secret;
  }
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
  let body: string | undefined;
  if (op.method !== "GET" && op.body !== "none") {
    headers["content-type"] = "application/json";
    body = op.body === "gmail-raw" ? JSON.stringify({ raw: gmailRaw(String(rest.to), String(rest.subject), String(rest.body)) }) : JSON.stringify(rest);
  }
  return { url: `${entry.baseUrl}${path}`, init: { method: op.method, headers, ...(body === undefined ? {} : { body }), redirect: "error" } };
}

async function timedFetch(f: FetchLike, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), ms);
  try {
    return await withTimeout(f(url, { ...init, signal: ac.signal }), ms + 50);
  } finally {
    clearTimeout(timer);
  }
}

export class ApiProbe implements MethodProbe {
  readonly method = "api" as const;

  async probe(t: ChainTarget, d: ChainDeps): Promise<ProbeResult> {
    const entry = loadConnectorsConfig(d.home).config?.apis?.[t.id];
    if (entry === undefined) return result("skipped", "no_api", CHAIN_WORDS.apiNone(t.name));
    if (entry.health === null) return result("skipped", "no_health_check", CHAIN_WORDS.apiNone(t.name));
    let secret: string | null = null;
    if (entry.auth !== null) {
      try {
        secret = await d.secrets.read(entry.auth.secret);
      } catch {
        return result("skipped", "no_secret", CHAIN_WORDS.apiNoSecret);
      }
    }
    const t0 = d.now();
    const { url, init } = buildRequest(entry, { method: "GET", path: entry.health.path, body: "none" }, {}, secret);
    try {
      const res = await timedFetch(d.fetch, url, init, d.timeoutMs);
      await res.body?.cancel().catch(() => {});
      if (res.status === 401 || res.status === 403) return result("failed", "refused", CHAIN_WORDS.apiRefused, {}, d.now() - t0);
      if (res.status < 200 || res.status >= 300) return result("failed", `http_${res.status}`, CHAIN_WORDS.apiDown, {}, d.now() - t0);
    } catch (err) {
      d.log?.(`brain: chain ${t.id}: api health failed: ${scrubError(err, secret === null ? [] : [secret])}`);
      return result("failed", "down", CHAIN_WORDS.apiDown, {}, d.now() - t0);
    }
    const server = apiServer(t.id);
    const readOps = apiReadOperations(entry);
    const reads = readOps.map((o) => o.capability);
    const writes = entry.operations.filter((o) => o.role !== "read").map((o) => o.capability);
    const tools: Record<string, string> = Object.fromEntries(entry.operations.filter((o) => o.role !== "read").map((o) => [o.capability, `mcp__${server}__${o.operationId}`]));
    for (const r of readOps) tools[r.capability] ??= `mcp__${server}__${r.operationId}`;
    return result("ok", "ok", null, { reads, writes, tools }, d.now() - t0);
  }
}

export interface ApiExecOptions {
  fetch: FetchLike;
  secrets: SecretReader;
  config: ConnectorsConfig;
  timeoutMs?: number;
}

/** Deterministic sends (and logs) over HTTP, every call through the gate first. */
export class ApiExecutor implements Executor {
  constructor(private readonly o: ApiExecOptions) {}

  async execute(job: ExecJob): Promise<ExecResult> {
    const actions = job.actions ?? [{ role: "send" as const, connector: "gmail" }];
    for (const a of actions.filter((x) => x.role === "send"))
      if (this.o.config.apis?.[a.connector]?.operations.some((o) => o.role === "send") !== true) throw new MethodFailed(`no direct send is set up for ${a.connector}`);
    // Preflight: every secret this run needs is read before any item is used.
    const secrets = new Map<string, string | null>();
    for (const a of actions) {
      const entry = this.o.config.apis?.[a.connector];
      if (entry === undefined || secrets.has(a.connector)) continue;
      try {
        secrets.set(a.connector, entry.auth === null ? null : await this.o.secrets.read(entry.auth.secret));
      } catch {
        throw new MethodFailed("the sign-in for the direct connection could not be read");
      }
    }
    const known = [...secrets.values()].filter((s): s is string => s !== null);
    const toolCalls: ToolCallRecord[] = [];
    for (const item of job.batch.items) {
      if (job.only !== undefined && !job.only.has(item.key)) continue;
      if (job.signal?.aborted === true) break;
      for (const a of [...actions].sort((x, y) => (x.role === y.role ? 0 : x.role === "send" ? -1 : 1))) {
        const entry = this.o.config.apis?.[a.connector];
        const op = entry?.operations.find((o) => o.role === a.role);
        if (entry === undefined || op === undefined) continue;
        const args = mapArgs(op, item, { batchHash: job.batch.hash, ...(job.crmSheet === undefined ? {} : { crmSheet: job.crmSheet }) });
        if (args === null) continue;
        const tool = `mcp__${apiServer(a.connector)}__${op.operationId}`;
        const { result: perm, decision } = job.gate.check(tool, args);
        const rec: ToolCallRecord = { tool, input: args, allowed: perm.behavior === "allow", ok: false, ...(decision.itemKey === undefined ? {} : { itemKey: decision.itemKey }), ...(decision.role === undefined ? {} : { role: decision.role }) };
        toolCalls.push(rec);
        if (!rec.allowed) {
          if (a.role === "send") break;
          continue;
        }
        const { url, init } = buildRequest(entry, op, args, secrets.get(a.connector) ?? null);
        try {
          const res = await timedFetch(this.o.fetch, url, init, this.o.timeoutMs ?? API_REQUEST_TIMEOUT_MS);
          await res.body?.cancel().catch(() => {});
          rec.ok = res.status >= 200 && res.status < 300;
          if (!rec.ok) rec.error = `the service answered ${res.status}`;
        } catch (err) {
          rec.error = redact(scrubError(err, known), known);
        }
        job.onToolResult?.(rec);
        if (!rec.ok) throw new MethodFailed(rec.error ?? "the request failed");
      }
    }
    return { toolCalls, text: `${toolCalls.filter((c) => c.ok).length} of ${toolCalls.length} direct calls done` };
  }
}
