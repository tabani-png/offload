// The approval gate (ADR 0006, REVIEW-1 B1/H1/M1/M3/L2), enforced in code. The runner passes `canUseTool` and
// `preToolUse` to the Agent SDK; the same functions run in tests with a fake tool set. Rules, in order:
//   built-in tool (no mcp__ prefix)                        -> deny (workflow runs get MCP tools only)
//   the run was cancelled (pause, delete)                   -> deny
//   (s27) anything that is not an allowlisted read in mode "read" -> deny (a read step only reads, whatever approval)
//   anything that is not an allowlisted read in a dry run   -> deny (a dry run allows zero non-read tools)
//   meta / shell / forward / reply / draft tool, nested tool call in the input -> deny
//   not on the allowlist (allowlist.ts) for a connected server -> deny (unknown = deny)
//   allowlisted read                                        -> allow
//   (s13) input: a local UI edit, approved batch + declared send through its connector -> allow, consumes nothing
//   (s16) draft in the user's own mailbox: live intact batch, declared draft step, exact hash of a pending item, once
//         -> allow WITHOUT an approval token (not an external action, ADR 0006); never marks the item sending
//   side effect for a dry-run batch                         -> deny
//   batch items do not match the batch hash                 -> deny
//   no approval token for this exact batch hash (and auto-run off) -> deny
//   role not declared by the workflow's steps               -> deny
//   canonical hash of the FULL arguments != expected hash of any approved item -> deny
//   that item already had this role (send once, log once and only after its send) -> deny
//   the durable journal could not record the call           -> deny
//   otherwise                                               -> allow, journal it, mark the item done
// Every decision is logged (callback and, when given, workflows/<id>/gate-log.jsonl). On disk (REVIEW-2 privacy table)
// the log holds no content: the item is a hashed ref (itemRef), the reason is scrubbed (no addresses, no quoted
// argument snippets), and the file rotates at 5 MB keeping 2 old files (log.ts).
import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendLogLine, scrubLogText } from "../log.ts";
import { canonicalArgs, DEFAULT_SERVERS, expectedHash, policyFor, splitMcpName, type CrmSheet, type Role, type ToolPolicy } from "./allowlist.ts";
import { batchHash, shortHash, type Batch, type ItemState } from "./batch.ts";
import { DRIFT_WORDS } from "./generic.ts";

export { splitMcpName };

/** Compile-time proof that the gate plugs into the SDK as is. */
export type _GateFitsSdk = GateCanUseTool extends CanUseTool ? true : never;

export type ToolClass = "read" | "side_effect" | "builtin";
export type ServerMap = Readonly<Record<string, readonly string[]>>;

/** read only for an allowlisted read tool on a server that covers its connector; everything else is a side effect. */
export function classifyTool(name: string, servers: ServerMap = DEFAULT_SERVERS, extra?: readonly ToolPolicy[]): ToolClass {
  if (splitMcpName(name) === null) return "builtin";
  const p = policyFor(name, servers, undefined, extra);
  return !("reason" in p) && p.role === "read" ? "read" : "side_effect";
}

export interface ApprovalRecord {
  token: string;
  approvedAt: number;
  /** s10b N5: approved by auto-run (the run loop), not by you. */
  auto?: boolean;
}

/** A content-free reference to an item: sha256(workflow id, item key), 16 hex chars. */
export const itemRef = (workflowId: string, key: string) => createHash("sha256").update(`${workflowId}\u0000${key.toLowerCase()}`).digest("hex").slice(0, 16);

/** The on-disk form of a decision: itemKey becomes itemRef, the reason is scrubbed. Rotates at 5 MB. */
export function appendGateLog(path: string, d: GateDecisionLog): void {
  const { itemKey, ...rest } = d;
  const disk = { ...rest, reason: scrubLogText(d.reason), ...(itemKey === undefined ? {} : { itemRef: itemRef(d.workflowId, itemKey) }) };
  appendLogLine(path, JSON.stringify(disk));
}

/** s27: why a read step's call that is not a read is refused (mode "read"). */
export const READ_ONLY_WORDS = "a read step only reads: it never writes, saves or sends";

/** dry_run and live: a batch's run. s27 read: a read step fetching its source; only allowlisted reads pass. */
export type GateMode = "dry_run" | "live" | "read";

export interface GateDecisionLog {
  at: number;
  workflowId: string;
  batchHash: string;
  mode: GateMode;
  tool: string;
  toolClass: ToolClass;
  decision: "allow" | "deny";
  reason: string;
  itemKey?: string;
}

/** A side-effect action the workflow's steps declare, per item. */
export interface GateAction {
  role: Exclude<Role, "read" | "input">;
  connector: string;
  /** s20 review 5: only computer-use tools (flavor computer) may do this action. */
  method?: "computer";
}

/** An action the policy may do: same role and connector, and a computer-use action only through computer use. */
const covers = (a: GateAction, role: string, p: ToolPolicy) => a.role === role && a.connector === p.connector && (a.method !== "computer" || p.flavor === "computer");

export interface GateContext {
  workflowId: string;
  mode: GateMode;
  batch: Batch;
  /** Per-workflow flag, off by default: lets a live run act on its own batch without a token. */
  autoRun: boolean;
  /** The approval token this run holds, null when none. */
  runToken: string | null;
  /** Stored approvals by batch hash (a snapshot taken when the run started). */
  approvals: (hash: string) => ApprovalRecord | undefined;
  /** Server name -> catalog ids (from connectors.json). Default DEFAULT_SERVERS. */
  servers?: ServerMap;
  /** s13: dynamic policies (api operations, computer use), each bound to its server name. */
  policies?: readonly ToolPolicy[];
  /** Side-effect actions the steps declare. Default: send through gmail only. */
  actions?: readonly GateAction[];
  /** Where the CRM log tool may append. Without it the log tool is denied. */
  crmSheet?: CrmSheet;
  /** Durable state of an item (the runner's journal). A send is only allowed from "pending". */
  itemState?: (key: string) => ItemState | undefined;
  /** Called synchronously before an allow is returned; a throw turns the allow into a deny. */
  onAllow?: (key: string, role: GateAction["role"], tool: string) => void;
  /** Non-null when the run must stop (paused, deleted): the reason. Checked before every call. */
  cancelled?: () => string | null;
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
  role?: Role;
}

/** Assignable to the Agent SDK's CanUseTool (it never returns null and needs no SDK-only options). */
export type GateCanUseTool = (toolName: string, input: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<PermissionResult>;

export interface Gate {
  canUseTool: GateCanUseTool;
  /** canUseTool plus the decision behind it (item key and role), for executors that record results. */
  check(toolName: string, input: Record<string, unknown>): { result: PermissionResult; decision: Decision };
  preToolUse: HookCallback;
  /** Pure decision; `consume` marks the item done (and journals it) when allowed. */
  decide(toolName: string, input: Record<string, unknown>, consume: boolean): Decision;
  /** Item keys done per role ("send", "log"). */
  readonly done: ReadonlyMap<string, ReadonlySet<string>>;
}

const tokenEq = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const DEFAULT_ACTIONS: readonly GateAction[] = [{ role: "send", connector: "gmail" }];

export function createGate(ctx: GateContext): Gate {
  const done = new Map<string, Set<string>>([
    ["send", new Set()],
    ["log", new Set()],
    ["draft", new Set()],
  ]);
  const now = ctx.now ?? Date.now;
  const servers = ctx.servers ?? DEFAULT_SERVERS;
  const actions = ctx.actions ?? DEFAULT_ACTIONS;
  const intact = batchHash(ctx.batch.workflowId, ctx.batch.kind, ctx.batch.items) === ctx.batch.hash;
  const expectedCache = new Map<string, { hash: string } | { reason: string }>();

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
    if (ctx.logPath !== undefined) {
      try {
        appendGateLog(ctx.logPath, entry);
      } catch (err) {
        // The workflow folder can be deleted mid-run; the decision itself still stands.
        console.error("brain: gate log not written:", err instanceof Error ? err.message : err);
      }
    }
  };

  /** The approved item whose expected arguments hash exactly like `input` under `p`. */
  function matchItem(p: ToolPolicy, input: Record<string, unknown>): { item: Batch["items"][number] } | { reason: string } {
    const got = canonicalArgs(p, input);
    // s17: the call is denied either way; when a generic tool's schema changed since approval, that is the reason to
    // show (the new schema is why the approved call no longer fits).
    if ("reason" in got) return p.generic === true && ctx.batch.items.some((i) => p.whyNot?.(i) === DRIFT_WORDS) ? { reason: DRIFT_WORDS } : got;
    let firstReason: string | null = null;
    for (const i of ctx.batch.items) {
      const ck = `${p.tool}\u0000${i.key}`;
      let exp = expectedCache.get(ck);
      if (exp === undefined) {
        exp = expectedHash(p, i, { batchHash: ctx.batch.hash, ...(ctx.crmSheet === undefined ? {} : { crmSheet: ctx.crmSheet }) });
        expectedCache.set(ck, exp);
      }
      if ("reason" in exp) firstReason ??= exp.reason;
      else if (exp.hash === got.hash) return { item: i };
    }
    return { reason: firstReason ?? "arguments differ from every approved item (recipients, subject, body and every other field must be exactly as approved)" };
  }

  function decideDraft(toolName: string, p: ToolPolicy, input: Record<string, unknown>, consume: boolean): Decision {
    const deny = (reason: string, itemKey?: string): Decision => ({ allow: false, reason, toolClass: "side_effect", ...(itemKey === undefined ? {} : { itemKey }) });
    if (!actions.some((a) => a.role === "draft" && a.connector === p.connector)) return deny(`this workflow declares no draft step through ${p.connector}`);
    const found = matchItem(p, input);
    if ("reason" in found) return deny(found.reason);
    const key = found.item.key;
    const set = done.get("draft")!;
    if (set.has(key)) return deny(`draft already made for ${key} in this batch`, key);
    const state = ctx.itemState?.(key);
    if (state !== undefined && state !== "pending") return deny(`${key} is ${state}: no draft for an item that is not pending`, key);
    if (consume) {
      try {
        ctx.onAllow?.(key, "draft", toolName);
      } catch (err) {
        return deny(`could not record the draft before it runs: ${err instanceof Error ? err.message : String(err)}`, key);
      }
      set.add(key);
    }
    return { allow: true, reason: `draft in your own mailbox for batch ${shortHash(ctx.batch.hash)} (you send it yourself)`, toolClass: "side_effect", itemKey: key, role: "draft" };
  }

  function decide(toolName: string, input: Record<string, unknown>, consume: boolean): Decision {
    if (splitMcpName(toolName) === null) return { allow: false, reason: "built-in tools are disabled in workflow runs", toolClass: "builtin" };
    const p = policyFor(toolName, servers, input, ctx.policies);
    const isRead = !("reason" in p) && p.role === "read";
    const toolClass: ToolClass = isRead ? "read" : "side_effect";
    const deny = (reason: string, itemKey?: string): Decision => ({ allow: false, reason, toolClass, ...(itemKey === undefined ? {} : { itemKey }) });
    const cancelled = ctx.cancelled?.() ?? null;
    if (cancelled !== null) return deny(`run cancelled: ${cancelled}`);
    // s27: a read step can never write or send, whatever approval or auto-run the run holds.
    if (!isRead && ctx.mode === "read") return deny(READ_ONLY_WORDS);
    // Dry runs allow zero non-read tools, before anything else is looked at.
    if (!isRead && ctx.mode === "dry_run") return deny("dry run: side effects are disabled");
    if ("reason" in p) return deny(p.reason);
    if (p.role === "read") return { allow: true, reason: "allowlisted read tool", toolClass, role: "read" };
    if (ctx.batch.kind !== "live") return deny("dry-run batch: nothing in it can be sent");
    if (!intact) return deny(`batch ${shortHash(ctx.batch.hash)} does not match its hash: it changed after review`);
    // s16 (ADR 0006): a draft in the user's own mailbox is not an external action. It needs the live, intact batch, a
    // declared draft step and the exact arguments of one pending item, once, but no approval token, and it never
    // marks the item sending (the user still sends it).
    if (p.role === "draft") return decideDraft(toolName, p, input, consume);
    const approval = ctx.approvals(ctx.batch.hash);
    const approved = ctx.runToken !== null && approval !== undefined && tokenEq(approval.token, ctx.runToken);
    if (!approved && !ctx.autoRun) return deny(`no approval for batch ${shortHash(ctx.batch.hash)}`);
    // s13: a local UI edit (computer use) needs the approved batch and a declared commit through this connector, and
    // never uses up an item. What it typed is checked again, in full, by the commit's hash.
    if (p.role === "input") {
      if (!actions.some((a) => covers(a, "send", p))) return deny(`this workflow declares no send step through ${p.connector}`);
      return { allow: true, reason: `input for approved batch ${shortHash(ctx.batch.hash)}`, toolClass, role: "input" };
    }
    const role = p.role;
    if (!actions.some((a) => covers(a, role, p))) return deny(`this workflow declares no ${role} step through ${p.connector}${actions.some((a) => a.role === role && a.connector === p.connector) ? " with this tool (it is done on screen)" : ""}`);

    const found = matchItem(p, input);
    if ("reason" in found) return deny(found.reason);
    const item = found.item;

    const set = done.get(role)!;
    if (set.has(item.key)) return deny(`${role} already done for ${item.key} in this batch`, item.key);
    const state = ctx.itemState?.(item.key);
    if (role === "send" && state !== undefined && state !== "pending") return deny(`${item.key} is ${state}: never sent twice without your explicit release`, item.key);
    if (role === "log" && !done.get("send")!.has(item.key) && state !== "sent") return deny(`log for ${item.key} comes only after its send`, item.key);
    // s20 review 5: a send that was allowed but did not go through (failed or unknown) is not a send: no later step.
    if (role === "log" && state !== undefined && state !== "sent" && state !== "sending") return deny(`log for ${item.key} comes only after its send went through (it is ${state})`, item.key);
    if (consume) {
      try {
        ctx.onAllow?.(item.key, role, toolName);
      } catch (err) {
        return deny(`could not record the ${role} before it runs: ${err instanceof Error ? err.message : String(err)}`, item.key);
      }
      set.add(item.key);
    }
    return { allow: true, reason: approved ? `approved batch ${shortHash(ctx.batch.hash)}` : "auto-run is on for this workflow", toolClass, itemKey: item.key, role };
  }

  const check = (toolName: string, input: Record<string, unknown>) => {
    const d = decide(toolName, input, true);
    record(toolName, d);
    const result: PermissionResult = d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `Offload approval gate: ${d.reason}` };
    return { result, decision: d };
  };

  const canUseTool: GateCanUseTool = async (toolName, input) => check(toolName, input).result;

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

  return { canUseTool, check, preToolUse, decide, done };
}
