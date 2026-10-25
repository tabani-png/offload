// s13: the composio method, through the Composio CLI (no Composio MCP server needed: "if the MCP doesn't work, find
// solutions around it"). Probe (read-only commands only, see isReadOnlyComposioArgv):
//   1. toolkit: the catalog toolkit, else `composio tools list <guess> --limit 1000`, else `composio search "<app>"`
//      and a result toolkit whose slug matches the app's name;
//   2. account: `composio connections list --toolkit <slug>` must show an ACTIVE account (an always_allow one is
//      preferred; an account that asks before every call is used for reads only, so a send can never hang on a prompt);
//   3. capabilities: toolkit tools that the gate's allowlist knows for the target. Meta tools never count.
// Executor: deterministic, no model. Per approved item it builds the arguments the gate expects, asks the gate
// (`mcp__composio_cli__<SLUG>`, the composio policies of allowlist.ts), and only on allow runs
// `composio execute <SLUG> -d <json> --account <id>`. A failed call stops the method (the item is unknown, never
// retried); the chain hands the never-attempted items to the next method.
import { TOOL_POLICIES, type ToolPolicy } from "../workflows/allowlist.ts";
import type { ExecJob, ExecResult, Executor, ToolCallRecord } from "../workflows/executor.ts";
import { CHAIN_WORDS, result, type ChainDeps, type MethodProbe, type ProbeResult } from "./chain.ts";
import type { Env } from "./config.ts";
import { linkEnv, type LinkRunner, type LinkRunResult } from "./link.ts";
import { capabilityOf, slugify, type ChainTarget } from "./targets.ts";

export const COMPOSIO_CLI_SERVER = "composio_cli";
export const COMPOSIO_EXECUTE_TIMEOUT_MS = 60_000;
/** Never usable, whatever the toolkit: Composio's own meta / multiplexer tools. */
export const COMPOSIO_META_RE = /^COMPOSIO_|MULTI_?EXECUTE|WORKBENCH|REMOTE_?BASH|_PROXY|^PROXY/i;

/** True for the only CLI commands a probe may run: listing, searching, schemas, connection status, whoami. */
export function isReadOnlyComposioArgv(argv: readonly string[]): boolean {
  if (argv[0] !== "composio") return false;
  const [, a, b] = argv;
  if (a === "--version" || a === "whoami" || a === "search") return true;
  if (a === "tools" && (b === "list" || b === "info")) return true;
  if (a === "connections" && b === "list") return true;
  if (a === "link" && argv.includes("--list") && !argv.includes("--no-wait")) return true;
  if (a === "execute" && typeof b === "string" && !b.startsWith("-")) {
    const rest = argv.slice(3);
    if (rest.length === 1 && rest[0] === "--get-schema") return true;
    if (!rest.includes("--dry-run")) return false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--dry-run") continue;
      if (rest[i] === "-d" && i + 1 < rest.length) {
        i++;
        continue;
      }
      return false;
    }
    return true;
  }
  return false;
}

/** The first JSON value in a command's stdout (the CLI prints JSON by default); null when there is none. */
export function parseJsonOut(stdout: string): unknown {
  const s = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
  for (const start of [s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0).sort((x, y) => x - y)) {
    try {
      return JSON.parse(s.slice(start));
    } catch {
      // try the next opening bracket
    }
  }
  return null;
}

export interface ComposioTool {
  slug: string;
  tags: string[];
}

export function parseToolsList(stdout: string): ComposioTool[] {
  const v = parseJsonOut(stdout);
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is { slug: string; tags?: unknown } => typeof x === "object" && x !== null && typeof (x as { slug?: unknown }).slug === "string").map((x) => ({ slug: x.slug, tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === "string") : [] }));
}

export interface ComposioAccount {
  wordId: string;
  status: string;
  askEveryCall: boolean;
}

export function parseConnections(stdout: string, toolkit: string): ComposioAccount[] {
  const v = parseJsonOut(stdout);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
  const list = (v as Record<string, unknown>)[toolkit];
  if (!Array.isArray(list)) return [];
  return list
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => ({ wordId: typeof x.word_id === "string" ? x.word_id : "", status: typeof x.status === "string" ? x.status : "", askEveryCall: x.permission_group === "ask_every_call" }))
    .filter((a) => a.wordId !== "");
}

/** The account Offload uses: ACTIVE and always_allow first, then ACTIVE that asks every call; null when none. */
export function pickAccount(accounts: readonly ComposioAccount[]): ComposioAccount | null {
  const active = accounts.filter((a) => a.status.toUpperCase() === "ACTIVE");
  return active.find((a) => !a.askEveryCall) ?? active[0] ?? null;
}

export function parseSearchToolkits(stdout: string): string[] {
  const v = parseJsonOut(stdout) as { results?: Array<{ toolkits?: unknown }> } | null;
  const out: string[] = [];
  for (const r of v?.results ?? []) if (Array.isArray(r.toolkits)) for (const t of r.toolkits) if (typeof t === "string" && !out.includes(t)) out.push(t);
  return out;
}

/** A search result toolkit matches the app when one slug contains the other (letters and digits only). */
export function toolkitMatches(toolkit: string, t: ChainTarget): boolean {
  const k = toolkit.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = [t.toolkit, slugify(t.name).replace(/-/g, ""), ...t.hosts.map((h) => h.replace(/^www\./, "").split(".")[0] ?? "")].filter((x) => x.length >= 3);
  return k.length >= 3 && names.some((n) => n === k || n.includes(k) || k.includes(n));
}

/** Guards a runner so the probe can only run read-only commands (a write would throw before it spawns). */
export function readOnlyRunner(runner: LinkRunner): LinkRunner {
  return {
    run(argv, opts) {
      if (!isReadOnlyComposioArgv(argv)) throw new Error(`refusing a Composio command that is not read-only: ${argv.slice(0, 2).join(" ")}`);
      return runner.run(argv, opts);
    },
  };
}

const failedRun = (r: LinkRunResult) => r.spawnError !== undefined || r.timedOut || r.code !== 0;

export class ComposioProbe implements MethodProbe {
  readonly method = "composio" as const;

  async probe(t: ChainTarget, d: ChainDeps): Promise<ProbeResult> {
    const run = readOnlyRunner(d.runner);
    const env = linkEnv(d.env);
    const opts = { timeoutMs: d.timeoutMs, env };
    const t0 = d.now();
    // 1. toolkit
    let toolkit = t.toolkit;
    let r = await run.run(["composio", "tools", "list", toolkit, "--limit", "1000"], opts);
    if (r.spawnError !== undefined) return result("skipped", "composio_missing", CHAIN_WORDS.composioMissing);
    if (r.timedOut) return result("failed", "timeout", CHAIN_WORDS.composioNoAnswer, {}, d.now() - t0);
    let tools = r.code === 0 ? parseToolsList(r.stdout) : [];
    if (tools.length === 0 && !t.catalog) {
      const s = await run.run(["composio", "search", t.name, "--limit", "5"], opts);
      const found = s.code === 0 ? parseSearchToolkits(s.stdout).find((k) => toolkitMatches(k, t)) : undefined;
      if (found !== undefined) {
        toolkit = found;
        r = await run.run(["composio", "tools", "list", toolkit, "--limit", "1000"], opts);
        tools = r.code === 0 ? parseToolsList(r.stdout) : [];
      }
    }
    if (tools.length === 0) return result("skipped", "no_toolkit", CHAIN_WORDS.composioNoApp(t.name), {}, d.now() - t0);
    // 2. account
    const c = await run.run(["composio", "connections", "list", "--toolkit", toolkit], opts);
    if (failedRun(c)) return result("failed", c.timedOut ? "timeout" : "error", c.timedOut ? CHAIN_WORDS.composioNoAnswer : CHAIN_WORDS.broken, {}, d.now() - t0, { toolkit });
    const account = pickAccount(parseConnections(c.stdout, toolkit));
    if (account === null) return result("skipped", "not_signed_in", CHAIN_WORDS.composioNotSigned(t.name), {}, d.now() - t0, { toolkit });
    // 3. capabilities: allowlisted tools the toolkit really has; meta tools never.
    const reads: string[] = [];
    const writes: string[] = [];
    const map: Record<string, string> = {};
    const writeTools = new Set<string>();
    for (const tool of tools) {
      if (COMPOSIO_META_RE.test(tool.slug)) continue;
      const cap = capabilityOf(t.id, tool.slug);
      if (cap === null) continue;
      if (cap.role === "read") reads.push(cap.capability);
      else {
        writeTools.add(tool.slug);
        if (!account.askEveryCall) writes.push(cap.capability);
      }
      if (cap.role === "read" || !account.askEveryCall) map[cap.capability] = `mcp__${COMPOSIO_CLI_SERVER}__${tool.slug}`;
    }
    const info = { toolkit, account: account.wordId };
    if (reads.length + writes.length === 0) {
      return account.askEveryCall && writeTools.size > 0 ? result("failed", "asks_every_call", CHAIN_WORDS.composioAsks, {}, d.now() - t0, info) : result("skipped", "no_allowlisted_tools", CHAIN_WORDS.noUsable, {}, d.now() - t0, info);
    }
    return result("ok", account.askEveryCall && writeTools.size > 0 ? "reads_only" : "ok", account.askEveryCall && writeTools.size > 0 ? CHAIN_WORDS.composioAsks : null, { reads: [...new Set(reads)], writes: [...new Set(writes)], tools: map }, d.now() - t0, info);
  }
}

// ---------- executor ----------

/** The composio policy for a declared action through a connector, or null. */
export function composioPolicy(connector: string, role: "send" | "log"): ToolPolicy | null {
  return TOOL_POLICIES.find((p) => p.flavor === "composio" && p.connector === connector && p.role === role) ?? null;
}

export class MethodFailed extends Error {}

export interface ComposioExecOptions {
  runner: LinkRunner;
  env: Env;
  /** Catalog id -> Composio account word id (from the probe). A connector without one is not run here. */
  accounts: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** Deterministic sends (and CRM logs) through `composio execute`, every call through the gate first. */
export class ComposioCliExecutor implements Executor {
  constructor(private readonly o: ComposioExecOptions) {}

  async execute(job: ExecJob): Promise<ExecResult> {
    const env = linkEnv(this.o.env);
    // Preflight before any item is used: a missing CLI fails the method with nothing consumed.
    const v = await this.o.runner.run(["composio", "--version"], { timeoutMs: 10_000, env });
    if (failedRun(v)) throw new MethodFailed(v.spawnError !== undefined ? "the Composio command is not installed" : "Composio did not answer");
    const toolCalls: ToolCallRecord[] = [];
    const actions = job.actions ?? [{ role: "send" as const, connector: "gmail" }];
    // The send must be possible here before any item is used (otherwise the chain moves on with nothing consumed).
    for (const a of actions.filter((x) => x.role === "send"))
      if (composioPolicy(a.connector, "send") === null || this.o.accounts[a.connector] === undefined) throw new MethodFailed(`Composio has no usable send for ${a.connector}`);
    for (const item of job.batch.items) {
      if (job.only !== undefined && !job.only.has(item.key)) continue;
      if (job.signal?.aborted === true) break;
      for (const a of [...actions].sort((x, y) => (x.role === y.role ? 0 : x.role === "send" ? -1 : 1))) {
        const p = composioPolicy(a.connector, a.role);
        const account = this.o.accounts[a.connector];
        if (p === null || account === undefined) continue;
        const args = p.expected?.(item, { batchHash: job.batch.hash, ...(job.crmSheet === undefined ? {} : { crmSheet: job.crmSheet }) }) ?? null;
        if (args === null) continue;
        const tool = `mcp__${COMPOSIO_CLI_SERVER}__${p.tool}`;
        const { result: perm, decision } = job.gate.check(tool, args);
        const rec: ToolCallRecord = { tool, input: args, allowed: perm.behavior === "allow", ok: false, ...(decision.itemKey === undefined ? {} : { itemKey: decision.itemKey }), ...(decision.role === undefined ? {} : { role: decision.role }) };
        toolCalls.push(rec);
        if (!rec.allowed) {
          if (a.role === "send") break; // no log without its send
          continue;
        }
        const r = await this.o.runner.run(["composio", "execute", p.tool, "-d", JSON.stringify(args), "--account", account], { timeoutMs: this.o.timeoutMs ?? COMPOSIO_EXECUTE_TIMEOUT_MS, env });
        const out = parseJsonOut(r.stdout) as { successful?: unknown; error?: unknown } | null;
        rec.ok = !failedRun(r) && out?.successful === true;
        if (!rec.ok) rec.error = r.timedOut ? "Composio did not answer in time" : `composio execute ${p.tool} did not succeed`;
        job.onToolResult?.(rec);
        if (!rec.ok) throw new MethodFailed(rec.error ?? "composio execute failed");
      }
    }
    return { toolCalls, text: `${toolCalls.filter((c) => c.ok).length} of ${toolCalls.length} Composio calls done` };
  }
}
