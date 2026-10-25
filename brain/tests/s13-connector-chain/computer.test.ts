// s13 COMPUTER: classification, the hash-bound commit (one approved item, one use), reads in dry runs, input needs an
// approval, the kill switch, "you moved the pointer", pointer overlay events, the batch-turn rule and the Messages
// request shape. Everything runs on the in-memory StubDriver and a scripted planner or a fake Messages client.
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { canonicalAddresses, canonicalForm, classify, classifyKey, commitVerbOf, expectedCommit } from "../../src/connectors/computer/actions.ts";
import { ClaudePlanner, DEFAULT_COMPUTER_MODEL as COMPUTER_MODEL, computerRequest, defaultPickModel, ScriptedPlanner, type ComputerTask, type MessagesApi } from "../../src/connectors/computer/claude.ts";
import { StubDriver } from "../../src/connectors/computer/driver.ts";
import { computerPolicies, ComputerUseExecutor, NOT_EXECUTED } from "../../src/connectors/computer/executor.ts";
import { computerServer, DisabledComputerProbe, DriverComputerProbe } from "../../src/connectors/computer/probe.ts";
import { ComputerSessions, STOP_REASONS, type PointerEvent } from "../../src/connectors/computer/session.ts";
import { MethodFailed } from "../../src/connectors/composio.ts";
import { catalogTarget } from "../../src/connectors/targets.ts";
import type { BatchItem } from "../../src/workflows/batch.ts";
import type { ToolCallRecord } from "../../src/workflows/executor.ts";
import { gateWorld, ITEM, resolver, tempHome } from "./setup.ts";

const gmail = catalogTarget("gmail")!;
const SERVER = computerServer("gmail");
const world = (o: Parameters<typeof gateWorld>[0] = {}) => gateWorld({ items: [ITEM], servers: { [SERVER]: ["gmail"] }, policies: computerPolicies(["gmail"]), ...o });

type Step = { name: string; input: Record<string, unknown> };
const click = (d: StubDriver, id: string, name = "left_click"): Step => ({ name, input: { coordinate: d.center(id) } });
const typeText = (text: string): Step => ({ name: "type", input: { text } });
/** The happy path: fill To, Subject, Body exactly as approved, press Send. */
const fill = (d: StubDriver, item: BatchItem = ITEM, over: Partial<Record<"to" | "subject" | "body", string>> = {}): Step[][] => [
  [{ name: "screenshot", input: {} }],
  [click(d, "to"), typeText(over.to ?? item.to), click(d, "subject"), typeText(over.subject ?? item.subject), click(d, "body"), typeText(over.body ?? item.body)],
];

function run(o: { driver?: StubDriver; turns: (d: StubDriver) => Step[][]; world?: ReturnType<typeof world>; sessions?: ComputerSessions; signal?: AbortSignal }) {
  const d = o.driver ?? StubDriver.compose();
  const w = o.world ?? world();
  const sessions = o.sessions ?? new ComputerSessions();
  const planner = new ScriptedPlanner(() => o.turns(d));
  const recs: ToolCallRecord[] = [];
  const ex = new ComputerUseExecutor({ driver: d, planner, sessions, target: (id) => catalogTarget(id) });
  const done = ex.execute({ batch: w.batch, gate: w.gate, onToolResult: (r) => void recs.push(r), actions: [{ role: "send", connector: "gmail" }], ...(o.signal === undefined ? {} : { signal: o.signal }) });
  return { d, w, planner, recs, sessions, done };
}

describe("s13 computer: classification", () => {
  test("COMPUTER: reads, inputs, commits and denials by member and by what AX says is under the pointer", () => {
    const btn = (title: string) => ({ role: "AXButton", title, editable: false });
    const field = { role: "AXTextField", title: "Subject", editable: true };
    const area = { role: "AXTextArea", title: "Message Body", editable: true, multiline: true };
    for (const m of ["screenshot", "cursor_position", "mouse_move", "scroll", "wait", "read_ui"]) expect(classify(m, {}, { target: null, focused: null }).kind).toBe("read");
    expect(classify("left_click", {}, { target: btn("Send"), focused: null })).toEqual({ kind: "commit", verb: "send", control: "AXButton Send" });
    expect(classify("left_click", {}, { target: btn("Formatting options"), focused: null }).kind).toBe("input");
    expect(classify("left_click", {}, { target: field, focused: null }).kind).toBe("input");
    expect(classify("left_click", {}, { target: null, focused: null }).kind).toBe("deny");
    expect(classify("double_click", {}, { target: btn("Delete"), focused: null })).toMatchObject({ kind: "commit", verb: "delete" });
    expect(classify("right_click", {}, { target: btn("Delete"), focused: null }).kind).toBe("input");
    expect(classify("type", { text: "hello" }, { target: null, focused: field }).kind).toBe("input");
    expect(classify("type", { text: "hello" }, { target: null, focused: btn("Send") }).kind).toBe("deny");
    expect(classify("type", { text: "line\nline" }, { target: null, focused: field }).kind).toBe("deny");
    expect(classify("type", { text: "line\nline" }, { target: null, focused: area }).kind).toBe("input");
    for (const m of ["left_click_drag", "left_mouse_down", "left_mouse_up", "hold_key", "zoomzoom", "bash"]) expect(classify(m, {}, { target: null, focused: null }).kind).toBe("deny");
  });

  test("COMPUTER: commit verbs from the control's title, description or identifier; the first word wins", () => {
    expect(commitVerbOf({ title: "Send", description: "", identifier: "" })).toBe("send");
    expect(commitVerbOf({ title: "Schedule send" })).toBe("schedule");
    expect(commitVerbOf({ title: "", description: "Pay now" })).toBe("pay");
    expect(commitVerbOf({ title: "", identifier: "invite_button" })).toBe("invite");
    for (const t of ["Submit", "Save", "Post", "Publish", "Delete", "Remove", "OK", "Yes", "Confirm", "Place order", "Book", "Reply", "Forward", "Upload", "Create", "Add contact", "Continue", "Done"]) expect(commitVerbOf({ title: t })).not.toBeNull();
    for (const t of ["Bold", "Formatting options", "Subject", "To recipients", "Sender info", "Postpone? no", "Addresses"]) expect(commitVerbOf({ title: t === "Postpone? no" ? "Postpone" : t })).toBeNull();
  });

  test("COMPUTER: keys: any Return is a commit, Cmd+S saves, paste and unknown shortcuts are refused, text edits are input", () => {
    const field = { role: "AXTextField", title: "Subject", editable: true };
    expect(classifyKey("Return", field)).toMatchObject({ kind: "commit", verb: "submit" });
    expect(classifyKey("cmd+Return", null)).toMatchObject({ kind: "commit", verb: "submit" });
    expect(classifyKey("super+s", field)).toMatchObject({ kind: "commit", verb: "save" });
    expect(classifyKey("cmd+v", field).kind).toBe("deny");
    expect(classifyKey("cmd+q", null).kind).toBe("deny");
    expect(classifyKey("cmd+shift+d", field).kind).toBe("deny");
    expect(classifyKey("BackSpace", field).kind).toBe("input");
    expect(classifyKey("Delete", null)).toMatchObject({ kind: "commit", verb: "delete" });
    expect(classifyKey("cmd+a", field).kind).toBe("input");
    expect(classifyKey("Tab", null).kind).toBe("input");
    expect(classifyKey("space", null).kind).toBe("deny");
    expect(classifyKey("a", field).kind).toBe("input");
  });

  test("COMPUTER: the form a commit carries: semantic keys, normalised addresses, empty fields dropped", () => {
    expect(canonicalAddresses("Anna Berg <Anna@NorthZone.com>; leo@hustlefund.vc")).toBe("anna@northzone.com, leo@hustlefund.vc");
    expect(canonicalForm([{ label: "To recipients", value: "ANNA@northzone.com" }, { label: "Subject:", value: "Hi  " }, { label: "Search mail", value: "" }, { label: "Message Body", value: "x\r\ny" }])).toEqual([
      ["body", "x\ny"],
      ["subject", "Hi"],
      ["to", "anna@northzone.com"],
    ]);
    expect(expectedCommit(ITEM)).toEqual({ verb: "send", fields: [["body", ITEM.body.trimEnd()], ["subject", ITEM.subject], ["to", ITEM.to]] });
    expect(expectedCommit({ ...ITEM, commit: { verb: "save", fields: [["Invoice number", "INV-7"], ["Amount", "120.00"]] } })).toEqual({ verb: "save", fields: [["amount", "120.00"], ["invoice number", "INV-7"]] });
  });
});

describe("s13 computer: the commit is bound to the approved item", () => {
  test("COMPUTER: the exact approved form + Send is allowed once; the journal is written before the click; Send was pressed with that form", async () => {
    const x = run({ turns: (d) => [...fill(d), [click(d, "send")], [{ name: "done", input: { outcome: "committed", note: "" } }]] });
    await x.done;
    expect(x.d.pressed).toHaveLength(1);
    expect(x.d.pressed[0]!.title).toBe("Send");
    expect(x.recs).toEqual([expect.objectContaining({ tool: `mcp__${SERVER}__commit`, allowed: true, ok: true, itemKey: ITEM.key, role: "send" })]);
    expect(x.w.journal).toEqual([{ key: ITEM.key, role: "send", tool: `mcp__${SERVER}__commit` }]);
    expect(x.w.states[ITEM.key]).toBe("sending");
    // Every action went through the gate: reads and inputs allowed, logged.
    expect(x.w.log.filter((l) => l.tool === `mcp__${SERVER}__input`).every((l) => l.decision === "allow")).toBe(true);
    expect(x.w.log.some((l) => l.tool === `mcp__${SERVER}__read`)).toBe(true);
  });

  test("COMPUTER: a changed subject, an extra CC, Schedule send or Return instead of Send are all refused; nothing is committed", async () => {
    const variants: Array<(d: StubDriver) => Step[][]> = [
      (d) => [...fill(d, ITEM, { subject: "Seed round: Offload (v2)" }), [click(d, "send")]],
      (d) => [...fill(d), [click(d, "cc"), typeText("boss@northzone.com"), click(d, "send")]],
      (d) => [...fill(d), [click(d, "schedule")]],
      (d) => [...fill(d), [click(d, "subject"), { name: "key", input: { text: "Return" } }]],
    ];
    for (const turns of variants) {
      const d = StubDriver.compose();
      d.elements.push({ id: "cc", role: "AXTextField", title: "Cc recipients", editable: true, value: "", x: 600, y: 100, w: 200, h: 20 });
      const x = run({ driver: d, turns });
      await x.done;
      expect(x.d.pressed).toHaveLength(0);
      expect(x.w.journal).toHaveLength(0);
      expect(x.w.states[ITEM.key]).toBe("pending");
      const last = x.planner.seen.at(-1);
      expect(JSON.stringify(last)).toContain("Refused by Offload");
    }
  });

  test("COMPUTER: one approved item, one use: a second Send after the commit is never pressed", async () => {
    const x = run({ turns: (d) => [...fill(d), [click(d, "send"), click(d, "send")]] });
    await x.done;
    expect(x.d.pressed).toHaveLength(1);
    expect(x.w.journal).toHaveLength(1);
    // A fresh session on the same gate: the item is already being sent, so the commit is refused.
    const again = run({ world: x.w, turns: (d) => [...fill(d), [click(d, "send")]] });
    await again.done;
    expect(again.d.pressed).toHaveLength(0);
    expect(x.w.log.filter((l) => l.tool === `mcp__${SERVER}__commit` && l.decision === "deny").length).toBeGreaterThan(0);
  });

  test("COMPUTER: a dry run allows reads only; without an approval even typing is refused", async () => {
    const dry = run({ world: world({ mode: "dry_run" }), turns: (d) => fill(d) });
    await dry.done;
    expect(dry.d.events.filter((e) => e.kind === "type" || e.kind === "click")).toHaveLength(0);
    expect(dry.w.log.find((l) => l.tool.endsWith("__read"))?.decision).toBe("allow");
    expect(dry.w.log.find((l) => l.tool.endsWith("__input"))?.reason).toContain("dry run");
    const unapproved = run({ world: world({ approved: false }), turns: (d) => fill(d) });
    await unapproved.done;
    expect(unapproved.d.events.filter((e) => e.kind === "type")).toHaveLength(0);
    expect(unapproved.w.log.find((l) => l.tool.endsWith("__input"))?.reason).toContain("no approval");
  });

  test("COMPUTER: after a refused action the rest of that turn is answered 'Not executed', every computer result echoes toolset_name", async () => {
    const x = run({ turns: () => [[{ name: "left_click", input: { coordinate: [5, 5] } }, typeText("x"), { name: "read_ui", input: {} }]] });
    await x.done;
    const results = x.planner.seen[1]!;
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ is_error: true, toolset_name: "computer" });
    expect(JSON.stringify(results[0]!.content)).toContain("cannot tell what is under the pointer");
    expect(results[1]).toMatchObject({ is_error: true, toolset_name: "computer", content: [{ type: "text", text: NOT_EXECUTED }] });
    // read_ui is Offload's own tool: no toolset_name.
    expect(results[2]!.toolset_name).toBeUndefined();
    expect(x.d.events.filter((e) => e.kind === "type")).toHaveLength(0);
  });
});

describe("s13 computer: stop, pointer, overlay, permissions", () => {
  test("COMPUTER: the kill switch stops the run before its next action", async () => {
    const sessions = new ComputerSessions();
    const d = StubDriver.compose();
    const orig = d.type.bind(d);
    d.type = async (t: string) => {
      await orig(t);
      sessions.stop();
    };
    const x = run({ driver: d, sessions, turns: (dd) => [...fill(dd), [click(dd, "send")]] });
    await x.done;
    expect(d.events.filter((e) => e.kind === "type")).toHaveLength(1);
    expect(d.pressed).toHaveLength(0);
    expect(sessions.dto()).toMatchObject({ running: false, stopped: true, stopReason: STOP_REASONS.user });
    expect(JSON.stringify(x.planner.seen.at(-1))).not.toContain('"OK"},{');
  });

  test("COMPUTER: moving the pointer hands control back", async () => {
    const d = StubDriver.compose();
    const orig = d.type.bind(d);
    d.type = async (t: string) => {
      await orig(t);
      d.userMoves(900, 700);
    };
    const sessions = new ComputerSessions();
    const x = run({ driver: d, sessions, turns: (dd) => [...fill(dd), [click(dd, "send")]] });
    await x.done;
    expect(d.pressed).toHaveLength(0);
    expect(sessions.dto().stopReason).toBe(STOP_REASONS.pointer);
  });

  test("COMPUTER: pausing the workflow (abort signal) stops it too", async () => {
    const ac = new AbortController();
    ac.abort();
    const x = run({ signal: ac.signal, turns: (d) => fill(d) });
    await x.done;
    expect(x.d.events).toHaveLength(0);
  });

  test("COMPUTER: every pointer action is reported to the overlay with the control's label", async () => {
    const sessions = new ComputerSessions();
    const seen: PointerEvent[] = [];
    sessions.addSink({ pointer: (e) => void seen.push(e) });
    const x = run({ sessions, turns: (d) => [...fill(d), [click(d, "send")]] });
    await x.done;
    expect(seen.map((e) => [e.action, e.label])).toEqual([
      ["left_click", "To recipients"],
      ["left_click", "Subject"],
      ["left_click", "Message Body"],
      ["left_click", "Send"],
    ]);
    expect(sessions.dto().pointer).toMatchObject({ label: "Send", x: x.d.center("send")[0], y: x.d.center("send")[1] });
  });

  test("COMPUTER: no Accessibility -> the method fails before anything happens; probes report why", async () => {
    const d = StubDriver.compose();
    d.perms = { accessibility: false, screenRecording: true };
    const x = run({ driver: d, turns: (dd) => fill(dd) });
    await expect(x.done).rejects.toBeInstanceOf(MethodFailed);
    expect(d.events).toHaveLength(0);
    const { home, cleanup } = tempHome();
    try {
      const deps = resolver(home).r.deps;
      expect(await new DriverComputerProbe(d).probe(gmail, deps)).toMatchObject({ health: "skipped", code: "no_permission" });
      d.perms = { accessibility: true, screenRecording: true };
      d.present = false;
      expect(await new DriverComputerProbe(d).probe(gmail, deps)).toMatchObject({ health: "skipped", code: "app_missing" });
      d.present = true;
      expect(await new DriverComputerProbe(d).probe(gmail, deps)).toMatchObject({ health: "ok", reads: ["screen.read"], writes: ["mail.send"] });
      expect(await new DisabledComputerProbe().probe()).toMatchObject({ health: "skipped", code: "computer_off" });
    } finally {
      cleanup();
    }
  });
});

describe("s13 computer: the Messages request", () => {
  test("COMPUTER: claude-sonnet-5-5, the computer toolset with drag / mouse down-up / hold_key / zoom off, no beta, adaptive thinking", () => {
    const req = computerRequest([{ role: "user", content: "x" }], defaultPickModel("computer.step", { targetId: "gmail", turn: 0 }));
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(COMPUTER_MODEL).toBe("claude-sonnet-5-5");
    expect(req.tools![0]).toEqual({ type: "computer_toolset_20260801", configs: { left_click_drag: { enabled: false }, left_mouse_down: { enabled: false }, left_mouse_up: { enabled: false }, hold_key: { enabled: false }, zoom: { enabled: false } } });
    expect(req.tools!.slice(1).map((t) => (t as { name: string }).name)).toEqual(["read_ui", "done"]);
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(req)).not.toContain("betas");
    expect(JSON.stringify(req)).not.toContain("tool_choice");
  });

  test("COMPUTER: the planner sends the approved form as data, keeps the history append-only and reads toolset members", async () => {
    const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const replies: Anthropic.Message[] = [
      { id: "m1", type: "message", role: "assistant", model: COMPUTER_MODEL, stop_reason: "tool_use", stop_sequence: null, content: [{ type: "tool_use", id: "t1", name: "left_click", input: { coordinate: [10, 10] }, toolset_name: "computer" } as unknown as Anthropic.ContentBlock, { type: "tool_use", id: "t2", name: "read_ui", input: {} } as unknown as Anthropic.ContentBlock], usage: {} as Anthropic.Usage } as Anthropic.Message,
      { id: "m2", type: "message", role: "assistant", model: COMPUTER_MODEL, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "done" } as Anthropic.ContentBlock], usage: {} as Anthropic.Usage } as Anthropic.Message,
    ];
    const api: MessagesApi = { create: async (p) => (sent.push(structuredClone(p)), replies.shift()!) };
    const task: ComputerTask = { target: gmail, verb: "send", fields: expectedCommit(ITEM).fields, screenshot: { png: "AAA", width: 10, height: 10, scale: 1 } };
    const picks: Array<{ route: string; targetId: string; turn: number }> = [];
    const s = new ClaudePlanner(api, (route, ctx) => (picks.push({ route, ...ctx }), "model-from-router")).start(task);
    const t1 = await s.next(null);
    expect(t1.calls).toEqual([
      { id: "t1", name: "left_click", input: { coordinate: [10, 10] }, computer: true },
      { id: "t2", name: "read_ui", input: {}, computer: false },
    ]);
    expect(t1.done).toBe(false);
    const first = JSON.stringify(sent[0]!.messages[0]);
    expect(first).toContain("<approved_form untrusted=");
    expect(first).toContain(ITEM.subject);
    expect(first).toContain('"type":"image"');
    const t2 = await s.next([{ type: "tool_result", tool_use_id: "t1", toolset_name: "computer", content: "OK" }, { type: "tool_result", tool_use_id: "t2", content: "AXButton Send" }]);
    expect(t2.done).toBe(true);
    // The model comes from the injected picker (s14's router), per step.
    expect(picks).toEqual([{ route: "computer.step", targetId: "gmail", turn: 0 }, { route: "computer.step", targetId: "gmail", turn: 1 }]);
    expect(sent.map((p) => p.model)).toEqual(["model-from-router", "model-from-router"]);
    // Append-only: the second request starts with the first request's messages plus the assistant turn, unchanged.
    expect(sent[1]!.messages.slice(0, 1)).toEqual(sent[0]!.messages);
    expect(sent[1]!.messages[1]!.role).toBe("assistant");
    expect(sent[1]!.messages[2]).toMatchObject({ role: "user", content: [{ toolset_name: "computer" }, { tool_use_id: "t2" }] });
  });
});
