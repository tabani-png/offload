// s27: a read step fetches its source's values itself (slices/s27-workflow-reads/SPEC.md, design 3). The source (a
// target of the connector chain) is resolved in the chain's order: MCP -> Composio -> direct API -> computer use (a
// read-only screen read, the last resort). Every call a reader makes goes through a gate in mode "read": only
// allowlisted reads pass; anything else is refused before it runs ("a read step only reads"), and a refusal stops the
// read (no other method is tried for it). A method that fails is marked failed and the next one reads. What comes
// back becomes rows of [commit label, value] by code (plan/read-source.ts readValues); nothing is guessed.
import type { ReadSourceDTO, ReadStatusDTO } from "../api/s14-types.ts";
import { scrubLogText } from "../log.ts";
import { apiServer } from "../connectors/api.ts";
import { apiReadOperations, buildRequest, mapArgs, pathParams } from "../connectors/api.ts";
import type { ChainResolver, FetchLike, MethodState } from "../connectors/chain.ts";
import { COMPOSIO_CLI_SERVER } from "../connectors/composio.ts";
import type { ComputerDriver } from "../connectors/computer/driver.ts";
import { computerPolicies } from "../connectors/computer/executor.ts";
import { computerServer } from "../connectors/computer/probe.ts";
import { loadConnectorsConfig, toMcpServers, type Env } from "../connectors/config.ts";
import { linkEnv, type LinkRunner, type Method } from "../connectors/link.ts";
import type { SecretReader } from "../connectors/secrets.ts";
import type { ChainTarget } from "../connectors/targets.ts";
import { confirmOnScreen, contextWords, mentionsContext, parseExact, readValueParts, type AnswerPart, queryArgs, queryOf, sourceTarget, type ReadOutcome, type SkippedRow } from "../plan/read-source.ts";
import type { ToolPolicy } from "./allowlist.ts";
import { makeBatch } from "./batch.ts";
import { createGate, READ_ONLY_WORDS, splitMcpName } from "./gate.ts";
import { updateWorkflow, WorkflowGoneError } from "./store.ts";
import type { WorkflowJson } from "./types.ts";

/** Asks the read gate about one call; runs it only when allowed. A refused call throws ReadRefused. */
export type ReadCall = <T = string>(tool: string, input: Record<string, unknown>, run: () => Promise<T>) => Promise<T>;

/** What a reader returns: the source's text, or the text with a note on how exact it is (MCP structuredContent). */
export type ReaderAnswer = string | { text: string; note?: string } | { parts: AnswerPart[]; note?: string };

export interface ReaderJob {
  target: ChainTarget;
  state: MethodState;
  source: ReadSourceDTO;
  /** The learned read arguments (report, fields, filters): what a connector or API read is asked for. */
  args: Record<string, unknown>;
  call: ReadCall;
  /** Aborted when the workflow is paused or deleted: readers stop and send nothing more. */
  signal?: AbortSignal;
}

/** One way of reading a source (per chain method). Every call goes through `job.call`. Returns what the source showed. */
export interface SourceReader {
  read(job: ReaderJob): Promise<ReaderAnswer>;
}

export class ReadRefused extends Error {}
export class ReadCancelled extends Error {}

export type FetchResult =
  | { ok: true; via: Method; rows: Array<Array<[string, string]>>; message: string; /** The answer says it has more pages; only the first was read. */ more?: true; /** Rows not complete: skipped, never done. */ skipped?: SkippedRow[] }
  | { ok: false; status: "refused" | "not_read" | "cancelled"; via: null; message: string };

export interface FetchOptions {
  wf: WorkflowJson;
  now: number;
  logPath?: string;
  signal?: AbortSignal;
  /** Non-null when the run must stop (paused, deleted): checked before every method and every call. */
  cancelled?: () => string | null;
  /** Rows to keep (live runs: not done yet). Applied before anything else is limited, so done rows never hide new ones. */
  keep?: (fields: Array<[string, string]>) => boolean;
}

export interface SourceFetcher {
  fetch(o: FetchOptions): Promise<FetchResult>;
}

/** s27 round 6: what an answer's outcome does to the chain. ok and empty are successful reads: stop (never fall back to
 * the list, whose rows may be stale). wrong_context and unreadable: try the next method (wrong_context also marks this
 * method failed); only when every method is exhausted does the run fall back to the list. */
export function chainStep(kind: ReadOutcome["kind"]): "stop" | "next" {
  return kind === "ok" || kind === "empty" ? "stop" : "next";
}
export const marksFailed = (kind: ReadOutcome["kind"]): boolean => kind === "wrong_context";

/** An answer larger than this is refused, never cut (a cut answer could drop rows silently). */
export const MAX_ANSWER_CHARS = 5_000_000;

/** How each method reads, in plain words (no internal words: the app's lint refuses mcp, token, gate, ...). */
export const VIA_WORDS: Record<Method, string> = {
  mcp: "through its connector on this Mac",
  composio: "through Composio",
  api: "through its direct connection",
  computer: "by reading its screen (no clicks, no typing)",
};

const CONCRETE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/;

/** The read policies of one method for the target, bound to that method's server: the probe's read tools only. */
export function readPolicies(target: ChainTarget, state: MethodState): { servers: Record<string, string[]>; policies: ToolPolicy[] } {
  const servers: Record<string, string[]> = {};
  const policies: ToolPolicy[] = [];
  if (state.method === "computer") {
    servers[computerServer(target.id)] = [target.id];
    policies.push(...computerPolicies([target.id]));
    return { servers, policies };
  }
  const flavor = state.method === "composio" ? "composio" : "api";
  for (const cap of state.reads) {
    const tool = state.tools[cap];
    if (tool === undefined || !CONCRETE.test(tool)) continue;
    const parts = splitMcpName(tool);
    if (parts === null) continue;
    servers[parts.server] = [target.id];
    policies.push({ connector: target.id, flavor, tool: parts.tool, role: "read", verified: false, server: parts.server });
  }
  if (state.method === "composio") servers[COMPOSIO_CLI_SERVER] ??= [target.id];
  if (state.method === "api") servers[apiServer(target.id)] ??= [target.id];
  return { servers, policies };
}

/** The first concrete read tool a method offers for the target (null: nothing this method can call). */
export function readTool(target: ChainTarget, state: MethodState): string | null {
  if (state.method === "computer") return `mcp__${computerServer(target.id)}__read`;
  for (const cap of state.reads) {
    const t = state.tools[cap];
    if (t !== undefined && CONCRETE.test(t)) return t;
  }
  return null;
}

export class ChainSourceFetcher implements SourceFetcher {
  constructor(
    private readonly o: {
      resolver: ChainResolver;
      readers: Partial<Record<Method, SourceReader>>;
      log?: (line: string) => void;
    },
  ) {}

  async fetch(f: FetchOptions): Promise<FetchResult> {
    const src = f.wf.read;
    if (src === undefined) return { ok: false, status: "not_read", via: null, message: "Offload has not seen where these values come from." };
    const stop = (): string | null => (f.signal?.aborted === true ? "the workflow was paused or deleted" : (f.cancelled?.() ?? null));
    const cancelled = (why: string): FetchResult => ({ ok: false, status: "cancelled", via: null, message: `stopped before reading ${src.targetName}: ${why}` });
    const target = sourceTarget(src);
    const args = queryArgs(queryOf(src));
    let why0 = stop();
    if (why0 !== null) return cancelled(why0);
    let states: MethodState[];
    try {
      states = (await this.o.resolver.resolve(target)).methods.filter((m) => m.health === "ok" && m.reads.length > 0);
    } catch (err) {
      this.o.log?.(`brain: ${f.wf.id}: cannot resolve ${src.target}: ${err instanceof Error ? err.message : String(err)}`);
      states = [];
    }
    const why: string[] = [];
    for (const state of states) {
      // A pause or delete stops the whole chain: no next method, no screen opened.
      why0 = stop();
      if (why0 !== null) return cancelled(why0);
      const reader = this.o.readers[state.method];
      if (reader === undefined || readTool(target, state) === null) continue;
      const { servers, policies } = readPolicies(target, state);
      const gate = createGate({
        workflowId: f.wf.id,
        mode: "read",
        batch: makeBatch(f.wf.id, "dry_run", [], f.now),
        autoRun: false,
        runToken: null,
        approvals: () => undefined,
        servers,
        policies,
        actions: [],
        cancelled: stop,
        ...(f.logPath === undefined ? {} : { logPath: f.logPath }),
        now: () => f.now,
      });
      let refused: string | null = null;
      const call: ReadCall = async (tool, input, run) => {
        const s = stop();
        if (s !== null) throw new ReadCancelled(s);
        const { decision } = gate.check(tool, input);
        if (!decision.allow) {
          const s2 = stop();
          if (s2 !== null) throw new ReadCancelled(s2);
          refused ??= decision.reason;
          throw new ReadRefused(decision.reason);
        }
        return run();
      };
      let text: string;
      let parts: AnswerPart[];
      let note: string | undefined;
      try {
        const ans = await reader.read({ target, state, source: src, args, call, ...(f.signal === undefined ? {} : { signal: f.signal }) });
        parts = typeof ans === "string" ? [{ kind: "text", text: ans }] : "parts" in ans ? ans.parts : [{ kind: "text", text: ans.text }];
        text = parts.map((x) => (x.kind === "text" ? x.text : JSON.stringify(x.value))).join("\n");
        note = typeof ans === "string" ? undefined : ans.note;
      } catch (err) {
        // Cancelled: the method is not to blame and nothing else is tried.
        const s = stop();
        if (s !== null || err instanceof ReadCancelled) return cancelled(s ?? (err as Error).message);
        if (refused !== null || err instanceof ReadRefused) return { ok: false, status: "refused", via: null, message: `Offload stopped the read of ${src.targetName}: ${refused ?? READ_ONLY_WORDS}.` };
        this.o.resolver.markFailed(target.id, state.method, err);
        why.push(`${VIA_WORDS[state.method]}: ${plainError(err)}`);
        continue;
      }
      why0 = stop();
      if (why0 !== null) return cancelled(why0);
      // A reader that swallowed a refusal still read nothing usable: what it returns is not used.
      if (refused !== null) return { ok: false, status: "refused", via: null, message: `Offload stopped the read of ${src.targetName}: ${refused}.` };
      if (text.length > MAX_ANSWER_CHARS) {
        why.push(`${VIA_WORDS[state.method]}: ${src.targetName} answered with more than Offload reads at once`);
        continue;
      }
      // Only what can be confirmed: the screen must show the learned report and filters (no navigation, no filter
      // change); a connector answer that names another report or filter is not the approved data.
      const query = queryOf(src);
      const onScreen = state.method === "computer" ? confirmOnScreen(text, query) : null;
      if (onScreen !== null) {
        why.push(`${VIA_WORDS[state.method]}: ${onScreen}`);
        continue;
      }
      // One parse with an explicit outcome; what each outcome does to the chain is chainStep (tested).
      // ONE answer from every part the reader got (round 14): context of every part first, then rows.
      const out = readValueParts(parts, src.fields, query);
      const step = chainStep(out.kind);
      if (step === "next") {
        const reason = out.kind === "wrong_context" ? out.reason : out.kind === "unreadable" ? `${src.targetName} ${out.reason}` : "";
        if (marksFailed(out.kind)) this.o.resolver.markFailed(target.id, state.method, new Error(reason));
        why.push(`${VIA_WORDS[state.method]}: ${reason}`);
        continue;
      }
      const rows = out.kind === "ok" ? out.rows : [];
      const skipped = out.kind === "ok" ? out.skipped : [];
      const more = out.kind === "ok" || out.kind === "empty" ? out.more : undefined;
      // Done rows are dropped first; the batch size is applied later, to what is left (never the other way round).
      return {
        ok: true,
        via: state.method,
        rows: f.keep === undefined ? rows : rows.filter(f.keep),
        message: `Read from ${src.targetName} ${VIA_WORDS[state.method]}.${note === undefined ? "" : ` ${note}`}${out.kind === "empty" ? ` It has no rows for ${contextWords(query)} right now.` : ""}${state.method === "computer" || mentionsContext(text, query) ? "" : ` It did not say which report or period it answered for; Offload asked for ${contextWords(query)}.`}`,
        ...(more === true ? { more } : {}),
        ...(skipped.length === 0 ? {} : { skipped }),
      };
    }
    return { ok: false, status: "not_read", via: null, message: why.length === 0 ? `no way to read ${src.targetName} is set up on this Mac yet.` : `${why.join("; ")}.` };
  }
}

const plainError = (err: unknown) =>
  scrubLogText(err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, " ")
    .slice(0, 160);

/** Remembers the last read on the workflow (the dashboard counts reading time as saved only after a real read). */
export function recordRead(home: string, id: string, r: FetchResult, now: number): ReadStatusDTO | null {
  const status: ReadStatusDTO = { at: now, ok: r.ok, via: r.ok ? r.via : null, message: r.message };
  try {
    updateWorkflow(home, id, (w) => {
      if (w.read !== undefined) w.read = { ...w.read, lastRead: status };
    }, now);
  } catch (err) {
    if (!(err instanceof WorkflowGoneError)) throw err;
    return null;
  }
  return status;
}

// ---------- the default readers (real) ----------

/**
 * s27 round 12: a direct read's arguments. The operation's configured `map` (connectors.json) is read with the same
 * code as sends (api.ts mapArgs); a read's map may hold fixed values only. Rule: configured fixed values win on every
 * clash (ids and scope always; report, fields and filters when the configuration pins them); the learned query fills
 * only the arguments the configuration does not set.
 */
export function readArgs(op: { operationId: string; path: string; map: Record<string, string | boolean> }, learned: Record<string, unknown>): Record<string, unknown> {
  const dynamic = Object.entries(op.map).filter(([, v]) => typeof v === "string" && v.startsWith("$")).map(([k]) => k);
  if (dynamic.length > 0) throw new Error(`a read's configured arguments must be fixed values (${dynamic.join(", ")} is not)`);
  const fixed = mapArgs({ capability: "", operationId: op.operationId, method: "GET", path: op.path, role: "read", fields: {}, body: "none", map: op.map }, NO_ITEM, { batchHash: "" }) ?? {};
  return { ...learned, ...fixed };
}
const NO_ITEM = { key: "", to: "", subject: "", body: "", warnings: [] };

/**
 * s27 round 14: what an MCP tool answered, as the parts of ONE answer for the shared parser: every text block and
 * every embedded resource with text (exactly as sent), then structuredContent (a value the MCP software already
 * parsed: `note` says its number formatting comes from that software, round 9 honesty rule). Nothing is dropped or
 * chosen here: the parser checks the context of every part before it picks rows. Images, audio and blobs are not read.
 */
export function mcpAnswer(r: { content?: unknown; structuredContent?: unknown }): { parts: AnswerPart[]; note?: string } {
  const blocks = Array.isArray(r.content) ? (r.content as Array<{ type?: string; text?: string; resource?: { text?: unknown } }>) : [];
  const parts: AnswerPart[] = [];
  for (const c of blocks) {
    if (c.type === "text" && typeof c.text === "string") parts.push({ kind: "text", text: c.text });
    else if (c.type === "resource" && typeof c.resource?.text === "string") parts.push({ kind: "text", text: c.resource.text });
  }
  const structured = r.structuredContent !== undefined && r.structuredContent !== null && typeof r.structuredContent === "object";
  if (!structured) return { parts };
  parts.push({ kind: "json", value: r.structuredContent });
  return { parts, note: "Its structured part's number formatting comes from the connector software." };
}

/** Computer use, read only: open the app or site, then read the window's accessibility text. No planner, no clicks. */
export class ScreenReader implements SourceReader {
  constructor(private readonly driver: ComputerDriver) {}

  async read(job: ReaderJob): Promise<string> {
    const p = await this.driver.permissions();
    if (!p.accessibility || !p.screenRecording) throw new Error("Offload is not allowed to read the screen");
    const tool = `mcp__${computerServer(job.target.id)}__read`;
    // Opens only the site or app (never a stored page address); Offload's own view comes from a connector or API query.
    const aborted = (): boolean => job.signal?.aborted === true;
    if (aborted()) throw new ReadCancelled("stopped");
    await job.call(tool, { member: "open" }, async () => {
      await this.driver.open(job.target);
      return "";
    });
    if (aborted()) throw new ReadCancelled("stopped");
    return job.call(tool, { member: "read_ui" }, () => this.driver.readUi());
  }
}

/** A connector server on this Mac: one call of the read tool the probe found (no arguments). */
export class McpSourceReader implements SourceReader {
  constructor(private readonly o: { home: string; env: Env }) {}

  async read(job: ReaderJob): Promise<ReaderAnswer> {
    const tool = readTool(job.target, job.state);
    const parts = tool === null ? null : splitMcpName(tool);
    if (tool === null || parts === null) throw new Error("no read tool");
    const cfg = loadConnectorsConfig(this.o.home).config;
    if (cfg === null || cfg.servers[parts.server] === undefined) throw new Error("the connector is not set up");
    const server = toMcpServers({ ...cfg, servers: { [parts.server]: cfg.servers[parts.server]! } }, this.o.env)[parts.server]!;
    return job.call(tool, job.args, async () => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: "offload-brain-read", version: "1" });
      try {
        if (server.type === "http") {
          const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers ?? {}, redirect: "error" } }));
        } else if (server.type === undefined || server.type === "stdio") {
          const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
          await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], ...(server.env === undefined ? {} : { env: server.env }), stderr: "pipe" }));
        } else {
          throw new Error("this kind of connector is not supported here");
        }
        const r = await client.callTool({ name: parts.tool, arguments: job.args }, undefined, job.signal === undefined ? {} : { signal: job.signal });
        if (r.isError === true) throw new Error("the connector answered with an error");
        return mcpAnswer(r as { content?: unknown; structuredContent?: unknown });
      } finally {
        await client.close().catch(() => {});
      }
    });
  }
}

/** Composio: `composio execute <read slug> -d {} --account <id>`; the answer's data as JSON. */
export class ComposioSourceReader implements SourceReader {
  constructor(private readonly o: { runner: LinkRunner; env: Env; timeoutMs?: number }) {}

  async read(job: ReaderJob): Promise<string> {
    const tool = readTool(job.target, job.state);
    const parts = tool === null ? null : splitMcpName(tool);
    const account = job.state.info?.account;
    if (tool === null || parts === null || account === undefined) throw new Error("no Composio read for this app");
    return job.call(tool, job.args, async () => {
      if (job.signal?.aborted === true) throw new ReadCancelled("stopped");
      // Round 11: the same allowlist the Composio probes and executors use (linkEnv): never OFFLOAD_TOKEN, a model
      // login or a connector secret. The output cap is the read limit + 1, so an answer over it is told apart and
      // refused explicitly, never cut and parsed.
      const r = await this.o.runner.run(["composio", "execute", parts.tool, "-d", JSON.stringify(job.args), "--account", account], { timeoutMs: this.o.timeoutMs ?? 30_000, env: linkEnv(this.o.env), maxBytes: MAX_ANSWER_CHARS + 1 });
      if (r.stdout.length > MAX_ANSWER_CHARS) throw new Error("Composio's answer is larger than Offload reads at once; nothing was read");
      if (r.spawnError !== undefined || r.timedOut || r.code !== 0) throw new Error(r.timedOut ? "Composio did not answer in time" : "Composio did not read it");
      // The CLI's raw text goes to the shared exact parser unchanged (round 9): no JSON.parse/stringify round trip,
      // so decimals (25.50), big integers and duplicate keys reach it as Composio sent them. Only `successful` is
      // looked at here, with the same exact parser.
      let ok = false;
      try {
        const env0 = parseExact(r.stdout.trim()) as { successful?: unknown } | null;
        ok = env0 !== null && typeof env0 === "object" && env0.successful === true;
      } catch {
        ok = false;
      }
      if (!ok) throw new Error("Composio did not read it");
      return r.stdout;
    });
  }
}

/** A direct connection: the configured read operation (GET), its JSON answer. The sign-in is read in memory only. */
export class ApiSourceReader implements SourceReader {
  constructor(private readonly o: { home: string; fetch: FetchLike; secrets: SecretReader; timeoutMs?: number }) {}

  async read(job: ReaderJob): Promise<string> {
    const tool = readTool(job.target, job.state);
    const parts = tool === null ? null : splitMcpName(tool);
    const entry = loadConnectorsConfig(this.o.home).config?.apis?.[job.target.id];
    // The same resolver the probe advertised it from (configured reads and OpenAPI GETs).
    const op = entry === undefined ? undefined : apiReadOperations(entry).find((x) => x.operationId === parts?.tool);
    if (tool === null || entry === undefined || op === undefined) throw new Error("no direct read for this app");
    // The learned arguments fill the path first ({report}); a path argument Offload did not learn is a plain refusal
    // of this way (never an empty path segment); only the arguments left go in the query string.
    const text = (v: unknown) => (Array.isArray(v) ? v.map(String).join(",") : v === null || v === undefined ? "" : String(v));
    const args = readArgs(op, job.args);
    const params = pathParams(op.path);
    const lacking = params.filter((k) => text(args[k]).trim() === "");
    if (lacking.length > 0) throw new Error(`the direct read needs ${lacking.join(", ")}, which Offload has not seen you use`);
    return job.call(tool, args, async () => {
      const secret = entry.auth === null ? null : await this.o.secrets.read(entry.auth.secret);
      const built = buildRequest(entry, { method: "GET", path: op.path, body: "none" }, Object.fromEntries(params.map((k) => [k, text(args[k])])), secret);
      // The arguments not in the path (configured ids and scope, then the learned report, fields, filters) as the query.
      const u = new URL(built.url);
      for (const [k, v] of Object.entries(args)) if (!params.includes(k)) u.searchParams.set(k, text(v));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? 15_000);
      const onAbort = () => ac.abort();
      job.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await this.o.fetch(u.toString(), { ...built.init, signal: ac.signal, redirect: "error" });
        if (res.status < 200 || res.status >= 300) throw new Error(`the service answered ${res.status}`);
        // Never cut: the fetcher refuses an answer over MAX_ANSWER_CHARS instead.
        return await res.text();
      } finally {
        clearTimeout(timer);
        job.signal?.removeEventListener("abort", onAbort);
      }
    });
  }
}
