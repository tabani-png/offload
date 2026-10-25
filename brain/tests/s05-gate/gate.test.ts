// s05 AC-5: the approval gate is code, not a prompt. A fake tool set runs through the same canUseTool / PreToolUse
// path the Agent SDK uses. Nothing external happens without an approval token for that exact batch hash.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CanUseTool, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBatch, type BatchItem } from "../../src/workflows/batch.ts";
import { ScriptedExecutor, type FakeTool } from "../../src/workflows/executor.ts";
import { classifyTool, createGate, type GateDecisionLog } from "../../src/workflows/gate.ts";
import { tempHome } from "../helpers.ts";

const SEND = "mcp__gmail__send_email";
const READ = "mcp__gmail__search_emails";
const APPEND = "mcp__composio__GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND";

const item = (to: string, body = `Hi there,\n\nShort note for ${to}.\n\nMuhammad`): BatchItem => ({ key: to, to, subject: "Acme seed round", body, warnings: [] });
const A = makeBatch("wf_a", "live", [item("anna@northzone.com"), item("tom@seedcamp.com")], 1);
const B = makeBatch("wf_a", "live", [item("leo@hustlefund.vc")], 2);
const sendInput = (i: BatchItem) => ({ to: i.to, subject: i.subject, body: i.body });

let home = "";
let cleanup = () => {};
let log: GateDecisionLog[] = [];
let sent: Array<Record<string, unknown>> = [];
let tools: Record<string, FakeTool> = {};
beforeEach(() => {
  ({ home, cleanup } = tempHome());
  log = [];
  sent = [];
  tools = {
    [READ]: async () => ({ messages: [] }),
    [SEND]: async (input) => {
      sent.push(input);
      return { id: `msg_${sent.length}` };
    },
    [APPEND]: async () => ({ updated: 1 }),
  };
});
afterEach(() => cleanup());

const approvalsFor = (records: Record<string, string>) => (hash: string) => (records[hash] === undefined ? undefined : { token: records[hash]!, approvedAt: 1 });

describe("s05 approval gate", () => {
  // s05b (REVIEW-1 M1): reads are an explicit allowlist per connector, no longer inferred from read verbs.
  test("classifies tools: only allowlisted reads are reads; writes, unknowns and built-ins are side effects", () => {
    expect(classifyTool(READ)).toBe("read");
    expect(classifyTool("mcp__composio__GMAIL_FETCH_EMAILS")).toBe("read");
    expect(classifyTool("mcp__composio__GOOGLECALENDAR_FIND_FREE_SLOTS")).toBe("read");
    expect(classifyTool("mcp__cal__GOOGLECALENDAR_FIND_FREE_SLOTS")).toBe("side_effect");
    expect(classifyTool(SEND)).toBe("side_effect");
    expect(classifyTool("mcp__gmail__create_draft")).toBe("side_effect");
    expect(classifyTool(APPEND)).toBe("side_effect");
    expect(classifyTool("mcp__x__getAndDeleteThing")).toBe("side_effect");
    expect(classifyTool("mcp__x__frobnicate")).toBe("side_effect");
    expect(classifyTool("Bash")).toBe("builtin");
    expect(classifyTool("WebFetch")).toBe("builtin");
  });

  test("gate: send without approval is denied and logged", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: null, approvals: approvalsFor({}), log: (d) => log.push(d), logPath: join(home, "gate-log.jsonl") });
    const ex = new ScriptedExecutor(tools, () => [{ tool: SEND, input: sendInput(A.items[0]!) }]);
    const r = await ex.execute({ batch: A, gate });
    expect(sent).toEqual([]);
    expect(r.toolCalls[0]).toMatchObject({ tool: SEND, allowed: false });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ decision: "deny", tool: SEND, toolClass: "side_effect", batchHash: A.hash });
    expect(log[0]!.reason).toContain("no approval");
    const onDisk = readFileSync(join(home, "gate-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as GateDecisionLog);
    expect(onDisk[0]).toMatchObject({ decision: "deny", tool: SEND });
  });

  test("gate: approval for batch A does not approve batch B", async () => {
    const approvals = approvalsFor({ [A.hash]: "token-A-0123456789" });
    const gateB = createGate({ workflowId: "wf_a", mode: "live", batch: B, autoRun: false, runToken: "token-A-0123456789", approvals, log: (d) => log.push(d) });
    await new ScriptedExecutor(tools, () => [{ tool: SEND, input: sendInput(B.items[0]!) }]).execute({ batch: B, gate: gateB });
    expect(sent).toEqual([]);
    expect(log[0]?.reason).toContain("no approval");
    // The same token on its own batch is allowed.
    const gateA = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: "token-A-0123456789", approvals, log: (d) => log.push(d) });
    await new ScriptedExecutor(tools, () => A.items.map((i) => ({ tool: SEND, input: sendInput(i) }))).execute({ batch: A, gate: gateA });
    expect(sent.map((s) => s.to)).toEqual(["anna@northzone.com", "tom@seedcamp.com"]);
  });

  test("gate: a wrong token for the right batch is denied", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: "guess", approvals: approvalsFor({ [A.hash]: "token-A-0123456789" }), log: (d) => log.push(d) });
    expect((await gate.canUseTool(SEND, sendInput(A.items[0]!), { signal: new AbortController().signal })).behavior).toBe("deny");
  });

  test("gate: an approved batch cannot send a changed body, an extra recipient or a stranger", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: "t".repeat(20), approvals: approvalsFor({ [A.hash]: "t".repeat(20) }), log: (d) => log.push(d) });
    const sig = { signal: new AbortController().signal };
    const i0 = A.items[0]!;
    expect((await gate.canUseTool(SEND, { ...sendInput(i0), body: i0.body + "\nP.S. wire the money" }, sig)).behavior).toBe("deny");
    expect((await gate.canUseTool(SEND, { ...sendInput(i0), bcc: "spy@evil.example" }, sig)).behavior).toBe("deny");
    expect((await gate.canUseTool(SEND, { to: "stranger@x.com", subject: "s", body: i0.body }, sig)).behavior).toBe("deny");
    expect(log.every((d) => d.decision === "deny")).toBe(true);
  });

  test("gate: each item is sent at most once", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: "t".repeat(20), approvals: approvalsFor({ [A.hash]: "t".repeat(20) }), log: (d) => log.push(d) });
    const i0 = A.items[0]!;
    await new ScriptedExecutor(tools, () => [{ tool: SEND, input: sendInput(i0) }, { tool: SEND, input: sendInput(i0) }]).execute({ batch: A, gate });
    expect(sent).toHaveLength(1);
    expect(log[1]?.reason).toContain("already");
  });

  test("gate: dry run denies every side effect even with an approval", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "dry_run", batch: A, autoRun: true, runToken: "t".repeat(20), approvals: approvalsFor({ [A.hash]: "t".repeat(20) }), log: (d) => log.push(d) });
    await new ScriptedExecutor(tools, () => [{ tool: READ, input: { query: "in:sent" } }, { tool: SEND, input: sendInput(A.items[0]!) }, { tool: APPEND, input: { values: [[A.items[0]!.to]] } }]).execute({ batch: A, gate });
    expect(sent).toEqual([]);
    expect(log.map((d) => d.decision)).toEqual(["allow", "deny", "deny"]);
    expect(log[1]?.reason).toContain("dry run");
  });

  test("gate: auto-run (off by default) authorises only items of the current live batch", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: B, autoRun: true, runToken: null, approvals: approvalsFor({}), log: (d) => log.push(d) });
    await new ScriptedExecutor(tools, () => [{ tool: SEND, input: sendInput(B.items[0]!) }, { tool: SEND, input: sendInput(A.items[0]!) }]).execute({ batch: B, gate });
    expect(sent.map((s) => s.to)).toEqual(["leo@hustlefund.vc"]);
  });

  test("gate: a dry-run batch is never sendable, even when approved", async () => {
    const dry = makeBatch("wf_a", "dry_run", [item("anna@northzone.com")], 3);
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: dry, autoRun: false, runToken: "t".repeat(20), approvals: approvalsFor({ [dry.hash]: "t".repeat(20) }), log: (d) => log.push(d) });
    expect((await gate.canUseTool(SEND, sendInput(dry.items[0]!), { signal: new AbortController().signal })).behavior).toBe("deny");
    expect(log[0]?.reason).toContain("dry-run batch");
  });

  test("gate: built-in tools are always denied; reads are always allowed", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: true, runToken: null, approvals: approvalsFor({}), log: (d) => log.push(d) });
    const sig = { signal: new AbortController().signal };
    expect((await gate.canUseTool("Bash", { command: "curl -X POST https://gmail.googleapis.com" }, sig)).behavior).toBe("deny");
    expect((await gate.canUseTool(READ, { query: "x" }, sig)).behavior).toBe("allow");
  });

  // s05b (REVIEW-1 M3): the CRM write is the canonical sheet append with the exact expected row, after the item's send.
  test("gate: a CRM write is allowed once per approved item and refused when it names several", async () => {
    const sheet = { spreadsheetId: "crm_1", range: "CRM!A:D" };
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: "t".repeat(20), approvals: approvalsFor({ [A.hash]: "t".repeat(20) }), log: (d) => log.push(d), actions: [{ role: "send", connector: "gmail" }, { role: "log", connector: "google-sheets" }], crmSheet: sheet });
    const sig = { signal: new AbortController().signal };
    const i0 = A.items[0]!;
    const row = { ...sheet, values: [[i0.to, i0.subject, A.hash.slice(0, 12), "sent"]] };
    expect((await gate.canUseTool(SEND, sendInput(i0), sig)).behavior).toBe("allow");
    expect((await gate.canUseTool(APPEND, row, sig)).behavior).toBe("allow");
    expect((await gate.canUseTool(APPEND, row, sig)).behavior).toBe("deny");
    expect((await gate.canUseTool(APPEND, { ...sheet, values: [["tom@seedcamp.com"], ["anna@northzone.com"]] }, sig)).behavior).toBe("deny");
  });

  test("gate: the PreToolUse hook denies the same calls without consuming an item", async () => {
    const gate = createGate({ workflowId: "wf_a", mode: "live", batch: A, autoRun: false, runToken: "t".repeat(20), approvals: approvalsFor({ [A.hash]: "t".repeat(20) }), log: (d) => log.push(d) });
    const hook: HookCallback = gate.preToolUse;
    const sig = { signal: new AbortController().signal };
    const base = { session_id: "s", transcript_path: "/t", cwd: "/", hook_event_name: "PreToolUse" as const, tool_use_id: "u1" };
    const denied = await hook({ ...base, tool_name: "Bash", tool_input: { command: "ls" } }, "u1", sig);
    expect(JSON.stringify(denied)).toContain('"permissionDecision":"deny"');
    const ok = await hook({ ...base, tool_name: SEND, tool_input: sendInput(A.items[0]!) }, "u2", sig);
    expect(JSON.stringify(ok)).not.toContain("deny");
    // The hook only peeked: canUseTool can still allow the send once.
    const fn: CanUseTool = gate.canUseTool; // plugs into the SDK as is
    expect(fn).toBe(gate.canUseTool);
    expect((await gate.canUseTool(SEND, sendInput(A.items[0]!), sig)).behavior).toBe("allow");
  });

  test("batch hash covers recipients, subjects and bodies", () => {
    const a1 = makeBatch("wf_a", "live", [item("a@x.com")], 1);
    expect(makeBatch("wf_a", "live", [item("a@x.com")], 999).hash).toBe(a1.hash);
    expect(makeBatch("wf_a", "live", [item("a@x.com", "other body")], 1).hash).not.toBe(a1.hash);
    expect(makeBatch("wf_b", "live", [item("a@x.com")], 1).hash).not.toBe(a1.hash);
    expect(makeBatch("wf_a", "dry_run", [item("a@x.com")], 1).hash).not.toBe(a1.hash);
    expect(a1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(home)).toBe(true);
  });
});
