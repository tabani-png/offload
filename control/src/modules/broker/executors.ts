/**
 * Deterministic commit executors, one per connection method (ADR 0105 §3, as s13 `chain-executor`): no model is in
 * the loop. `build` turns an approved Stage 1 item into the one tool call its policy expects (brain `expectedArgs`);
 * the broker then checks that call against the approved item's full-argument hash before `call` runs it. The
 * transports (`ComposioRunner`, `McpClient`, `ApiTransport`) are injected: tests use fakes, and no real transport is
 * created by this module, so nothing external can be called by accident.
 */
import { expectedArgs, type BatchItem, type CrmSheet, type Method, type ToolPolicy } from "./stage1.ts";

export interface CommitCall {
  tool: string;
  args: Record<string, unknown>;
}

/** The connection a call goes out through (a reference only; the credential lives with the provider). */
export interface CommitTarget {
  connectionId: string;
  kind: string;
  externalRef: string;
}

export interface CallResult {
  /** True only on a confirmed success. false, a throw or no answer after the call started means `unknown`. */
  ok: boolean;
  error?: string;
}

export interface Executor {
  readonly method: Method;
  build(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): CommitCall | null;
  call(call: CommitCall, target: CommitTarget): Promise<CallResult>;
}

/** The one call the policy expects for the item: exactly the approved arguments. */
export function approvedCall(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): CommitCall | null {
  const args = expectedArgs(p, item, ctx);
  return args === null ? null : { tool: p.tool, args };
}

// ---------- Composio CLI ----------

export interface RunResult {
  code: number | null;
  stdout: string;
  timedOut?: boolean;
}

export interface ComposioRunner {
  run(argv: string[], opts: { timeoutMs: number }): Promise<RunResult>;
}

export const COMPOSIO_EXECUTE_TIMEOUT_MS = 60_000;

/** `composio execute <SLUG> -d <json> --account <ref>` (the s13 command line). */
export class ComposioCliExecutor implements Executor {
  readonly method = "composio" as const;
  constructor(private readonly runner: ComposioRunner, private readonly timeoutMs = COMPOSIO_EXECUTE_TIMEOUT_MS) {}

  build(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): CommitCall | null {
    return approvedCall(p, item, ctx);
  }

  async call(call: CommitCall, target: CommitTarget): Promise<CallResult> {
    const r = await this.runner.run(["composio", "execute", call.tool, "-d", JSON.stringify(call.args), "--account", target.externalRef], { timeoutMs: this.timeoutMs });
    if (r.timedOut === true) return { ok: false, error: "Composio did not answer in time" };
    let out: { successful?: unknown } | null = null;
    try {
      out = JSON.parse(r.stdout) as { successful?: unknown };
    } catch {
      out = null;
    }
    return r.code === 0 && out?.successful === true ? { ok: true } : { ok: false, error: `composio execute ${call.tool} did not succeed` };
  }
}

// ---------- company MCP ----------

export interface McpClient {
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<{ isError?: boolean }>;
}

export class McpExecutor implements Executor {
  readonly method = "mcp" as const;
  constructor(private readonly client: McpClient) {}

  build(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): CommitCall | null {
    return approvedCall(p, item, ctx);
  }

  async call(call: CommitCall, target: CommitTarget): Promise<CallResult> {
    const r = await this.client.callTool(target.externalRef, call.tool, call.args);
    return r.isError === true ? { ok: false, error: `${call.tool} returned an error` } : { ok: true };
  }
}

// ---------- direct API ----------

export interface ApiTransport {
  send(req: { connectionRef: string; operation: string; body: Record<string, unknown> }): Promise<{ status: number }>;
}

export class ApiExecutor implements Executor {
  readonly method = "api" as const;
  constructor(private readonly transport: ApiTransport) {}

  build(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): CommitCall | null {
    return approvedCall(p, item, ctx);
  }

  async call(call: CommitCall, target: CommitTarget): Promise<CallResult> {
    const r = await this.transport.send({ connectionRef: target.externalRef, operation: call.tool, body: call.args });
    return r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, error: `${call.tool} answered ${r.status}` };
  }
}
