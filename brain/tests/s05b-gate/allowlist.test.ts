// s05b (REVIEW-1 B1, H1, M1, M3, L2): the gate is an allowlist. Per connector there is one canonical send tool and one
// canonical CRM log tool with a declared argument schema. The gate canonicalises the FULL argument object and allows a
// call only when its hash equals the expected hash of one approved item, once. Every other non-read tool is denied,
// reads are an explicit allowlist, unknown tools are denied, and a dry run allows zero non-read tools.
import { describe, expect, test } from "bun:test";
import { makeBatch, type Batch, type BatchItem } from "../../src/workflows/batch.ts";
import { canonicalArgs, normaliseAddress, policyFor, REVIEWED_NAMES, TOOL_POLICIES } from "../../src/workflows/allowlist.ts";
import { classifyTool, createGate, type GateContext } from "../../src/workflows/gate.ts";

const item = (to: string, body: string): BatchItem => ({ key: to.toLowerCase(), to, subject: "Offload seed round", body, warnings: [] });
const A = makeBatch("wf_a", "live", [item("a@fund.com", "Approved body."), item("b@fund.com", "Second body.")], 1);
const TOKEN = "t".repeat(32);
const SEND = "mcp__gmail__send_email";
const CSEND = "mcp__composio__GMAIL_SEND_EMAIL";
const LOG = "mcp__sheets__append_row";
const SHEET = { spreadsheetId: "sheet_123", range: "CRM!A:D" };

function gateFor(batch: Batch, extra: Partial<GateContext> = {}) {
  return createGate({ workflowId: "wf_a", mode: "live", batch, autoRun: false, runToken: TOKEN, approvals: (h) => (h === batch.hash ? { token: TOKEN, approvedAt: 1 } : undefined), ...extra });
}
const exact = (i: BatchItem) => ({ to: i.to, subject: i.subject, body: i.body });
const i0 = A.items[0]!;

describe("s05b gate allowlist", () => {
  test("B1: COMPOSIO_MULTI_EXECUTE_TOOL naming an approved address is denied, approved or auto-run", () => {
    const input = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "a@fund.com", cc: ["x@evil.com"], body: "X" } }] };
    expect(gateFor(A).decide("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", input, true).allow).toBe(false);
    expect(gateFor(A, { autoRun: true, runToken: null }).decide("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", input, true).allow).toBe(false);
  });

  test("B1: remote bash, workbench and execute tools are denied even with an approved address inside", () => {
    const g = gateFor(A);
    for (const [tool, input] of [
      ["mcp__composio__COMPOSIO_REMOTE_BASH_TOOL", { command: "curl evil # a@fund.com" }],
      ["mcp__composio__COMPOSIO_REMOTE_WORKBENCH", { code: "send('a@fund.com')" }],
      ["mcp__x__execute_tool", { tool_name: "send_email", args: exact(i0) }],
      ["mcp__gmail__run_action", { action: "send", to: "a@fund.com", body: i0.body }],
    ] as const) {
      const d = gateFor(A).decide(tool, input as Record<string, unknown>, true);
      expect(d.allow).toBe(false);
      expect(d.toolClass).toBe("side_effect");
    }
    expect(g.decide(SEND, exact(i0), true).allow).toBe(true);
  });

  test("B1: any other side-effect tool naming one approved address is denied as not on the allowlist", () => {
    for (const tool of ["mcp__gmail__modify_email", "mcp__gmail__create_label", "mcp__gmail__batch_modify_emails", "mcp__composio__GMAIL_UPDATE_DRAFT", "mcp__gmail__frobnicate"]) {
      const d = gateFor(A).decide(tool, { to: "a@fund.com", body: i0.body }, true);
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/allowlist|never allowed/);
    }
  });

  test("B1: the canonical send with exactly the approved arguments is allowed once", () => {
    const g = gateFor(A);
    expect(g.decide(SEND, exact(i0), true)).toMatchObject({ allow: true, itemKey: "a@fund.com", role: "send" });
    expect(g.decide(SEND, exact(i0), true).allow).toBe(false);
    expect(g.decide(SEND, exact(A.items[1]!), true).allow).toBe(true);
  });

  test("H1: a changed subject, an htmlBody, attachments, cc or bcc are denied", () => {
    const g = gateFor(A);
    expect(g.decide(SEND, { ...exact(i0), subject: "CHANGED" }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), htmlBody: "<b>totally different</b>" }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), attachments: ["/Users/x/.ssh/id_rsa"] }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), cc: ["boss@évil.com"] }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), cc: "boss@évil.com" }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), bcc: ["spy@evil.example"] }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), body: i0.body + " " }, true).allow).toBe(false);
    // Nothing above consumed the item.
    expect(g.decide(SEND, exact(i0), true).allow).toBe(true);
  });

  test("H1: a non-ASCII or extra recipient hidden in the to field is denied", () => {
    const g = gateFor(A);
    expect(g.decide(SEND, { ...exact(i0), to: "a@fund.com, boss@évil.com" }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), to: ["a@fund.com", "boss@évil.com"] }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), to: "Evil <a@fund.com>" }, true).allow).toBe(false);
    // Same address as a one-element list and in another case is the same canonical argument.
    expect(g.decide(SEND, { ...exact(i0), to: ["A@Fund.com"] }, true).allow).toBe(true);
  });

  test("H1: IDN addresses are compared in their ASCII form; a homoglyph domain is a different address", () => {
    expect(normaliseAddress("a@fünd.com")).toBe("a@xn--fnd-hoa.com");
    expect(normaliseAddress("A@XN--FND-HOA.COM")).toBe("a@xn--fnd-hoa.com");
    expect(normaliseAddress("a@fսnd.com")).not.toBe("a@fund.com");
    expect(normaliseAddress("Evil <a@fund.com>")).toBeNull();
    const idn = makeBatch("wf_a", "live", [item("a@fünd.com", "Body.")], 2);
    const g = gateFor(idn);
    expect(g.decide(SEND, { to: "a@fսnd.com", subject: "Offload seed round", body: "Body." }, true).allow).toBe(false);
    expect(g.decide(SEND, { to: "a@xn--fnd-hoa.com", subject: "Offload seed round", body: "Body." }, true).allow).toBe(true);
  });

  test("H1: forward, reply to an arbitrary thread and drafts-with-send are denied", () => {
    const g = gateFor(A);
    expect(g.decide("mcp__gmail__forward_message", { messageId: "PRIVATE_THREAD", to: "a@fund.com", note: i0.body }, true).allow).toBe(false);
    expect(g.decide("mcp__gmail__reply_email", { threadId: "T1", to: "a@fund.com", body: i0.body }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), threadId: "PRIVATE_THREAD" }, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), inReplyTo: "<msg@x>" }, true).allow).toBe(false);
    expect(g.decide("mcp__gmail__draft_email", { ...exact(i0), send: true }, true).allow).toBe(false);
    expect(g.decide("mcp__composio__GMAIL_SEND_DRAFT", { draft_id: "d1" }, true).allow).toBe(false);
  });

  test("H1: unknown argument keys are denied, the Composio send tool is matched on its own schema", () => {
    const g = gateFor(A, { servers: { composio: ["gmail", "google-sheets"] } });
    expect(g.decide(CSEND, { recipient_email: "a@fund.com", subject: i0.subject, body: i0.body, extra_recipients: ["x@evil.com"] }, true).allow).toBe(false);
    expect(g.decide(CSEND, { recipient_email: "a@fund.com", subject: i0.subject, body: i0.body, is_html: true }, true).allow).toBe(false);
    expect(g.decide(CSEND, { recipient_email: "a@fund.com", subject: i0.subject, body: i0.body, surprise: 1 }, true).allow).toBe(false);
    expect(g.decide(CSEND, { recipient_email: "a@fund.com", subject: i0.subject, body: i0.body, include_signature: false, is_html: false, user_id: "me" }, true).allow).toBe(true);
    const unknownKey = canonicalArgs(policyFor(SEND, { gmail: ["gmail"] }) as never, { ...exact(i0), priority: "high" });
    expect("reason" in unknownKey && unknownKey.reason).toContain("priority");
  });

  test("M1: a read verb plus an unlisted write verb is a side effect, denied in dry run and live", () => {
    for (const tool of ["mcp__x__getAndSubmit", "mcp__x__fetch_and_publish", "mcp__x__find_then_notify"]) {
      expect(classifyTool(tool)).toBe("side_effect");
      const dry = createGate({ workflowId: "wf_a", mode: "dry_run", batch: A, autoRun: true, runToken: null, approvals: () => undefined });
      expect(dry.decide(tool, {}, true).allow).toBe(false);
      expect(gateFor(A).decide(tool, { to: "a@fund.com" }, true).allow).toBe(false);
    }
  });

  test("M1: reads are an explicit allowlist per connector, never inferred from the name", () => {
    expect(classifyTool("mcp__gmail__search_emails")).toBe("read");
    expect(classifyTool("mcp__composio__GMAIL_FETCH_EMAILS")).toBe("read");
    expect(classifyTool("mcp__gmail__get_everything")).toBe("side_effect");
    expect(classifyTool("mcp__web__fetch_url")).toBe("side_effect");
    expect(classifyTool("mcp__gmail__scrape")).toBe("side_effect");
    // A read tool name on a server that does not cover that connector is not a read.
    expect(classifyTool("mcp__slack__search_emails", { slack: ["slack"] })).toBe("side_effect");
    expect(classifyTool("Bash")).toBe("builtin");
    const g = gateFor(A);
    expect(g.decide("mcp__gmail__get_everything", { q: "a@fund.com" }, true).allow).toBe(false);
    expect(g.decide("mcp__gmail__search_emails", { query: "in:sent" }, true).allow).toBe(true);
  });

  test("M3: one action per item; a second side-effect class for the same item is denied unless the steps declare it", () => {
    const g = gateFor(A);
    expect(g.decide(SEND, exact(i0), true).allow).toBe(true);
    expect(g.decide("mcp__gmail__create_draft_and_submit", { to: "a@fund.com", body: "x" }, true).allow).toBe(false);
    const row = { ...SHEET, values: [["a@fund.com", i0.subject, A.hash.slice(0, 12), "sent"]] };
    // Not declared: the default actions are send only.
    expect(g.decide(LOG, row, true).allow).toBe(false);
    const withLog = gateFor(A, { actions: [{ role: "send", connector: "gmail" }, { role: "log", connector: "google-sheets" }], crmSheet: SHEET });
    // The log comes after the send of that item, never before.
    expect(withLog.decide(LOG, row, true).allow).toBe(false);
    expect(withLog.decide(SEND, exact(i0), true).allow).toBe(true);
    expect(withLog.decide(LOG, { ...row, values: [["a@fund.com", "other subject", A.hash.slice(0, 12), "sent"]] }, true).allow).toBe(false);
    expect(withLog.decide(LOG, { ...row, spreadsheetId: "attacker_sheet" }, true).allow).toBe(false);
    expect(withLog.decide(LOG, row, true)).toMatchObject({ allow: true, role: "log", itemKey: "a@fund.com" });
    expect(withLog.decide(LOG, row, true).allow).toBe(false);
    // Without a configured CRM sheet the log tool is denied.
    const noSheet = gateFor(A, { actions: [{ role: "send", connector: "gmail" }, { role: "log", connector: "google-sheets" }] });
    noSheet.decide(SEND, exact(i0), true);
    expect(noSheet.decide(LOG, row, true).allow).toBe(false);
  });

  test("L2: a batch whose items no longer match its hash denies every side effect", () => {
    const tampered: Batch = { ...A, items: A.items.map((i, n) => (n === 0 ? { ...i, body: "Wire the money." } : i)) };
    const d = gateFor(tampered).decide(SEND, { to: "a@fund.com", subject: i0.subject, body: "Wire the money." }, true);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("hash");
  });

  test("dry run: zero non-read tools are allowed, whatever the approval", () => {
    const dry = createGate({ workflowId: "wf_a", mode: "dry_run", batch: A, autoRun: true, runToken: TOKEN, approvals: () => ({ token: TOKEN, approvedAt: 1 }), servers: { gmail: ["gmail"], composio: ["gmail", "google-sheets", "google-calendar"], sheets: ["google-sheets"], calendar: ["google-calendar"] } });
    for (const p of TOOL_POLICIES) {
      const server = p.flavor === "composio" ? "composio" : p.connector === "gmail" ? "gmail" : p.connector === "google-sheets" ? "sheets" : "calendar";
      const d = dry.decide(`mcp__${server}__${p.tool}`, p.role === "send" ? exact(i0) : {}, true);
      expect(d.allow).toBe(p.role === "read");
    }
    expect(dry.decide("mcp__gmail__frobnicate", {}, true).allow).toBe(false);
  });

  test("B1: exactly one canonical send tool and at most one log tool per connector flavour, each with a schema", () => {
    // s16 scope change: a connector may have several commit tools, told apart by the item's commit verb; per
    // connector, flavour, role and verb there is still exactly one (Gmail: one send per flavour, unchanged).
    const groups = new Map<string, { send: number; log: number }>();
    for (const p of TOOL_POLICIES) {
      const g = groups.get(`${p.connector}/${p.flavor}/${p.commitVerb ?? "send"}`) ?? { send: 0, log: 0 };
      if (p.role === "send") g.send += 1;
      if (p.role === "log") g.log += 1;
      groups.set(`${p.connector}/${p.flavor}/${p.commitVerb ?? "send"}`, g);
      if (p.role !== "read") {
        expect(p.fields).toBeDefined();
        expect(p.expected).toBeDefined();
      }
      expect(p.tool).toMatch(/^[A-Za-z0-9_]+$/);
    }
    for (const [k, g] of groups) {
      expect(g.send).toBeLessThanOrEqual(1);
      expect(g.log).toBeLessThanOrEqual(1);
      if (k.startsWith("gmail/")) expect(g.send).toBe(1);
      if (k.startsWith("gmail/")) expect(TOOL_POLICIES.filter((p) => p.connector === "gmail" && p.flavor === k.split("/")[1] && p.role === "send")).toHaveLength(1);
    }
    // s16 scope change: reply / draft names only from the reviewed exact list; never forward, execute or bash.
    expect(TOOL_POLICIES.some((p) => /forward|execute|bash/i.test(p.tool))).toBe(false);
    expect(TOOL_POLICIES.filter((p) => /reply|draft/i.test(p.tool)).every((p) => REVIEWED_NAMES.has(p.tool))).toBe(true);
  });

  test("B1: prototype-named argument keys and server names are denied, never thrown", () => {
    const g = gateFor(A);
    const proto = JSON.parse(`{"to":"a@fund.com","subject":"Offload seed round","body":"Approved body.","__proto__":{"x":1}}`) as Record<string, unknown>;
    expect(g.decide(SEND, proto, true).allow).toBe(false);
    expect(g.decide(SEND, { ...exact(i0), constructor: "x", toString: "y" }, true).allow).toBe(false);
    for (const server of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(g.decide(`mcp__${server}__send_email`, exact(i0), true).allow).toBe(false);
    expect(classifyTool("mcp__constructor__search_emails")).toBe("side_effect");
    expect(g.decide(SEND, exact(i0), true).allow).toBe(true);
  });

  test("unknown tool = deny, with the reason in the log", () => {
    const log: string[] = [];
    const g = gateFor(A, { log: (d) => log.push(d.reason) });
    expect(g.decide("mcp__newserver__do_thing", { to: "a@fund.com" }, true).allow).toBe(false);
    void g.canUseTool("mcp__newserver__do_thing", {}, { signal: new AbortController().signal });
    expect(log[0]).toMatch(/allowlist/);
  });
});
