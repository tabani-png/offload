// s16: one case per new commit policy: the approved item, the exact arguments the gate must allow for it, and the
// argument paths whose value is not part of the hash (a timestamp). Everything else is checked leaf by leaf.
import { makeBatch, type Batch, type BatchItem } from "../../src/workflows/batch.ts";
import { createGate, type GateAction, type GateContext } from "../../src/workflows/gate.ts";

export const SERVER = "composio_cli";
export const TOKEN = "t".repeat(32);
export const CONNECTORS = ["gmail", "google-sheets", "outlook", "instantly", "smartlead", "hubspot", "attio", "salesforce", "xero", "quickbooks", "zendesk", "intercom", "airtable", "slack", "greenhouse"];
export const SERVERS = { [SERVER]: CONNECTORS, gmail: ["gmail"], other: ["calendly"] };

export interface Case {
  tool: string;
  connector: string;
  role: "send" | "log" | "draft";
  item: BatchItem;
  args: Record<string, unknown>;
  /** Paths (dot / index) that the hash ignores (timestamps). */
  free?: string[];
}

const TO = "ana@fund.com";
const SUBJ = "Seed round follow-up";
const BODY = "Hi Ana,\nthe deck is attached in the data room.\nBest, Sam";
const email = (): BatchItem => ({ key: TO, to: TO, subject: SUBJ, body: BODY, warnings: [] });
const commit = (verb: string, fields: Array<[string, string]>, over: Partial<BatchItem> = {}): BatchItem => ({ ...email(), ...over, key: (over.to ?? TO).toLowerCase(), commit: { verb, fields } });
const sendWith = (fields: Array<[string, string]>) => commit("send", fields);

export const BATCH12 = (b: Batch) => b.hash.slice(0, 12);
export const note = (i: BatchItem, b: Batch) => `Offload sent "${i.subject}" to ${i.to} (batch ${BATCH12(b)}).`;

/** Args may depend on the batch hash (CRM notes). */
export type CaseFn = (b: (item: BatchItem) => Batch) => Case;

export const CASES: Record<string, CaseFn> = {
  GMAIL_CREATE_EMAIL_DRAFT: () => ({ tool: "GMAIL_CREATE_EMAIL_DRAFT", connector: "gmail", role: "draft", item: email(), args: { recipient_email: TO, subject: SUBJ, body: BODY, include_signature: false } }),
  OUTLOOK_SEND_EMAIL: () => ({ tool: "OUTLOOK_SEND_EMAIL", connector: "outlook", role: "send", item: email(), args: { to: TO, subject: SUBJ, body: BODY, is_html: false } }),
  OUTLOOK_CREATE_DRAFT: () => ({ tool: "OUTLOOK_CREATE_DRAFT", connector: "outlook", role: "draft", item: email(), args: { to_recipients: [TO], subject: SUBJ, body: BODY, is_html: false } }),
  INSTANTLY_ADD_LEADS_BULK: () => {
    const item = commit("add_to_campaign", [["campaign_id", "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab"], ["first_name", "Ana"], ["company_name", "Fund"]]);
    return { tool: "INSTANTLY_ADD_LEADS_BULK", connector: "instantly", role: "send", item, args: { campaign_id: "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab", leads: [{ email: TO, first_name: "Ana", company_name: "Fund" }], skip_if_in_campaign: true, verify: false } };
  },
  SMARTLEAD_SEND_SINGLE_EMAIL: () => {
    const item = sendWith([["from_email", "sam@startup.io"], ["from_name", "Sam"]]);
    return { tool: "SMARTLEAD_SEND_SINGLE_EMAIL", connector: "smartlead", role: "send", item, args: { to: TO, subject: SUBJ, body: BODY, from_email: "sam@startup.io", from_name: "Sam" } };
  },
  SMARTLEAD_RESUME_CAMPAIGN_LEAD: () => {
    const item = commit("resume_lead", [["campaign_id", "4411"], ["lead_id", "99812"]]);
    return { tool: "SMARTLEAD_RESUME_CAMPAIGN_LEAD", connector: "smartlead", role: "send", item, args: { campaign_id: 4411, lead_id: 99812 } };
  },
  HUBSPOT_CREATE_NOTE: (b) => {
    const item = sendWith([["hubspot.contact_id", "51234"]]);
    return {
      tool: "HUBSPOT_CREATE_NOTE",
      connector: "hubspot",
      role: "log",
      item,
      args: { hs_note_body: note(item, b(item)), hs_timestamp: "2026-10-25T09:30:00Z", associations: [{ to: { id: "51234" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] },
      free: ["hs_timestamp"],
    };
  },
  ATTIO_CREATE_NOTE: (b) => {
    const item = sendWith([["attio.record_id", "6f1c1b7e-8d2a-4e55-9a0b-0c1d2e3f4a5b"]]);
    return { tool: "ATTIO_CREATE_NOTE", connector: "attio", role: "log", item, args: { parent_object: "people", parent_record_id: "6f1c1b7e-8d2a-4e55-9a0b-0c1d2e3f4a5b", title: `Offload: ${SUBJ}`, content: note(item, b(item)) } };
  },
  SALESFORCE_CREATE_TASK: (b) => {
    const item = sendWith([["salesforce.who_id", "003Dn00000AbCdEIAV"]]);
    return { tool: "SALESFORCE_CREATE_TASK", connector: "salesforce", role: "log", item, args: { subject: `Email: ${SUBJ}`, who_id: "003Dn00000AbCdEIAV", description: note(item, b(item)), status: "Completed" } };
  },
  XERO_CREATE_INVOICE: () => {
    const item = commit("create_bill", [
      ["tenant_id", "c3a1-tenant"],
      ["contact_id", "5b96e86b-418e-48e8-8949-308c14aec278"],
      ["date", "2026-10-20"],
      ["due_date", "2026-11-19"],
      ["reference", "INV-7781"],
      ["currency", "GBP"],
      ["line.1.description", "October hosting"],
      ["line.1.quantity", "1"],
      ["line.1.unit_amount", "420.50"],
      ["line.1.account_code", "429"],
      ["line.1.tax_type", "INPUT2"],
      ["line.2.description", "Support hours"],
      ["line.2.quantity", "3"],
      ["line.2.unit_amount", "80"],
      ["line.2.account_code", "429"],
    ], { to: "bills@vendor.com", subject: "Bill INV-7781", body: "" });
    return {
      tool: "XERO_CREATE_INVOICE",
      connector: "xero",
      role: "send",
      item,
      args: {
        Type: "ACCPAY",
        Status: "DRAFT",
        tenant_id: "c3a1-tenant",
        ContactID: "5b96e86b-418e-48e8-8949-308c14aec278",
        Date: "2026-10-20",
        DueDate: "2026-11-19",
        Reference: "INV-7781",
        CurrencyCode: "GBP",
        LineItems: [
          { Description: "October hosting", Quantity: 1, UnitAmount: 420.5, AccountCode: "429", TaxType: "INPUT2" },
          { Description: "Support hours", Quantity: 3, UnitAmount: 80, AccountCode: "429" },
        ],
      },
    };
  },
  QUICKBOOKS_CREATE_BILL: () => {
    const item = commit("create_bill", [["vendor_id", "56"], ["txn_date", "2026-10-20"], ["doc_number", "INV-7781"], ["line.1.amount", "420.50"], ["line.1.description", "October hosting"], ["line.1.account_id", "7"]], { to: "bills@vendor.com", subject: "Bill INV-7781", body: "" });
    return {
      tool: "QUICKBOOKS_CREATE_BILL",
      connector: "quickbooks",
      role: "send",
      item,
      args: { VendorRef: { value: "56" }, TxnDate: "2026-10-20", DocNumber: "INV-7781", Line: [{ DetailType: "AccountBasedExpenseLineDetail", Amount: 420.5, Description: "October hosting", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }] },
    };
  },
  ZENDESK_REPLY_ZENDESK_TICKET: () => {
    const item = commit("reply_ticket", [["ticket_id", "35436"]]);
    return { tool: "ZENDESK_REPLY_ZENDESK_TICKET", connector: "zendesk", role: "send", item, args: { ticket_id: 35436, body: BODY, public: true } };
  },
  INTERCOM_REPLY_TO_CONVERSATION: () => {
    const item = commit("reply_conversation", [["conversation_id", "147"], ["admin_id", "991"]]);
    return { tool: "INTERCOM_REPLY_TO_CONVERSATION", connector: "intercom", role: "send", item, args: { conversation_id: "147", admin_id: "991", message_body: BODY, message_type: "comment" } };
  },
  INTERCOM_REPLY_TICKET: () => {
    const item = commit("reply_ticket", [["ticket_id", "22"], ["admin_id", "991"]]);
    return { tool: "INTERCOM_REPLY_TICKET", connector: "intercom", role: "send", item, args: { ticket_id: "22", admin_id: "991", body: BODY, message_type: "comment" } };
  },
  AIRTABLE_CREATE_RECORD: () => {
    const item = commit("create_record", [["base_id", "appAbC123"], ["table", "Leads"], ["field.Email", TO], ["field.Stage", "Contacted"]]);
    return { tool: "AIRTABLE_CREATE_RECORD", connector: "airtable", role: "send", item, args: { baseId: "appAbC123", tableIdOrName: "Leads", fields: { Email: TO, Stage: "Contacted" }, typecast: false } };
  },
  SLACK_SEND_MESSAGE: () => {
    const item = commit("post_message", [["channel", "C0123ABC"]]);
    return { tool: "SLACK_SEND_MESSAGE", connector: "slack", role: "send", item, args: { channel: "C0123ABC", markdown_text: BODY, unfurl_links: false, unfurl_media: false } };
  },
  GREENHOUSE_MOVE_APPLICATION: () => {
    const item = commit("move_stage", [["application_id", "69102"], ["from_stage_id", "11"], ["to_stage_id", "12"]], { to: "cand@mail.com", subject: "Move to onsite", body: "" });
    return { tool: "GREENHOUSE_MOVE_APPLICATION", connector: "greenhouse", role: "send", item, args: { id: 69102, from_stage_id: 11, to_stage_id: 12 } };
  },
};

export const batchOf = (item: BatchItem) => makeBatch("wf_s16", "live", [item], 1);

export function world(c: Case, extra: Partial<GateContext> = {}) {
  const batch = batchOf(c.item);
  const journal: Array<{ key: string; role: string; tool: string }> = [];
  const actions: GateAction[] = [{ role: c.role, connector: c.connector }];
  if (c.role === "log") actions.push({ role: "send", connector: "gmail" });
  const gate = createGate({
    workflowId: "wf_s16",
    mode: "live",
    batch,
    autoRun: false,
    runToken: TOKEN,
    approvals: (h) => (h === batch.hash ? { token: TOKEN, approvedAt: 1 } : undefined),
    servers: SERVERS,
    actions,
    // A log comes only after its send: the item was sent in an earlier run.
    itemState: () => (c.role === "log" ? "sent" : "pending"),
    onAllow: (key, role, tool) => journal.push({ key, role, tool }),
    ...extra,
  });
  return { gate, batch, journal };
}

/** Every leaf of `x` with a path. */
export function leaves(x: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (Array.isArray(x)) return x.flatMap((v, i) => leaves(v, `${path}${path === "" ? "" : "."}${i}`));
  if (typeof x === "object" && x !== null) return Object.entries(x).flatMap(([k, v]) => leaves(v, `${path}${path === "" ? "" : "."}${k}`));
  return [{ path, value: x }];
}

/** A deep copy of `x` with the leaf at `path` replaced. */
export function withLeaf(x: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(x)) as Record<string, unknown>;
  const parts = path.split(".");
  let cur: Record<string, unknown> | unknown[] = copy;
  for (const p of parts.slice(0, -1)) cur = (cur as Record<string, unknown>)[p] as Record<string, unknown>;
  (cur as Record<string, unknown>)[parts[parts.length - 1]!] = value;
  return copy;
}

export const mutate = (v: unknown): unknown => (typeof v === "string" ? (v.includes("@") ? `x${v}` : `${v}9`) : typeof v === "number" ? v + 1 : typeof v === "boolean" ? !v : "changed");
