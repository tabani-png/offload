// s13: the computer-use executor (clean-room, principles from research 12: a dumb uniform loop, every policy outside
// it; nothing auto-acknowledged, unlike cua C5). Per approved item: open the app, screenshot, let the planner propose
// actions, and for each one, in order:
//   1. stop if the kill switch is on (stop route, pause/delete, or the person moved the pointer);
//   2. read AX (what is under the click point, what has focus) and classify it (actions.ts);
//   3. ask the gate: `mcp__computer_<target>__read | input | commit` (deny-class actions are sent under their own
//      name, which no policy knows, so the gate logs the refusal too);
//   4. only on allow, dispatch it to the driver, emit the pointer event, and feed the result back.
// A commit carries { app, verb, fields } with the form read from AX at that moment; the gate allows it only when its
// canonical hash equals the approved item's, once (the journal writes `sending` and the contacted ledger before the
// click). After a refused or failed action the rest of that turn is answered "Not executed: ..." (toolset rule).
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolPolicy } from "../../workflows/allowlist.ts";
import type { ExecJob, ExecResult, Executor, ToolCallRecord } from "../../workflows/executor.ts";
import { MethodFailed } from "../composio.ts";
import type { ChainTarget } from "../targets.ts";
import { classify, expectedCommit, canonicalForm, type ActionClass } from "./actions.ts";
import type { Planner, PlannedCall } from "./claude.ts";
import type { AxElement, ComputerDriver, MouseButton, Screenshot } from "./driver.ts";
import { computerServer } from "./probe.ts";
import { ComputerSessions, STOP_REASONS, type KillSwitch } from "./session.ts";

export const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";
export const POINTER_SLACK_PX = 8;
export const DEFAULT_MAX_TURNS = 30;

/** Gate policies for computer use on these targets: read, input and the hash-bound commit, per target server. */
export function computerPolicies(targetIds: readonly string[]): ToolPolicy[] {
  const out: ToolPolicy[] = [];
  for (const id of targetIds) {
    const server = computerServer(id);
    out.push({ connector: id, flavor: "computer", tool: "read", role: "read", verified: false, server });
    out.push({ connector: id, flavor: "computer", tool: "input", role: "input", verified: false, server });
    out.push({
      connector: id,
      flavor: "computer",
      tool: "commit",
      role: "send",
      verified: false,
      server,
      fields: { app: { kind: "id" }, verb: { kind: "id" }, fields: { kind: "rows" } },
      expected: (item) => {
        const e = expectedCommit(item);
        return { app: id, verb: e.verb, fields: e.fields };
      },
    });
  }
  return out;
}

export interface ComputerExecOptions {
  driver: ComputerDriver;
  planner: Planner;
  sessions: ComputerSessions;
  /** The target of a connector id (the send connector of the workflow). */
  target: (connectorId: string) => ChainTarget | null;
  maxTurns?: number;
  /** Seconds to let the UI settle after an action before the next screenshot (0 in the stub). */
  settleSeconds?: number;
  now?: () => number;
}

type Block = Anthropic.ToolResultBlockParam;

const text = (s: string) => [{ type: "text" as const, text: s }];

export class ComputerUseExecutor implements Executor {
  constructor(private readonly o: ComputerExecOptions) {}

  async execute(job: ExecJob): Promise<ExecResult> {
    const perms = await this.o.driver.permissions();
    if (!perms.accessibility || !perms.screenRecording) throw new MethodFailed("Offload is not allowed to control the screen");
    const send = (job.actions ?? [{ role: "send" as const, connector: "gmail" }]).find((a) => a.role === "send");
    const target = send === undefined ? null : this.o.target(send.connector);
    if (target === null) throw new MethodFailed("no app to drive for this workflow");
    const toolCalls: ToolCallRecord[] = [];
    for (const item of job.batch.items) {
      if (job.only !== undefined && !job.only.has(item.key)) continue;
      if (job.signal?.aborted === true) break;
      const kill = this.o.sessions.begin(job.batch.workflowId, target.id, job.signal);
      try {
        await this.runItem(job, target, item.key, kill, toolCalls);
      } finally {
        this.o.sessions.end(kill);
      }
      if (kill.stopped) break;
    }
    return { toolCalls, text: `${toolCalls.filter((c) => c.ok && c.role === "send").length} commits done on screen` };
  }

  private async runItem(job: ExecJob, target: ChainTarget, key: string, kill: KillSwitch, calls: ToolCallRecord[]): Promise<void> {
    const item = job.batch.items.find((i) => i.key === key)!;
    const d = this.o.driver;
    await d.open(target);
    let shot = await d.screenshot();
    const expected = expectedCommit(item);
    const session = this.o.planner.start({ target, verb: expected.verb, fields: expected.fields, screenshot: shot });
    const state = { last: null as { x: number; y: number } | null, committed: false, shot };
    let results: Block[] | null = null;
    for (let turn = 0; turn < (this.o.maxTurns ?? DEFAULT_MAX_TURNS); turn++) {
      if (kill.stopped) return;
      const t = await session.next(results);
      if (t.calls.length === 0) return;
      results = [];
      let failed = false;
      for (const call of t.calls) {
        const echo = call.computer ? { toolset_name: "computer" } : {};
        if (call.name === "done") {
          results.push({ type: "tool_result", tool_use_id: call.id, content: text("OK") });
          continue;
        }
        if (failed || kill.stopped) {
          results.push({ type: "tool_result", tool_use_id: call.id, ...echo, is_error: true, content: text(kill.stopped ? `Stopped: ${kill.reason ?? ""}` : NOT_EXECUTED) });
          continue;
        }
        const out = await this.act(job, target, call, kill, state, calls);
        results.push({ type: "tool_result", tool_use_id: call.id, ...echo, ...(out.ok ? {} : { is_error: true }), content: out.content });
        if (!out.ok) failed = true;
      }
      if (state.committed || t.done || kill.stopped) return;
    }
  }

  private async act(job: ExecJob, target: ChainTarget, call: PlannedCall, kill: KillSwitch, state: { last: { x: number; y: number } | null; committed: boolean; shot: Screenshot }, calls: ToolCallRecord[]): Promise<{ ok: boolean; content: Block["content"] }> {
    const d = this.o.driver;
    const server = computerServer(target.id);
    // The person grabbed the mouse: hand control back before doing anything else (research 12 E6).
    const cur = await d.cursor();
    if (state.last !== null && Math.hypot(cur.x - state.last.x, cur.y - state.last.y) > POINTER_SLACK_PX) {
      kill.stop(STOP_REASONS.pointer);
      return { ok: false, content: text(`Stopped: ${STOP_REASONS.pointer}`) };
    }
    const input = call.input;
    const scale = state.shot.scale > 0 ? state.shot.scale : 1;
    const coord = (k = "coordinate"): { x: number; y: number } | null => {
      const c = input[k];
      return Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: Math.round((c[0] as number) / scale), y: Math.round((c[1] as number) / scale) } : null;
    };
    const point = coord() ?? cur;
    const isClick = ["left_click", "right_click", "middle_click", "double_click", "triple_click"].includes(call.name);
    const el: AxElement | null = isClick ? await d.elementAt(point.x, point.y) : null;
    const focused = call.name === "type" || call.name === "key" ? await d.focused() : null;
    const cls: ActionClass = call.computer || call.name === "read_ui" ? classify(call.name, input, { target: el, focused }) : { kind: "deny", reason: `${call.name} is not a tool Offload offers` };

    if (cls.kind === "deny") {
      job.gate.check(`mcp__${server}__${call.name}`, { member: call.name });
      return { ok: false, content: text(`Refused by Offload: ${cls.reason}.`) };
    }
    if (cls.kind === "read" || cls.kind === "input") {
      const tool = `mcp__${server}__${cls.kind}`;
      const { result } = job.gate.check(tool, { member: call.name });
      if (result.behavior !== "allow") return { ok: false, content: text(`Refused by Offload: ${result.message}`) };
      return this.dispatch(call, point, el, state, coord);
    }
    // commit: the form as AX shows it now, hashed by the gate against the approved item.
    const args = { app: target.id, verb: cls.verb, fields: canonicalForm(await d.formValues()) };
    const tool = `mcp__${server}__commit`;
    const { result, decision } = job.gate.check(tool, args);
    const rec: ToolCallRecord = { tool, input: args, allowed: result.behavior === "allow", ok: false, ...(decision.itemKey === undefined ? {} : { itemKey: decision.itemKey }), ...(decision.role === undefined ? {} : { role: decision.role }) };
    calls.push(rec);
    if (!rec.allowed) return { ok: false, content: text(`Refused by Offload: ${result.behavior === "deny" ? result.message : "not allowed"}`) };
    let out: { ok: boolean; content: Block["content"] };
    try {
      out = await this.dispatch(call, point, el, state, coord);
      rec.ok = out.ok;
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
      out = { ok: false, content: text("The action failed.") };
    }
    job.onToolResult?.(rec);
    if (!rec.ok) throw new MethodFailed(rec.error ?? "the commit did not go through");
    state.committed = true;
    return out;
  }

  private async dispatch(call: PlannedCall, point: { x: number; y: number }, el: AxElement | null, state: { last: { x: number; y: number } | null; shot: Screenshot }, coord: (k?: string) => { x: number; y: number } | null): Promise<{ ok: boolean; content: Block["content"] }> {
    const d = this.o.driver;
    const now = this.o.now ?? Date.now;
    const i = call.input;
    const pointer = (action: string, p = point) => this.o.sessions.pointer({ x: p.x, y: p.y, label: el?.title ?? "", action, at: now() });
    const settle = async () => {
      if ((this.o.settleSeconds ?? 0) > 0) await d.wait(this.o.settleSeconds!);
    };
    const mods = typeof i.text === "string" && i.text !== "" ? i.text.split("+") : [];
    switch (call.name) {
      case "screenshot": {
        state.shot = await d.screenshot();
        return { ok: true, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: state.shot.png } }] };
      }
      case "read_ui":
        return { ok: true, content: text(await d.readUi()) };
      case "cursor_position": {
        const c = await d.cursor();
        return { ok: true, content: text(`${Math.round(c.x * state.shot.scale)},${Math.round(c.y * state.shot.scale)}`) };
      }
      case "wait":
        await d.wait(Math.min(typeof i.duration === "number" ? i.duration : 1, 5));
        return { ok: true, content: text("OK") };
      case "mouse_move": {
        const p = coord();
        if (p === null) return { ok: false, content: text("mouse_move needs a coordinate") };
        pointer("move", p);
        await d.move(p.x, p.y);
        state.last = p;
        return { ok: true, content: text("OK") };
      }
      case "scroll": {
        const dir = i.scroll_direction;
        if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") return { ok: false, content: text("scroll needs a direction") };
        pointer("scroll");
        await d.scroll(point.x, point.y, dir, Math.max(1, Math.min(typeof i.scroll_amount === "number" ? i.scroll_amount : 3, 20)));
        state.last = point;
        await settle();
        return { ok: true, content: text("OK") };
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const button: MouseButton = call.name === "right_click" ? "right" : call.name === "middle_click" ? "middle" : "left";
        const count = call.name === "double_click" ? 2 : call.name === "triple_click" ? 3 : 1;
        pointer(call.name);
        await d.click(point.x, point.y, button, count, mods);
        state.last = point;
        await settle();
        return { ok: true, content: text("OK") };
      }
      case "type":
        await d.type(String(i.text));
        await settle();
        return { ok: true, content: text("OK") };
      case "key":
        await d.key(String(i.text), Math.max(1, Math.min(typeof i.repeat === "number" ? i.repeat : 1, 100)));
        await settle();
        return { ok: true, content: text("OK") };
      default:
        return { ok: false, content: text(`${call.name} is not supported`) };
    }
  }
}
