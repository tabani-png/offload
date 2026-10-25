// Executors run the side-effect steps of an approved batch. Both go through the same gate:
//   AgentSdkExecutor - Claude Agent SDK with the user's MCP servers, built-in tools off, no setting sources, strict MCP
//                      config, an allowlisted environment, gate as canUseTool AND as a PreToolUse hook.
//   ScriptedExecutor - a fake tool set for tests and offline demos; calls the gate exactly like the SDK does
//                      (PreToolUse hook first, then canUseTool, then the tool only when allowed).
// Each executor reports every allowed call's result through `onToolResult` as soon as it is known, so the runner can
// record it durably before the next call.
import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "./allowlist.ts";
import type { Batch } from "./batch.ts";
import type { CrmSheet } from "./allowlist.ts";
import type { Gate, GateAction } from "./gate.ts";
import { UNTRUSTED_RULE, untrustedBlock } from "./untrusted.ts";

export interface ExecJob {
  batch: Batch;
  gate: Gate;
  /** SKILL.md text. Kept for callers and display only: it never enters the send step's system prompt (REVIEW-1 M5). */
  skill?: string;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  cwd?: string;
  /** Aborted when the user pauses or deletes the workflow. */
  signal?: AbortSignal;
  /** Called once per allowed call when its result is known. */
  onToolResult?: (rec: ToolCallRecord) => void;
  /** s13: only these item keys (the connector chain's fallback hands over the never-attempted items). The gate still
   * checks every call against the whole approved batch. Absent = every item. */
  only?: ReadonlySet<string>;
  /** s13: the side-effect actions the workflow declares (deterministic executors build their calls from them). */
  actions?: readonly GateAction[];
  /** s13: where the CRM log may append (workflow.json inputs.crmSheet). */
  crmSheet?: CrmSheet;
}

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  allowed: boolean;
  ok: boolean;
  itemKey?: string;
  role?: Role;
  error?: string;
}

export interface ExecResult {
  toolCalls: ToolCallRecord[];
  text: string;
}

export interface Executor {
  execute(job: ExecJob): Promise<ExecResult>;
}

export type FakeTool = (input: Record<string, unknown>) => Promise<unknown>;
export type Script = (job: ExecJob) => Array<{ tool: string; input: Record<string, unknown> }>;

/** Default script: one send per batch item with exactly the approved text. */
export const sendEachItem =
  (tool: string): Script =>
  (job) =>
    job.batch.items.filter((i) => job.only === undefined || job.only.has(i.key)).map((i) => ({ tool, input: { to: i.to, subject: i.subject, body: i.body } }));

export class ScriptedExecutor implements Executor {
  constructor(
    private readonly tools: Record<string, FakeTool>,
    private readonly script: Script,
  ) {}

  async execute(job: ExecJob): Promise<ExecResult> {
    const toolCalls: ToolCallRecord[] = [];
    const signal = job.signal ?? new AbortController().signal;
    let n = 0;
    for (const call of this.script(job)) {
      n += 1;
      const id = `fake_${n}`;
      const hook = await job.gate.preToolUse({ session_id: "fake", transcript_path: "", cwd: "", hook_event_name: "PreToolUse", tool_name: call.tool, tool_input: call.input, tool_use_id: id }, id, { signal });
      const hookDenied = JSON.stringify(hook).includes('"permissionDecision":"deny"');
      const checked = hookDenied ? null : job.gate.check(call.tool, call.input);
      const allowed = checked?.result.behavior === "allow";
      const rec: ToolCallRecord = { tool: call.tool, input: call.input, allowed, ok: false };
      if (checked?.decision.itemKey !== undefined) rec.itemKey = checked.decision.itemKey;
      if (checked?.decision.role !== undefined) rec.role = checked.decision.role;
      if (allowed) {
        const impl = this.tools[call.tool];
        try {
          if (impl === undefined) throw new Error(`no such tool ${call.tool}`);
          await impl(call.input);
          rec.ok = true;
        } catch (err) {
          rec.error = err instanceof Error ? err.message : String(err);
        }
        job.onToolResult?.(rec);
      }
      toolCalls.push(rec);
    }
    return { toolCalls, text: `${toolCalls.filter((c) => c.ok).length} of ${toolCalls.length} tool calls done` };
  }
}

/** Fixed system-prompt text for the send step. No SKILL.md, no workflow name, nothing observed. */
export const SEND_SYSTEM_APPEND = [
  "You move approved emails into tool calls for the user. An approval gate in code checks every call; a changed call is denied.",
  UNTRUSTED_RULE,
].join("\n");

/** Prompt for the send step. The model only moves approved text into tool calls; the gate checks every call. */
export function sendPrompt(batch: Batch, only?: ReadonlySet<string>): string {
  const items = batch.items.filter((i) => only === undefined || only.has(i.key));
  return [
    "Send each approved email in the approved_batch block with the connected Gmail send tool, one tool call per email.",
    "Use the recipient, subject and body exactly as given: do not change, add or drop any text, and add no other recipients or fields.",
    "If a call is denied, do not retry it with different input; go on to the next email. When done, reply with one line per email: the address and sent or failed.",
    "",
    untrustedBlock("approved_batch", JSON.stringify(items.map((i) => ({ to: i.to, subject: i.subject, body: i.body })), null, 2)),
  ].join("\n");
}

/** Variables the Claude Code child needs to run and authenticate. Never OFFLOAD_TOKEN or connector secrets (REVIEW-1 L5). */
const ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

export function executorEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = env[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/** The exact query() arguments the SDK executor uses (exported so tests can pin them without a network call). */
export function sdkQueryOptions(job: ExecJob, env: Readonly<Record<string, string | undefined>> = process.env): { prompt: string; options: Options } {
  const abort = new AbortController();
  if (job.signal !== undefined) {
    if (job.signal.aborted) abort.abort(job.signal.reason);
    else job.signal.addEventListener("abort", () => abort.abort(job.signal?.reason), { once: true });
  }
  return {
    prompt: sendPrompt(job.batch, job.only),
    options: {
      ...(job.model === undefined ? {} : { model: job.model }),
      systemPrompt: { type: "preset", preset: "claude_code", append: SEND_SYSTEM_APPEND },
      tools: [],
      allowedTools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: job.mcpServers ?? {},
      permissionMode: "default",
      maxTurns: job.batch.items.length * 2 + 4,
      env: executorEnv(env),
      abortController: abort,
      ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
    },
  };
}

export class AgentSdkExecutor implements Executor {
  async execute(job: ExecJob): Promise<ExecResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const toolCalls: ToolCallRecord[] = [];
    const byId = new Map<string, ToolCallRecord>();
    const base = sdkQueryOptions(job);
    const q = query({
      prompt: base.prompt,
      options: {
        ...base.options,
        canUseTool: async (toolName, input, opts) => {
          const { result, decision } = job.gate.check(toolName, input);
          const rec: ToolCallRecord = { tool: toolName, input, allowed: result.behavior === "allow", ok: false };
          if (decision.itemKey !== undefined) rec.itemKey = decision.itemKey;
          if (decision.role !== undefined) rec.role = decision.role;
          toolCalls.push(rec);
          if (opts.toolUseID !== undefined) byId.set(opts.toolUseID, rec);
          return result;
        },
        hooks: {
          PreToolUse: [{ hooks: [job.gate.preToolUse] }],
          PostToolUse: [
            {
              hooks: [
                async (input, toolUseId) => {
                  const rec = toolUseId === undefined ? undefined : byId.get(toolUseId);
                  if (rec !== undefined && rec.allowed && input.hook_event_name === "PostToolUse") {
                    rec.ok = true;
                    job.onToolResult?.(rec);
                  }
                  return {};
                },
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (input, toolUseId) => {
                  const rec = toolUseId === undefined ? undefined : byId.get(toolUseId);
                  if (rec !== undefined && rec.allowed && input.hook_event_name === "PostToolUseFailure") {
                    rec.error = String(input.error);
                    job.onToolResult?.(rec);
                  }
                  return {};
                },
              ],
            },
          ],
        },
      },
    });
    let text = "";
    for await (const m of q) {
      if (m.type === "result") text = m.subtype === "success" ? m.result : `run ended: ${m.subtype}`;
    }
    return { toolCalls, text };
  }
}
