// The approval gate (ADR 0006), enforced in code. The runner passes `canUseTool` and `preToolUse` to the Agent SDK;
// the same functions run in tests with a fake tool set. Rules, in order:
//   built-in tool (no mcp__ prefix)          -> deny (workflow runs get MCP tools only)
//   read tool (read verb, no write verb)      -> allow
//   side effect in a dry run                  -> deny
//   side effect for a dry-run batch           -> deny
//   no approval token for this exact batch hash (and auto-run off) -> deny
//   input does not match exactly one batch item (recipients and body) -> deny
//   that item already done by this tool class -> deny
//   otherwise                                 -> allow, and mark the item done
// Every decision is logged (callback and, when given, workflows/<id>/gate-log.jsonl).
import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/** Compile-time proof that the gate plugs into the SDK as is. */
export type _GateFitsSdk = GateCanUseTool extends CanUseTool ? true : never;
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { shortHash, type Batch, type BatchItem } from "./batch.ts";

export type ToolClass = "read" | "side_effect" | "builtin";

const READ_VERBS = new Set("get list search read fetch find query lookup view describe count check retrieve show".split(" "));
const WRITE_VERBS = new Set(
  "send create update delete insert append write post reply forward trash modify patch move label add remove draft batch upload share set archive mark schedule invite put upsert import execute run cancel accept decline respond copy rename clear".split(" "),
);

export function splitMcpName(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  return { server: parts[1]!, tool: parts.slice(2).join("__") };
}

export function classifyTool(name: string): ToolClass {
  const mcp = splitMcpName(name);
  if (mcp === null) return "builtin";
  const words = mcp.tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  const read = words.some((w) => READ_VERBS.has(w));
  const write = words.some((w) => WRITE_VERBS.has(w));
  return read && !write ? "read" : "side_effect";
}

const SEND_CLASS_RE = /send|reply|forward/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function stringLeaves(x: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) stringLeaves(v, out, depth + 1);
  else if (typeof x === "object" && x !== null) for (const v of Object.values(x)) stringLeaves(v, out, depth + 1);
  return out;
}

const norm = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The one batch item this tool input is for, or the reason it is none. */
export function matchItem(toolName: string, input: Record<string, unknown>, items: readonly BatchItem[]): { item: BatchItem } | { reason: string } {
  const leaves = stringLeaves(input);
  const emails = new Set(leaves.flatMap((l) => l.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()));
  const named = items.filter((i) => emails.has(i.key));
  if (named.length === 0) return { reason: "input names no recipient of the approved batch" };
  if (named.length > 1) return { reason: `input names ${named.length} batch recipients; one call per item` };
  const item = named[0]!;
  if (SEND_CLASS_RE.test(toolName)) {
    const strangers = [...emails].filter((e) => e !== item.key);
    if (strangers.length > 0) return { reason: `input adds recipients that were not approved: ${strangers.join(", ")}` };
    const body = norm(item.body);
    if (!leaves.some((l) => norm(l) === body)) return { reason: "message body differs from the approved draft" };
  }
  return { item };
}

export interface ApprovalRecord {
  token: string;
  approvedAt: number;
}

export interface GateDecisionLog {
  at: number;
  workflowId: string;
  batchHash: string;
  mode: "dry_run" | "live";
  tool: string;
  toolClass: ToolClass;
  decision: "allow" | "deny";
  reason: string;
  itemKey?: string;
}

export interface GateContext {
  workflowId: string;
  mode: "dry_run" | "live";
  batch: Batch;
  /** Per-workflow flag, off by default: lets a live run act on its own batch without a token. */
  autoRun: boolean;
  /** The approval token this run holds, null when none. */
  runToken: string | null;
  /** Stored approvals by batch hash. */
  approvals: (hash: string) => ApprovalRecord | undefined;
  log?: (d: GateDecisionLog) => void;
  /** Append decisions here (jsonl). */
  logPath?: string;
  now?: () => number;
}

export interface Decision {
  allow: boolean;
  reason: string;
  toolClass: ToolClass;
  itemKey?: string;
}

/** Assignable to the Agent SDK's CanUseTool (it never returns null and needs no SDK-only options). */
export type GateCanUseTool = (toolName: string, input: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<PermissionResult>;

export interface Gate {
  canUseTool: GateCanUseTool;
  preToolUse: HookCallback;
  /** Pure decision; `consume` marks the item done when allowed. */
  decide(toolName: string, input: Record<string, unknown>, consume: boolean): Decision;
  /** Item keys done per tool class ("send" or "write"). */
  readonly done: ReadonlyMap<string, ReadonlySet<string>>;
}

const tokenEq = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function createGate(ctx: GateContext): Gate {
  const done = new Map<string, Set<string>>([
    ["send", new Set()],
    ["write", new Set()],
  ]);
  const now = ctx.now ?? Date.now;

  const record = (tool: string, d: Decision) => {
    const entry: GateDecisionLog = {
      at: now(),
      workflowId: ctx.workflowId,
      batchHash: ctx.batch.hash,
      mode: ctx.mode,
      tool,
      toolClass: d.toolClass,
      decision: d.allow ? "allow" : "deny",
      reason: d.reason,
      ...(d.itemKey === undefined ? {} : { itemKey: d.itemKey }),
    };
    ctx.log?.(entry);
    if (ctx.logPath !== undefined) appendFileSync(ctx.logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  };

  function decide(toolName: string, input: Record<string, unknown>, consume: boolean): Decision {
    const toolClass = classifyTool(toolName);
    const deny = (reason: string, itemKey?: string): Decision => ({ allow: false, reason, toolClass, ...(itemKey === undefined ? {} : { itemKey }) });
    if (toolClass === "builtin") return deny("built-in tools are disabled in workflow runs");
    if (toolClass === "read") return { allow: true, reason: "read-only tool", toolClass };
    if (ctx.mode === "dry_run") return deny("dry run: side effects are disabled");
    if (ctx.batch.kind !== "live") return deny("dry-run batch: nothing in it can be sent");
    const approval = ctx.approvals(ctx.batch.hash);
    const approved = ctx.runToken !== null && approval !== undefined && tokenEq(approval.token, ctx.runToken);
    if (!approved && !ctx.autoRun) return deny(`no approval for batch ${shortHash(ctx.batch.hash)}`);
    const m = matchItem(toolName, input, ctx.batch.items);
    if ("reason" in m) return deny(m.reason);
    const cls = SEND_CLASS_RE.test(toolName) ? "send" : "write";
    const set = done.get(cls)!;
    if (set.has(m.item.key)) return deny(`already done for ${m.item.key} in this batch`, m.item.key);
    if (consume) set.add(m.item.key);
    return { allow: true, reason: approved ? `approved batch ${shortHash(ctx.batch.hash)}` : "auto-run is on for this workflow", toolClass, itemKey: m.item.key };
  }

  const canUseTool: GateCanUseTool = async (toolName, input) => {
    const d = decide(toolName, input, true);
    record(toolName, d);
    return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `Offload approval gate: ${d.reason}` };
  };

  // Defence in depth: the hook runs before any permission logic. It denies what the gate would deny and otherwise
  // leaves the decision to canUseTool (it never answers "allow", so settings cannot widen what the gate allows).
  const preToolUse: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const input = typeof hookInput.tool_input === "object" && hookInput.tool_input !== null ? (hookInput.tool_input as Record<string, unknown>) : {};
    const d = decide(hookInput.tool_name, input, false);
    if (d.allow) return {};
    record(hookInput.tool_name, d);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Offload approval gate: ${d.reason}` } };
  };

  return { canUseTool, preToolUse, decide, done };
}
