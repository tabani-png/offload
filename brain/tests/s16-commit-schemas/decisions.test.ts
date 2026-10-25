// s16 DRAFT / DENIED / EXEC / CATALOG: the draft decision, the commits that stay denied, the Composio CLI executor
// with several commit tools per connector, and the catalog's allowedByGate.
import { describe, expect, test } from "bun:test";
import { capabilityById, candidateDTO, gateAllows } from "../../src/connectors/capabilities.ts";
import { ComposioCliExecutor, composioPolicy } from "../../src/connectors/composio.ts";
import { policyFor, REVIEWED_NAMES, TOOL_POLICIES } from "../../src/workflows/allowlist.ts";
import { makeBatch } from "../../src/workflows/batch.ts";
import type { ToolCallRecord } from "../../src/workflows/executor.ts";
import { createGate } from "../../src/workflows/gate.ts";
import { composioCli } from "../s13-connector-chain/setup.ts";
import { batchOf, CASES, SERVER, SERVERS, TOKEN, world } from "./cases.ts";

const T = (tool: string, server = SERVER) => `mcp__${server}__${tool}`;
const draft = () => CASES.GMAIL_CREATE_EMAIL_DRAFT!(batchOf);

describe("s16 drafts", () => {
  test("DRAFT: a draft in your own mailbox needs no approval token, but the exact item, once, and a declared draft step", () => {
    const c = draft();
    const w = world(c, { runToken: null, approvals: () => undefined });
    const d = w.gate.decide(T(c.tool), c.args, true);
    expect(d).toMatchObject({ allow: true, role: "draft", itemKey: c.item.key });
    expect(w.gate.decide(T(c.tool), c.args, true).reason).toContain("already");
    expect(world(c, { actions: [{ role: "send", connector: "gmail" }] }).gate.decide(T(c.tool), c.args, true).reason).toContain("declares no draft step");
  });

  test("DRAFT: a draft never marks the item sending or contacted and does not use up its send", () => {
    const c = draft();
    const w = world(c, { actions: [{ role: "draft", connector: "gmail" }, { role: "send", connector: "gmail" }] });
    expect(w.gate.decide(T(c.tool), c.args, true).allow).toBe(true);
    expect(w.journal).toEqual([{ key: c.item.key, role: "draft", tool: T(c.tool) }]);
    expect(w.gate.done.get("send")!.size).toBe(0);
    expect(w.gate.decide(T("GMAIL_SEND_EMAIL"), { recipient_email: c.item.to, subject: c.item.subject, body: c.item.body, include_signature: false }, true).allow).toBe(true);
  });

  test("DRAFT: drafts are denied in dry runs, for dry-run batches, for changed batches and for items no longer pending", () => {
    const c = draft();
    expect(world(c, { mode: "dry_run" }).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
    const dry = makeBatch("wf_s16", "dry_run", [c.item], 1);
    expect(world(c, { batch: dry }).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
    const tampered = { ...batchOf(c.item), items: [{ ...c.item, body: "Wire the money." }] };
    expect(world(c, { batch: tampered }).gate.decide(T(c.tool), { ...c.args, body: "Wire the money." }, true).allow).toBe(false);
    for (const state of ["sending", "sent", "unknown", "failed_before_send"] as const) expect(world(c, { itemState: () => state }).gate.decide(T(c.tool), c.args, true).allow).toBe(false);
  });

  test("DRAFT: a draft with cc, bcc, a thread, an attachment, another recipient or the signature is denied", () => {
    const c = draft();
    for (const extra of [{ cc: ["x@evil.com"] }, { bcc: ["x@evil.com"] }, { extra_recipients: ["x@evil.com"] }, { thread_id: "T1" }, { attachment: { name: "x" } }, { recipient_email: "x@evil.com" }, { include_signature: true }, { is_html: true }])
      expect(world(c).gate.decide(T(c.tool), { ...c.args, ...extra }, true).allow).toBe(false);
  });

  test("DRAFT: sending or updating a draft stays denied by name, also with an approval", () => {
    const w = world(draft());
    for (const t of ["GMAIL_SEND_DRAFT", "GMAIL_UPDATE_DRAFT", "OUTLOOK_SEND_DRAFT", "OUTLOOK_CREATE_DRAFT_REPLY", "OUTLOOK_CREATE_FORWARD_DRAFT", "create_draft", "draft_email"])
      expect(w.gate.decide(T(t), { draft_id: "d1" }, true).reason).toMatch(/never allowed/);
  });
});

describe("s16 still denied", () => {
  test("DENIED: campaign-wide launches, bill payments, reply-all, forward, chat.postMessage and unreviewed reply tools", () => {
    const w = world(CASES.INSTANTLY_ADD_LEADS_BULK!(batchOf));
    for (const t of ["INSTANTLY_ACTIVATE_CAMPAIGN", "SMARTLEAD_UPDATE_CAMPAIGN_STATUS", "SMARTLEAD_CREATE_CAMPAIGN", "QUICKBOOKS_CREATE_BILL_PAYMENT", "OUTLOOK_REPLY_ALL", "OUTLOOK_REPLY_EMAIL", "GMAIL_REPLY_TO_THREAD", "SLACK_CHAT_POST_MESSAGE", "SLACK_SEND_EPHEMERAL_MESSAGE", "HUBSPOT_CREATE_ENGAGEMENT", "XERO_POST_INVOICE_UPDATE", "INSTANTLY_CREATE_LEAD", "INSTANTLY_MOVE_LEADS", "ZENDESK_UPDATE_TICKET_FIELD", "INTERCOM_CREATE_A_NOTE"]) {
      expect(policyFor(T(t), SERVERS)).toHaveProperty("reason");
      expect(w.gate.decide(T(t), { id: "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab", status: "START" }, true).allow).toBe(false);
    }
  });

  test("DENIED: a reviewed reply/draft name is usable only from the static table, never as a dynamic api policy", () => {
    expect([...REVIEWED_NAMES].sort()).toEqual(["GMAIL_CREATE_EMAIL_DRAFT", "INTERCOM_REPLY_TICKET", "INTERCOM_REPLY_TO_CONVERSATION", "OUTLOOK_CREATE_DRAFT", "ZENDESK_REPLY_ZENDESK_TICKET"]);
    const dyn = { connector: "zendesk", flavor: "api" as const, tool: "ZENDESK_REPLY_ZENDESK_TICKET", role: "send" as const, verified: false, server: "api_zendesk", fields: { body: { kind: "text" as const } }, expected: () => ({ body: "x" }) };
    expect(policyFor("mcp__api_zendesk__ZENDESK_REPLY_ZENDESK_TICKET", { api_zendesk: ["zendesk"] }, {}, [dyn])).toMatchObject({ reason: expect.stringContaining("never allowed") });
    expect(TOOL_POLICIES.some((p) => /forward|execute|bash|shell|workbench|proxy/i.test(p.tool))).toBe(false);
  });

  test("DENIED: Intercom replies cannot impersonate the contact or switch to a note or an assignment", () => {
    const t = CASES.INTERCOM_REPLY_TICKET!(batchOf);
    for (const extra of [{ email: "ana@fund.com" }, { user_id: "u1" }, { intercom_user_id: "c1" }, { created_at: 1 }, { message_type: "note" }, { attachment_urls: ["https://evil/x"] }]) expect(world(t).gate.decide(T(t.tool), { ...t.args, ...extra }, true).allow).toBe(false);
    const c = CASES.INTERCOM_REPLY_TO_CONVERSATION!(batchOf);
    for (const mt of ["note", "assignment"]) expect(world(c).gate.decide(T(c.tool), { ...c.args, message_type: mt }, true).allow).toBe(false);
  });

  test("DENIED: Xero bills are ACCPAY drafts only; no InvoiceNumber, ContactName or line ids", () => {
    const c = CASES.XERO_CREATE_INVOICE!(batchOf);
    const lines = c.args.LineItems as Array<Record<string, unknown>>;
    for (const over of [{ Status: "AUTHORISED" }, { Status: "SUBMITTED" }, { Type: "ACCREC" }, { InvoiceNumber: "INV-7781" }, { ContactName: "Vendor" }, { LineItems: [{ ...lines[0], LineItemID: "x" }, lines[1]] }, { LineItems: [{ ...lines[0], DiscountRate: 10 }, lines[1]] }])
      expect(world(c).gate.decide(T(c.tool), { ...c.args, ...over }, true).allow).toBe(false);
  });

  test("DENIED: the sheet log only appends RAW values (no formula evaluation)", () => {
    const item = CASES.OUTLOOK_SEND_EMAIL!(batchOf).item;
    const b = batchOf(item);
    const sheet = { spreadsheetId: "s1", range: "CRM!A:D" };
    const g = createGate({ workflowId: "wf_s16", mode: "live", batch: b, autoRun: false, runToken: TOKEN, approvals: () => ({ token: TOKEN, approvedAt: 1 }), servers: SERVERS, actions: [{ role: "send", connector: "gmail" }, { role: "log", connector: "google-sheets" }], crmSheet: sheet, itemState: () => "sent" });
    const row = { ...sheet, values: [[item.to, item.subject, b.hash.slice(0, 12), "sent"]] };
    expect(g.decide(T("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"), { ...row, valueInputOption: "USER_ENTERED" }, false).allow).toBe(false);
    expect(g.decide(T("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"), { ...row, valueInputOption: "RAW" }, false).allow).toBe(true);
  });

  test("DENIED: Slack posts stay out of threads and without link unfurls; Zendesk replies stay public and unassigned", () => {
    const s = CASES.SLACK_SEND_MESSAGE!(batchOf);
    for (const extra of [{ thread_ts: "1.2" }, { reply_broadcast: true }, { unfurl_links: true }, { blocks: [{ type: "section" }] }, { channel: "C0OTHER" }]) expect(world(s).gate.decide(T(s.tool), { ...s.args, ...extra }, true).allow).toBe(false);
    const z = CASES.ZENDESK_REPLY_ZENDESK_TICKET!(batchOf);
    for (const extra of [{ public: false }, { assignee_id: 7 }, { ticket_id: 1 }]) expect(world(z).gate.decide(T(z.tool), { ...z.args, ...extra }, true).allow).toBe(false);
  });
});

describe("s16 Composio CLI executor", () => {
  const exec = (accounts: Record<string, string>) => {
    const runner = composioCli();
    return { runner, ex: new ComposioCliExecutor({ runner, env: { PATH: "/usr/bin" }, accounts }) };
  };

  test("EXEC: the item's verb picks the tool (Intercom ticket vs conversation) and the call runs only after an allow", async () => {
    for (const n of ["INTERCOM_REPLY_TICKET", "INTERCOM_REPLY_TO_CONVERSATION"]) {
      const c = CASES[n]!(batchOf);
      expect(composioPolicy("intercom", "send", c.item)?.tool).toBe(n);
      const w = world(c);
      const { runner, ex } = exec({ intercom: "ic_one" });
      const recs: ToolCallRecord[] = [];
      await ex.execute({ batch: w.batch, gate: w.gate, actions: [{ role: "send", connector: "intercom" }], onToolResult: (r) => void recs.push(r) });
      const run = runner.calls.filter((x) => x.argv[1] === "execute");
      expect(run).toHaveLength(1);
      expect(run[0]!.argv[2]).toBe(n);
      expect(JSON.parse(run[0]!.argv[4]!)).toEqual(c.args);
      expect(recs).toEqual([expect.objectContaining({ allowed: true, ok: true, role: "send" })]);
    }
  });

  test("EXEC: without approval nothing runs; an item no policy can express is skipped", async () => {
    const c = CASES.SLACK_SEND_MESSAGE!(batchOf);
    const w = world(c, { runToken: null, approvals: () => undefined });
    const { runner, ex } = exec({ slack: "sl_one" });
    const out = await ex.execute({ batch: w.batch, gate: w.gate, actions: [{ role: "send", connector: "slack" }] });
    expect(out.toolCalls.every((x) => !x.allowed)).toBe(true);
    expect(runner.calls.filter((x) => x.argv[1] === "execute")).toHaveLength(0);
    expect(composioPolicy("slack", "send", { ...c.item, commit: { verb: "post_message", fields: [] } })).toBeNull();
  });

  test("EXEC: a Gmail draft step runs GMAIL_CREATE_EMAIL_DRAFT with the approved draft and needs no token", async () => {
    const c = draft();
    const w = world(c, { runToken: null, approvals: () => undefined });
    const { runner, ex } = exec({ gmail: "gm_one" });
    await ex.execute({ batch: w.batch, gate: w.gate, actions: [{ role: "draft", connector: "gmail" }] });
    const run = runner.calls.filter((x) => x.argv[1] === "execute");
    expect(run.map((x) => x.argv[2])).toEqual(["GMAIL_CREATE_EMAIL_DRAFT"]);
    expect(JSON.parse(run[0]!.argv[4]!)).toEqual(c.args);
  });
});

describe("s16 catalog", () => {
  test("CATALOG: allowedByGate is true for every allowlisted commit and false for the ones that stay denied", () => {
    for (const n of Object.keys(CASES)) expect(gateAllows(n)).toBe(true);
    for (const n of ["INSTANTLY_ACTIVATE_CAMPAIGN", "SMARTLEAD_CREATE_CAMPAIGN", "HUBSPOT_CREATE_ENGAGEMENT", "SLACK_CHAT_POST_MESSAGE", "APOLLO_ADD_CONTACTS_TO_SEQUENCE", "QUICKBOOKS_CREATE_VENDOR", "CALENDLY_CANCEL_SCHEDULED_EVENT"]) expect(gateAllows(n)).toBe(false);
  });

  test("CATALOG: the send-email capability lists the Gmail and Outlook drafts as allowed commits", () => {
    const cap = capabilityById("send-email")!;
    const commits = cap.candidates.flatMap((k) => candidateDTO(k).commits);
    expect(commits).toContainEqual(expect.objectContaining({ slug: "GMAIL_CREATE_EMAIL_DRAFT", allowedByGate: true }));
    expect(commits).toContainEqual(expect.objectContaining({ slug: "OUTLOOK_CREATE_DRAFT", allowedByGate: true }));
    expect(commits).toContainEqual(expect.objectContaining({ slug: "OUTLOOK_SEND_EMAIL", allowedByGate: true }));
  });
});
