// s13: run one approved batch through the connector chain. ONE gate and ONE item journal for every method: the runner
// creates the gate (runner.ts executeBatch) with the union of every method's servers and policies, and the item states
// are written before each call. Methods run in chain order. When a method throws, or one of its allowed calls fails,
// it is marked failed in the chain and the next method gets ONLY the items still `pending` (never attempted).
// `sending` and `unknown` items are never handed on (unknown is never retried automatically); `sent` never again.
// A method that ends normally with items left (the gate denied them, the model skipped them) does not fall back:
// a refusal is policy, not a health problem.
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { ApiExecutor, apiPolicies, apiServer } from "../connectors/api.ts";
import { ChainResolver, knownTarget, type MethodState } from "../connectors/chain.ts";
import { COMPOSIO_CLI_SERVER, ComposioCliExecutor } from "../connectors/composio.ts";
import { computerPolicies, ComputerUseExecutor } from "../connectors/computer/executor.ts";
import type { Planner } from "../connectors/computer/claude.ts";
import type { ComputerDriver } from "../connectors/computer/driver.ts";
import { computerServer } from "../connectors/computer/probe.ts";
import type { ComputerSessions } from "../connectors/computer/session.ts";
import { missingEnv, toMcpServers, type ConnectorsConfig, type Env } from "../connectors/config.ts";
import type { Method } from "../connectors/link.ts";
import type { ChainTarget } from "../connectors/targets.ts";
import type { ToolPolicy } from "./allowlist.ts";
import type { BatchItem } from "./batch.ts";
import { genericPolicy, parseGenericCommit } from "./generic.ts";
import { fetchSchema, readUniverse } from "../connectors/universe.ts";
import type { ExecJob, ExecResult, Executor, ToolCallRecord } from "./executor.ts";
import type { GateAction } from "./gate.ts";

export interface ChainStep {
  method: Method;
  executor: Executor;
  /** The Agent SDK servers this step may use (mcp only). */
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ChainAttempt {
  method: Method;
  items: string[];
  error: string | null;
}

export class ChainExecutor implements Executor {
  readonly attempts: ChainAttempt[] = [];

  constructor(
    readonly steps: readonly ChainStep[],
    private readonly o: { onMethodFailed?: (method: Method, err: unknown) => void; log?: (line: string) => void } = {},
  ) {}

  async execute(job: ExecJob): Promise<ExecResult> {
    const toolCalls: ToolCallRecord[] = [];
    const stateOf = (k: string) => job.batch.itemStates?.[k]?.state ?? "pending";
    let lastErr: unknown = null;
    for (const step of this.steps) {
      if (job.signal?.aborted === true) break;
      const pending = new Set(job.batch.items.map((i) => i.key).filter((k) => stateOf(k) === "pending" && (job.only === undefined || job.only.has(k))));
      if (pending.size === 0) break;
      let failedCall: string | null = null;
      let threw: unknown = null;
      const sub: ExecJob = {
        ...job,
        only: pending,
        ...(step.mcpServers === undefined ? {} : { mcpServers: step.mcpServers }),
        onToolResult: (r) => {
          if (r.allowed && !r.ok) failedCall ??= r.error ?? "a call failed";
          job.onToolResult?.(r);
        },
      };
      try {
        const r = await step.executor.execute(sub);
        toolCalls.push(...r.toolCalls);
      } catch (err) {
        threw = err;
      }
      const error = threw !== null ? (threw instanceof Error ? threw.message : String(threw)) : failedCall;
      this.attempts.push({ method: step.method, items: [...pending], error });
      if (error === null) {
        lastErr = null;
        break;
      }
      lastErr = threw ?? new Error(error);
      this.o.log?.(`brain: chain: ${step.method} failed for ${pending.size} item(s); trying the next way for the items never attempted`);
      this.o.onMethodFailed?.(step.method, lastErr);
    }
    if (lastErr !== null) throw lastErr;
    return { toolCalls, text: this.attempts.map((a) => `${a.method}: ${a.error ?? "done"}`).join("; ") };
  }
}

export interface BuildChainOptions {
  home: string;
  env: Env;
  resolver: ChainResolver;
  config: ConnectorsConfig | null;
  actions: readonly GateAction[];
  /** The executor for the mcp method (the Agent SDK executor in production). */
  mcpExecutor: Executor;
  /** Replace a method's executor (tests). */
  executors?: Partial<Record<Method, Executor>>;
  computer?: { driver: ComputerDriver; planner: Planner; sessions: ComputerSessions };
  log?: (line: string) => void;
  /** s17: the batch's items. Items approved field by field (workflows/generic.ts) get one generic policy per tool,
   * built from the tool's schema fetched fresh now (none when it cannot be fetched: the gate then denies). */
  batchItems?: readonly BatchItem[];
}

/** s17: generic policies for the target's items: schema fetched fresh (maxAge 0), only tools of the target's toolkit. */
export async function genericPoliciesFor(o: Pick<BuildChainOptions, "home" | "env" | "resolver" | "log">, target: ChainTarget, items: readonly BatchItem[]): Promise<ToolPolicy[]> {
  const idx = readUniverse(o.home);
  const slugs = [...new Set(items.map((i) => parseGenericCommit(i)?.slug).filter((x): x is string => x !== undefined))];
  const out: ToolPolicy[] = [];
  for (const slug of slugs) {
    if (idx?.tools[slug]?.toolkit !== target.toolkit || idx.tools[slug]!.class !== "commit") continue;
    const rec = await fetchSchema({ home: o.home, runner: o.resolver.deps.runner, env: o.env, now: o.resolver.deps.now, slug, maxAgeMs: 0 });
    if (rec === null) {
      o.log?.(`brain: chain: the fields of ${slug} could not be checked now, so its items are not sent`);
      continue;
    }
    out.push(genericPolicy(rec, target.id));
  }
  return out;
}

export interface ChainBuild {
  executor: ChainExecutor;
  methods: Method[];
  servers: Record<string, string[]>;
  policies: ToolPolicy[];
  mcpServers: Record<string, McpServerConfig>;
}

const stateFor = (states: readonly MethodState[], m: Method) => states.find((s) => s.method === m);

/**
 * The chain for a workflow's side-effect steps: the healthy methods, in order, that can do its send, each with the
 * servers (and gate policies) it covers; the log connector rides along on a method when that method is healthy for it.
 * null when the workflow declares no send.
 */
export async function buildChain(o: BuildChainOptions): Promise<ChainBuild | null> {
  const send = o.actions.find((a) => a.role === "send");
  if (send === undefined) return null;
  const now = o.resolver.deps.now();
  const target = knownTarget(o.home, send.connector, now);
  if (target === null) return null;
  const plan = await o.resolver.plan(target, target.sends);
  const logIds = [...new Set(o.actions.filter((a) => a.role === "log").map((a) => a.connector))];
  const logTargets = logIds.map((id) => knownTarget(o.home, id, now)).filter((t): t is ChainTarget => t !== null);
  const logStates = new Map<string, MethodState[]>();
  for (const t of logTargets) logStates.set(t.id, (await o.resolver.resolve(t)).methods);
  const okFor = (m: Method) => logTargets.filter((t) => stateFor(logStates.get(t.id) ?? [], m)?.health === "ok").map((t) => t.id);

  const steps: ChainStep[] = [];
  const servers: Record<string, string[]> = {};
  const policies: ToolPolicy[] = [];
  let mcpServers: Record<string, McpServerConfig> = {};
  for (const st of plan) {
    const ids = [target.id, ...okFor(st.method)];
    if (st.method === "mcp") {
      if (o.config === null) continue;
      const names = Object.entries(o.config.servers).filter(([, s]) => s.catalog.some((c) => ids.includes(c)) && missingEnv(s, o.env).length === 0).map(([n]) => n);
      try {
        mcpServers = toMcpServers({ ...o.config, servers: Object.fromEntries(names.map((n) => [n, o.config!.servers[n]!])) }, o.env);
      } catch (err) {
        o.log?.(`brain: chain: mcp servers not usable: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const n of names) servers[n] = [...o.config.servers[n]!.catalog];
      steps.push({ method: "mcp", executor: o.executors?.mcp ?? o.mcpExecutor, mcpServers });
    } else if (st.method === "composio") {
      const accounts: Record<string, string> = {};
      for (const id of ids) {
        const s = id === target.id ? st : stateFor(logStates.get(id) ?? [], "composio");
        if (s?.info?.account !== undefined) accounts[id] = s.info.account;
      }
      servers[COMPOSIO_CLI_SERVER] = [...ids];
      const generic = o.batchItems === undefined ? [] : await genericPoliciesFor(o, target, o.batchItems);
      policies.push(...generic);
      steps.push({ method: "composio", executor: o.executors?.composio ?? new ComposioCliExecutor({ runner: o.resolver.deps.runner, env: o.env, accounts, ...(generic.length === 0 ? {} : { generic }) }) });
    } else if (st.method === "api") {
      if (o.config === null && o.executors?.api === undefined) continue;
      for (const id of ids) servers[apiServer(id)] = [id];
      policies.push(...apiPolicies(o.config?.apis).filter((p) => ids.includes(p.connector)));
      steps.push({ method: "api", executor: o.executors?.api ?? new ApiExecutor({ fetch: o.resolver.deps.fetch, secrets: o.resolver.deps.secrets, config: o.config! }) });
    } else if (st.method === "computer") {
      const exec = o.executors?.computer ?? (o.computer === undefined ? undefined : new ComputerUseExecutor({ ...o.computer, target: (id) => knownTarget(o.home, id, now) }));
      if (exec === undefined) continue;
      servers[computerServer(target.id)] = [target.id];
      policies.push(...computerPolicies([target.id]));
      steps.push({ method: "computer", executor: exec });
    }
  }
  const executor = new ChainExecutor(steps, {
    onMethodFailed: (m, err) => o.resolver.markFailed(target.id, m, err),
    ...(o.log === undefined ? {} : { log: o.log }),
  });
  return { executor, methods: steps.map((s) => s.method), servers, policies, mcpServers };
}
