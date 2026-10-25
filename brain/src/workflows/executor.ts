// Executors run the side-effect steps of an approved batch. Both go through the same gate:
//   AgentSdkExecutor - Claude Agent SDK with the user's MCP servers, built-in tools off, no setting sources,
//                      gate as canUseTool AND as a PreToolUse hook.
//   ScriptedExecutor - a fake tool set for tests and offline demos; calls the gate exactly like the SDK does
//                      (PreToolUse hook first, then canUseTool, then the tool only when allowed).
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Batch } from "./batch.ts";
import type { Gate } from "./gate.ts";

export interface ExecJob {
  batch: Batch;
  gate: Gate;
  /** SKILL.md text, appended to the system prompt. */
  skill?: string;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  cwd?: string;
}

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  allowed: boolean;
  ok: boolean;
  itemKey?: string;
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
    job.batch.items.map((i) => ({ tool, input: { to: i.to, subject: i.subject, body: i.body } }));

export class ScriptedExecutor implements Executor {
  constructor(
    private readonly tools: Record<string, FakeTool>,
    private readonly script: Script,
  ) {}

  async execute(job: ExecJob): Promise<ExecResult> {
    const toolCalls: ToolCallRecord[] = [];
    const signal = new AbortController().signal;
    let n = 0;
    for (const call of this.script(job)) {
      n += 1;
      const id = `fake_${n}`;
      const hook = await job.gate.preToolUse({ session_id: "fake", transcript_path: "", cwd: "", hook_event_name: "PreToolUse", tool_name: call.tool, tool_input: call.input, tool_use_id: id }, id, { signal });
      const hookDenied = JSON.stringify(hook).includes('"permissionDecision":"deny"');
      const perm = hookDenied ? null : await job.gate.canUseTool(call.tool, call.input, { signal });
      const allowed = perm?.behavior === "allow";
      const rec: ToolCallRecord = { tool: call.tool, input: call.input, allowed, ok: false };
      const key = allowed ? job.gate.decide(call.tool, call.input, false).itemKey : undefined;
      if (allowed) {
        const impl = this.tools[call.tool];
        try {
          if (impl === undefined) throw new Error(`no such tool ${call.tool}`);
          await impl(call.input);
          rec.ok = true;
        } catch (err) {
          rec.error = err instanceof Error ? err.message : String(err);
        }
      }
      if (key !== undefined) rec.itemKey = key;
      toolCalls.push(rec);
    }
    return { toolCalls, text: `${toolCalls.filter((c) => c.ok).length} of ${toolCalls.length} tool calls done` };
  }
}

/** Prompt for the send step. The model only moves approved text into tool calls; the gate checks every call. */
export function sendPrompt(batch: Batch): string {
  return [
    "Send each approved email below with the connected Gmail send tool, one tool call per email.",
    "Use the recipient, subject and body exactly as given: do not change, add or drop any text, and add no other recipients.",
    "If a call is denied, do not retry it with different input; go on to the next email. When done, reply with one line per email: the address and sent or failed.",
    "",
    "<approved_batch>",
    JSON.stringify(batch.items.map((i) => ({ to: i.to, subject: i.subject, body: i.body })), null, 2),
    "</approved_batch>",
  ].join("\n");
}

export class AgentSdkExecutor implements Executor {
  async execute(job: ExecJob): Promise<ExecResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const toolCalls: ToolCallRecord[] = [];
    const byId = new Map<string, ToolCallRecord>();
    const q = query({
      prompt: sendPrompt(job.batch),
      options: {
        ...(job.model === undefined ? {} : { model: job.model }),
        systemPrompt: { type: "preset", preset: "claude_code", append: job.skill ?? "" },
        tools: [],
        allowedTools: [],
        settingSources: [],
        mcpServers: job.mcpServers ?? {},
        permissionMode: "default",
        maxTurns: job.batch.items.length * 2 + 4,
        ...(job.cwd === undefined ? {} : { cwd: job.cwd }),
        canUseTool: async (toolName, input, opts) => {
          const r = await job.gate.canUseTool(toolName, input, opts);
          const rec: ToolCallRecord = { tool: toolName, input, allowed: r.behavior === "allow", ok: false };
          const key = job.gate.decide(toolName, input, false).itemKey;
          if (key !== undefined) rec.itemKey = key;
          toolCalls.push(rec);
          if (opts.toolUseID !== undefined) byId.set(opts.toolUseID, rec);
          return r;
        },
        hooks: {
          PreToolUse: [{ hooks: [job.gate.preToolUse] }],
          PostToolUse: [
            {
              hooks: [
                async (input, toolUseId) => {
                  const rec = toolUseId === undefined ? undefined : byId.get(toolUseId);
                  if (rec !== undefined && input.hook_event_name === "PostToolUse") rec.ok = true;
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
                  if (rec !== undefined && input.hook_event_name === "PostToolUseFailure") rec.error = String(input.error);
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
