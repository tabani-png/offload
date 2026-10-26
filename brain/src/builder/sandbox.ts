// s24 builder sandbox: what the builder agent may touch. Borrowed from Cindy (EVAL.md): "bypass only inside a
// container" (assertSafeExecutionProfile) and the telemetry-off env for Claude Code subprocesses. Everything else is
// ours: a small tool set with no network tools, a Bash allowlist with no shell operators, every path inside the
// workspace, and the frozen check folder (accept/) read-only. On a user Mac the mode is "default" with this allowlist
// as canUseTool; bypassPermissions is refused unless the profile says it runs in a container sandbox.
import type { HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, relative, resolve } from "node:path";
import { executorEnv } from "../workflows/executor.ts";

/** Built-in tools the builder gets. No WebFetch, WebSearch, Task or MCP. */
export const BUILDER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;
/** Named explicitly so a CLI default can never bring them back. */
export const DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit", "TodoWrite", "KillShell", "BashOutput"] as const;
export const NETWORK_TOOLS = ["WebFetch", "WebSearch"] as const;
/** First word of an allowed Bash command (bun only as `bun test` / `bun run`). */
export const BASH_ALLOW = ["python3", "bun", "node", "ls", "mkdir", "mv", "cp", "cat", "head", "tail", "wc", "echo"] as const;
export const CHECK_DIR = "accept";

export type ExecutionMode = "allowlist" | "bypass";
export interface ExecutionProfile {
  mode: ExecutionMode;
  /** True only when the caller runs inside a throwaway container (OFFLOAD_BUILDER_SANDBOX=container). */
  containerSandbox: boolean;
}

export class UnsafeProfileError extends Error {}

/** Cindy's rule: bypassPermissions (no prompts, no canUseTool) only inside a container sandbox. */
export function assertSafeExecutionProfile(p: ExecutionProfile): void {
  if (p.mode === "bypass" && !p.containerSandbox) throw new UnsafeProfileError("bypass mode is refused outside a container sandbox; use the allowlist mode on this machine");
}

export function profileFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, mode: ExecutionMode = "allowlist"): ExecutionProfile {
  return { mode, containerSandbox: env.OFFLOAD_BUILDER_SANDBOX === "container" };
}

/** Env for the Claude Code subprocess and the check run: the executor's allowlist plus telemetry off. */
export function builderEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out = executorEnv(env);
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) if (env[k]) out[k] = env[k]!;
  return { ...out, DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

const SHELL_OPS = /[;&|`$<>(){}\\\n\r*?!~]/;

/** The path, resolved against the workspace, or null when it leaves the workspace. */
export function insideWorkspace(ws: string, p: string): string | null {
  const abs = resolve(ws, p);
  const rel = relative(ws, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? abs : null;
}

const inCheckDir = (ws: string, abs: string) => {
  const rel = relative(ws, abs);
  return rel === CHECK_DIR || rel.startsWith(`${CHECK_DIR}/`);
};

export interface ToolDecision {
  allow: boolean;
  reason: string;
}

export function decideBashCommand(ws: string, command: string): ToolDecision {
  const cmd = command.trim();
  if (cmd === "") return { allow: false, reason: "empty command" };
  if (SHELL_OPS.test(cmd)) return { allow: false, reason: "shell operators are not allowed; run one plain command" };
  const words = cmd.split(/\s+/);
  const head = words[0]!;
  if (!(BASH_ALLOW as readonly string[]).includes(head)) return { allow: false, reason: `${head} is not on the builder's command allowlist (${BASH_ALLOW.join(", ")})` };
  if (head === "bun" && words[1] !== "test" && words[1] !== "run") return { allow: false, reason: "only bun test and bun run are allowed" };
  if (head === "python3" && (words.includes("-m") || words.includes("-c"))) return { allow: false, reason: "python3 runs a file in the workspace, not -m or -c" };
  for (const w of words.slice(1)) {
    if (w.startsWith("-")) continue;
    const abs = insideWorkspace(ws, w);
    if (abs === null) return { allow: false, reason: `${w} is outside the workspace` };
    if ((head === "mv" || head === "cp" || head === "mkdir") && inCheckDir(ws, abs)) return { allow: false, reason: "the acceptance check is read-only" };
  }
  return { allow: true, reason: "allowlisted command" };
}

/** The allowlist for one tool call. Unknown tool = deny. */
export function decideTool(ws: string, tool: string, input: Record<string, unknown>): ToolDecision {
  if ((DISALLOWED_TOOLS as readonly string[]).includes(tool) || tool.startsWith("mcp__")) return { allow: false, reason: `${tool} is not available to the builder` };
  if (!(BUILDER_TOOLS as readonly string[]).includes(tool)) return { allow: false, reason: `${tool} is not on the builder's tool allowlist` };
  if (tool === "Bash") return typeof input.command === "string" ? decideBashCommand(ws, input.command) : { allow: false, reason: "no command" };
  if (tool === "Glob" && typeof input.pattern === "string" && (isAbsolute(input.pattern) || input.pattern.split("/").includes(".."))) return { allow: false, reason: "the pattern leaves the workspace" };
  const raw = input.file_path ?? input.path ?? ".";
  if (typeof raw !== "string") return { allow: false, reason: "bad path" };
  const abs = insideWorkspace(ws, raw);
  if (abs === null) return { allow: false, reason: `${raw} is outside the workspace` };
  if ((tool === "Write" || tool === "Edit") && inCheckDir(ws, abs)) return { allow: false, reason: "the acceptance check is read-only" };
  return { allow: true, reason: "inside the workspace" };
}

export interface BuilderPermissions {
  canUseTool: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** Runs in every mode, bypass included: the last line that keeps the check folder read-only. */
  preToolUse: HookCallback;
  denials: Array<{ tool: string; reason: string }>;
}

export function builderPermissions(ws: string): BuilderPermissions {
  const denials: BuilderPermissions["denials"] = [];
  const check = (tool: string, input: Record<string, unknown>) => {
    const d = decideTool(ws, tool, input);
    if (!d.allow) denials.push({ tool, reason: d.reason });
    return d;
  };
  return {
    denials,
    canUseTool: async (tool, input) => {
      const d = check(tool, input);
      return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
    },
    preToolUse: async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const d = check(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      return d.allow ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
    },
  };
}
