// The tool allowlist the approval gate enforces (REVIEW-1 B1, H1, M1). Per connector and server flavour there is
// exactly one canonical send tool, at most one canonical CRM log tool, and an explicit list of read tools. Each
// side-effect tool declares its full argument schema. The gate canonicalises the whole argument object with that
// schema (sorted keys, normalised addresses incl. IDN, normalised text) and compares its hash with the hash of the
// arguments it expects for an approved item. Anything not listed here is denied: unknown tools, meta/multiplexer
// tools, shells, forward, and reply / draft tools other than the exact names reviewed in s16 (REVIEWED_NAMES).
// s16 adds verified commit policies for the tools workflows need first (Composio schemas read with `--get-schema`,
// recorded in tests/s16-commit-schemas/fixtures): every non-email value comes from the approved item's commit fields.
// Tool names marked `verified: false` were taken from the servers' docs and are
// not yet checked against a live Gmail MCP / Composio account (brain/CONNECTORS.md); a renamed tool fails closed.
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type { BatchItem } from "./batch.ts";

/** read: no side effect. input (s13, computer use only): a local, reversible UI edit (focus a field, type into it)
 * that needs an approved batch but never uses up an item. send: the item's one commit (send, submit, save, pay, post,
 * ... for every method). log: the CRM record of an item, only after its send. */
export type Role = "read" | "input" | "send" | "log" | "draft";
// s16 draft: a draft in the user's own mailbox (ADR 0006: not an external action). Needs a live, intact batch, a declared
// draft step and the exact item, once; no approval token, never marks the item sending.
/** s13 adds api (a direct HTTP operation from connectors.json `apis`) and computer (computer use). Composio's CLI path
 * reuses the composio policies under the server name `composio_cli`. */
export type Flavor = "gmail-mcp" | "composio" | "sheets-mcp" | "calendar-mcp" | "api" | "computer";

/** How one argument is checked and canonicalised. */
export type FieldSpec =
  /** Recipient list: a string (comma/semicolon separated) or an array; normalised, sorted. Required when expected. */
  | { kind: "addresses" }
  /** Free text (subject, body): NFC, CRLF -> LF, otherwise exact. */
  | { kind: "text" }
  /** An id that must equal the configured value exactly (spreadsheet id, range). */
  | { kind: "id" }
  /** Rows of cells: string[][], each cell text-normalised. */
  | { kind: "rows" }
  /** Optional; when present it must be one of `values`. Dropped from the canonical form. */
  | { kind: "fixed"; values: readonly (string | number | boolean)[] }
  /** s16: required and must equal `value` exactly. Dropped from the canonical form. */
  | { kind: "const"; value: string | number | boolean }
  /** s16: a non-negative integer, or a string of digits; canonical as its decimal string. */
  | { kind: "int" }
  /** s16: a finite decimal number, or a plain decimal string ("420.50"); canonical as the shortest decimal. */
  | { kind: "number" }
  /** s16: a calendar date YYYY-MM-DD; kept. */
  | { kind: "date" }
  /** s16: a timestamp (ISO-8601 UTC or epoch milliseconds) that is not part of what was approved; dropped. */
  | { kind: "time" }
  /** s16: a nested object with its own schema (unknown keys refused). */
  | { kind: "object"; fields: Readonly<Record<string, FieldSpec>> }
  /** s16: a list of 1..max entries, order kept. */
  | { kind: "list"; of: FieldSpec; max: number }
  /** s16: a record of field name -> scalar value (Airtable fields); every key and value is compared. */
  | { kind: "map" }
  /** Optional; when present it must be empty ("", [], null). Anything else is refused by name. */
  | { kind: "empty" }
  /** Read tools: any value (reads are not matched to items). */
  | { kind: "any" };

export interface CrmSheet {
  spreadsheetId: string;
  range: string;
}

export interface ToolPolicy {
  connector: string;
  flavor: Flavor;
  tool: string;
  role: Role;
  /** Checked against a live server on this machine (s13: the Composio tools against the live CLI schema). */
  verified: boolean;
  /** s13: a dynamic policy (api operation, computer use) applies only to calls on this server name. A server with
   * bound policies resolves only those; the static table never applies to it. */
  server?: string;
  /** s16: the commit verb an item must carry for this tool (item.commit.verb). Absent = an email item (no commit, or
   * verb "send"). Checked for static send and draft policies, so one approved item fits at most one tool. */
  commitVerb?: string;
  /** Side-effect tools only: every key the tool may receive. Unknown keys are refused. */
  fields?: Readonly<Record<string, FieldSpec>>;
  /** The arguments the gate expects for one approved item (before canonicalisation). null = cannot be built. */
  expected?: (item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }) => Record<string, unknown> | null;
}

const GMAIL_MCP_SEND_FIELDS: Record<string, FieldSpec> = {
  to: { kind: "addresses" },
  subject: { kind: "text" },
  body: { kind: "text" },
  cc: { kind: "empty" },
  bcc: { kind: "empty" },
  htmlBody: { kind: "empty" },
  attachments: { kind: "empty" },
  threadId: { kind: "empty" },
  inReplyTo: { kind: "empty" },
  references: { kind: "empty" },
  messageId: { kind: "empty" },
  mimeType: { kind: "fixed", values: ["text/plain"] },
};

const COMPOSIO_SEND_FIELDS: Record<string, FieldSpec> = {
  recipient_email: { kind: "addresses" },
  subject: { kind: "text" },
  body: { kind: "text" },
  cc: { kind: "empty" },
  bcc: { kind: "empty" },
  extra_recipients: { kind: "empty" },
  attachment: { kind: "empty" },
  thread_id: { kind: "empty" },
  // s13: in the live schema (composio execute GMAIL_SEND_EMAIL --get-schema, 2026-10-25). A different sender or an
  // appended signature would change what the user approved, so only empty / false. include_signature is required:
  // Composio defaults it to true, so leaving it out would append the signature to approved mail.
  from_email: { kind: "empty" },
  include_signature: { kind: "const", value: false },
  is_html: { kind: "fixed", values: [false] },
  user_id: { kind: "fixed", values: ["me"] },
};

const SHEET_APPEND_FIELDS: Record<string, FieldSpec> = {
  spreadsheetId: { kind: "id" },
  range: { kind: "id" },
  values: { kind: "rows" },
  // s16: RAW only. USER_ENTERED evaluates a cell that starts with "=" (an approved subject) as a formula.
  valueInputOption: { kind: "fixed", values: ["RAW"] },
  insertDataOption: { kind: "fixed", values: ["INSERT_ROWS"] },
};

/** The CRM row the log tool may append for an item: no timestamp, so it is fixed at approval time. */
export const crmRow = (item: BatchItem, batchHash: string): string[] => [item.to, item.subject, batchHash.slice(0, 12), "sent"];

const sheetRow = (item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }) =>
  ctx.crmSheet === undefined ? null : { spreadsheetId: ctx.crmSheet.spreadsheetId, range: ctx.crmSheet.range, values: [crmRow(item, ctx.batchHash)] };

/** s16: Composio requires valueInputOption (live schema), so the deterministic executor sends it. */
const composioSheetRow = (item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }) => {
  const r = sheetRow(item, ctx);
  return r === null ? null : { ...r, valueInputOption: "RAW" };
};

const read = (connector: string, flavor: Flavor, tool: string, verified = false): ToolPolicy => ({ connector, flavor, tool, role: "read", verified });

// ---------- s16: verified commit policies ----------
// Every schema below was read read-only on 2026-10-25 with `composio execute <SLUG> --get-schema` (composio CLI 0.4.2)
// and is recorded in tests/s16-commit-schemas/fixtures/composio-schemas.json. Every argument the live schema offers
// that is not needed is either refused (`empty`) or pinned (`fixed` / `const`); the hash-bound values come from the
// approved item: to / subject / body, and for non-email commits the labelled commit fields (inside the batch hash,
// shown at review). A missing label = the item cannot be expressed = denied.

const E: FieldSpec = { kind: "empty" };
const T: FieldSpec = { kind: "text" };
const ID: FieldSpec = { kind: "id" };
const INT: FieldSpec = { kind: "int" };
const NUM: FieldSpec = { kind: "number" };
const DATE: FieldSpec = { kind: "date" };
const ADDR: FieldSpec = { kind: "addresses" };
const konst = (value: string | number | boolean): FieldSpec => ({ kind: "const", value });
const fixed = (...values: Array<string | number | boolean>): FieldSpec => ({ kind: "fixed", values });
const obj = (fields: Record<string, FieldSpec>): FieldSpec => ({ kind: "object", fields });
const list = (of: FieldSpec, max: number): FieldSpec => ({ kind: "list", of, max });

/** The value of a labelled commit field of the approved item, or undefined. */
export const commitField = (item: BatchItem, label: string): string | undefined => item.commit?.fields.find(([l]) => l === label)?.[1];
const digits = (s: string | undefined) => (s !== undefined && /^[0-9]{1,18}$/.test(s) ? Number(s) : undefined);
const decimal = (s: string | undefined) => (s !== undefined && /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/.test(s) ? Number(s) : undefined);
const present = (s: string | undefined): s is string => s !== undefined && s !== "";
/** Copies the commit fields that are present into `out` under their argument names. */
function optional(item: BatchItem, out: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  for (const [arg, label] of Object.entries(map)) {
    const v = commitField(item, label);
    if (present(v)) out[arg] = v;
  }
  return out;
}
/** Lines `line.<n>.<field>` of a commit, in numeric order of n (1..50). */
function commitLines(item: BatchItem): Array<Record<string, string>> {
  const by = new Map<number, Record<string, string>>();
  for (const [label, value] of item.commit?.fields ?? []) {
    const m = /^line\.([1-9][0-9]?)\.([a-z_]+)$/.exec(label);
    if (m === null) continue;
    const n = Number(m[1]);
    by.set(n, { ...by.get(n), [m[2]!]: value });
  }
  return [...by.entries()].sort(([a], [b]) => a - b).map(([, l]) => l);
}

/** The CRM note text for an item's log: what was sent, to whom, which batch. Never the body. */
export const crmNote = (item: BatchItem, batchHash: string): string => `Offload sent "${item.subject}" to ${item.to} (batch ${batchHash.slice(0, 12)}).`;

const composio = (connector: string, tool: string, role: Role, fields: Record<string, FieldSpec>, expected: NonNullable<ToolPolicy["expected"]>, commitVerb?: string): ToolPolicy => ({
  connector,
  flavor: "composio",
  tool,
  role,
  verified: true,
  fields,
  expected,
  ...(commitVerb === undefined ? {} : { commitVerb }),
});

const S16_POLICIES: readonly ToolPolicy[] = [
  // Gmail draft (role draft): the approved email as a draft in the user's own mailbox. Sending a draft stays denied.
  composio(
    "gmail",
    "GMAIL_CREATE_EMAIL_DRAFT",
    "draft",
    { recipient_email: ADDR, subject: T, body: T, include_signature: konst(false), is_html: fixed(false), user_id: fixed("me"), cc: E, bcc: E, extra_recipients: E, attachment: E, thread_id: E },
    (i) => ({ recipient_email: i.to, subject: i.subject, body: i.body, include_signature: false }),
  ),
  // Outlook (Microsoft Graph through Composio): send from the connected mailbox itself, and drafts.
  composio(
    "outlook",
    "OUTLOOK_SEND_EMAIL",
    "send",
    { to: ADDR, subject: T, body: T, is_html: konst(false), user_id: fixed("me"), save_to_sent_items: fixed(true), to_name: E, cc_emails: E, bcc_emails: E, attachment: E, from_address: E },
    (i) => ({ to: i.to, subject: i.subject, body: i.body, is_html: false }),
  ),
  composio(
    "outlook",
    "OUTLOOK_CREATE_DRAFT",
    "draft",
    { to_recipients: ADDR, subject: T, body: T, is_html: konst(false), cc_recipients: E, bcc_recipients: E, attachment: E, user_id: E },
    (i) => ({ to_recipients: [i.to], subject: i.subject, body: i.body, is_html: false }),
  ),
  // Instantly: the approved lead into the approved campaign (the per-item commit: an active campaign then emails it).
  // Activating a campaign is NOT here: it sends to every lead in the campaign, which no item hash can bind.
  composio(
    "instantly",
    "INSTANTLY_ADD_LEADS_BULK",
    "send",
    {
      campaign_id: ID,
      leads: list(obj({ email: ADDR, first_name: T, last_name: T, company_name: T, personalization: T, phone: E, website: E, company_domain: E, custom_variables: E }), 1),
      skip_if_in_campaign: konst(true),
      verify: konst(false),
      verify_leadfinder: fixed(false),
      skip_if_in_list: fixed(true, false),
      skip_if_in_workspace: fixed(true, false),
      list_id: E,
      blocklist_id: E,
    },
    (i) => {
      const campaign = commitField(i, "campaign_id");
      if (!present(campaign)) return null;
      const lead = optional(i, { email: i.to }, { first_name: "first_name", last_name: "last_name", company_name: "company_name", personalization: "personalization" });
      return { campaign_id: campaign, leads: [lead], skip_if_in_campaign: true, verify: false };
    },
    "add_to_campaign",
  ),
  // Smartlead: one email from the approved sender account; resume one approved paused lead. Starting a campaign
  // (campaign status START) stays denied for the same reason as Instantly's activation.
  composio(
    "smartlead",
    "SMARTLEAD_SEND_SINGLE_EMAIL",
    "send",
    { to: ADDR, subject: T, body: T, from_email: ADDR, from_name: T, from_email_id: E, reply_to: E, attachments: E },
    (i) => {
      const from = commitField(i, "from_email");
      return present(from) ? optional(i, { to: i.to, subject: i.subject, body: i.body, from_email: from }, { from_name: "from_name" }) : null;
    },
  ),
  composio(
    "smartlead",
    "SMARTLEAD_RESUME_CAMPAIGN_LEAD",
    "send",
    { campaign_id: INT, lead_id: INT, resume_lead_with_delay_days: E },
    (i) => {
      const campaign = digits(commitField(i, "campaign_id"));
      const lead = digits(commitField(i, "lead_id"));
      return campaign === undefined || lead === undefined ? null : { campaign_id: campaign, lead_id: lead };
    },
    "resume_lead",
  ),
  // CRM logs (role log, after the item's send): a fixed note on the record the item names.
  composio(
    "hubspot",
    "HUBSPOT_CREATE_NOTE",
    "log",
    {
      hs_note_body: T,
      hs_timestamp: { kind: "time" },
      associations: list(obj({ to: obj({ id: ID }), types: list(obj({ associationCategory: konst("HUBSPOT_DEFINED"), associationTypeId: konst(202) }), 1) }), 1),
      hubspot_owner_id: E,
      custom_properties: E,
      hs_attachment_ids: E,
    },
    (i, ctx) => {
      const contact = commitField(i, "hubspot.contact_id");
      if (!present(contact)) return null;
      // 202 = note to contact (HubSpot-defined association type).
      return { hs_note_body: crmNote(i, ctx.batchHash), hs_timestamp: new Date().toISOString(), associations: [{ to: { id: contact }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] };
    },
  ),
  composio("attio", "ATTIO_CREATE_NOTE", "log", { parent_object: konst("people"), parent_record_id: ID, title: T, content: T, created_at: E }, (i, ctx) => {
    const record = commitField(i, "attio.record_id");
    return present(record) ? { parent_object: "people", parent_record_id: record, title: `Offload: ${i.subject}`, content: crmNote(i, ctx.batchHash) } : null;
  }),
  composio(
    "salesforce",
    "SALESFORCE_CREATE_TASK",
    "log",
    { subject: T, who_id: ID, description: T, status: konst("Completed"), priority: fixed("Normal"), is_reminder_set: fixed(false), what_id: E, owner_id: E, activity_date: E, custom_fields: E, reminder_date_time: E, composio_execution_message: E },
    (i, ctx) => {
      const who = commitField(i, "salesforce.who_id");
      return present(who) ? { subject: `Email: ${i.subject}`, who_id: who, description: crmNote(i, ctx.batchHash), status: "Completed" } : null;
    },
  ),
  // Bills. Xero: a bill is an ACCPAY invoice, created as DRAFT only (authorising posts to the ledger: a human step in
  // Xero). InvoiceNumber is refused (a matching number updates an existing invoice); tenant_id is required.
  composio(
    "xero",
    "XERO_CREATE_INVOICE",
    "send",
    {
      Type: konst("ACCPAY"),
      Status: konst("DRAFT"),
      tenant_id: ID,
      ContactID: ID,
      Date: DATE,
      DueDate: DATE,
      Reference: T,
      CurrencyCode: ID,
      LineItems: list(
        obj({ Description: T, Quantity: NUM, UnitAmount: NUM, AccountCode: ID, TaxType: ID, ItemCode: E, Tracking: E, AccountID: E, TaxAmount: E, LineAmount: E, LineItemID: E, DiscountRate: E, DiscountAmount: E }),
        50,
      ),
      ContactName: E,
      InvoiceNumber: E,
    },
    (i) => {
      const tenant = commitField(i, "tenant_id");
      const contact = commitField(i, "contact_id");
      const lines = commitLines(i);
      if (!present(tenant) || !present(contact) || lines.length === 0) return null;
      const items: Array<Record<string, unknown>> = [];
      for (const l of lines) {
        const q = decimal(l.quantity);
        const u = decimal(l.unit_amount);
        if (!present(l.description) || q === undefined || u === undefined || !present(l.account_code)) return null;
        items.push({ Description: l.description, Quantity: q, UnitAmount: u, AccountCode: l.account_code, ...(present(l.tax_type) ? { TaxType: l.tax_type } : {}) });
      }
      return optional(i, { Type: "ACCPAY", Status: "DRAFT", tenant_id: tenant, ContactID: contact, LineItems: items }, { Date: "date", DueDate: "due_date", Reference: "reference", CurrencyCode: "currency" });
    },
    "create_bill",
  ),
  // QuickBooks has no draft bill: a created bill is on A/P (a commit). Bill payments stay denied.
  composio(
    "quickbooks",
    "QUICKBOOKS_CREATE_BILL",
    "send",
    {
      VendorRef: obj({ value: ID, name: E }),
      Line: list(
        obj({
          DetailType: konst("AccountBasedExpenseLineDetail"),
          Amount: NUM,
          Description: T,
          AccountBasedExpenseLineDetail: obj({ AccountRef: obj({ value: ID, name: E }), ClassRef: E, TaxCodeRef: E, CustomerRef: E, BillableStatus: E }),
          LineNum: E,
          ItemBasedExpenseLineDetail: E,
        }),
        50,
      ),
      TxnDate: DATE,
      DueDate: DATE,
      DocNumber: T,
      CurrencyRef: E,
      PrivateNote: E,
      APAccountRef: E,
      ExchangeRate: E,
      SalesTermRef: E,
      minorversion: E,
      DepartmentRef: E,
      GlobalTaxCalculation: E,
    },
    (i) => {
      const vendor = commitField(i, "vendor_id");
      const lines = commitLines(i);
      if (!present(vendor) || lines.length === 0) return null;
      const out: Array<Record<string, unknown>> = [];
      for (const l of lines) {
        const amount = decimal(l.amount);
        if (amount === undefined || !present(l.account_id)) return null;
        out.push({ DetailType: "AccountBasedExpenseLineDetail", Amount: amount, ...(present(l.description) ? { Description: l.description } : {}), AccountBasedExpenseLineDetail: { AccountRef: { value: l.account_id } } });
      }
      return optional(i, { VendorRef: { value: vendor }, Line: out }, { TxnDate: "txn_date", DueDate: "due_date", DocNumber: "doc_number" });
    },
    "create_bill",
  ),
  // Support replies: the approved body on the approved ticket / conversation, as the approved admin, public only.
  composio(
    "zendesk",
    "ZENDESK_REPLY_ZENDESK_TICKET",
    "send",
    { ticket_id: INT, body: T, public: konst(true), assignee_id: E },
    (i) => {
      const ticket = digits(commitField(i, "ticket_id"));
      return ticket === undefined ? null : { ticket_id: ticket, body: i.body, public: true };
    },
    "reply_ticket",
  ),
  composio(
    "intercom",
    "INTERCOM_REPLY_TO_CONVERSATION",
    "send",
    { conversation_id: ID, admin_id: ID, message_body: T, message_type: konst("comment"), attachment_urls: E },
    (i) => {
      const conv = commitField(i, "conversation_id");
      const admin = commitField(i, "admin_id");
      return present(conv) && present(admin) ? { conversation_id: conv, admin_id: admin, message_body: i.body, message_type: "comment" } : null;
    },
    "reply_conversation",
  ),
  composio(
    "intercom",
    "INTERCOM_REPLY_TICKET",
    "send",
    // email / user_id / intercom_user_id would reply AS the contact: refused.
    { ticket_id: ID, admin_id: ID, body: T, message_type: konst("comment"), email: E, user_id: E, intercom_user_id: E, created_at: E, attachment_urls: E },
    (i) => {
      const ticket = commitField(i, "ticket_id");
      const admin = commitField(i, "admin_id");
      return present(ticket) && present(admin) ? { ticket_id: ticket, admin_id: admin, body: i.body, message_type: "comment" } : null;
    },
    "reply_ticket",
  ),
  // A row in a table: the approved fields (`field.<name>` labels) in the approved base and table.
  composio(
    "airtable",
    "AIRTABLE_CREATE_RECORD",
    "send",
    { baseId: ID, tableIdOrName: ID, fields: { kind: "map" }, typecast: konst(false), returnFieldsByFieldId: fixed(false) },
    (i) => {
      const base = commitField(i, "base_id");
      const table = commitField(i, "table");
      const fields: Record<string, string> = {};
      for (const [l, v] of i.commit?.fields ?? []) if (l.startsWith("field.") && l.length > 6) fields[l.slice(6)] = v;
      return present(base) && present(table) && Object.keys(fields).length > 0 ? { baseId: base, tableIdOrName: table, fields, typecast: false } : null;
    },
    "create_record",
  ),
  // A team message: the approved body in the approved channel, not in a thread, no link unfurls.
  composio(
    "slack",
    "SLACK_SEND_MESSAGE",
    "send",
    { channel: ID, markdown_text: T, unfurl_links: konst(false), unfurl_media: konst(false), reply_broadcast: fixed(false), blocks: E, fallback_text: E, thread_ts: E },
    (i) => {
      const channel = commitField(i, "channel");
      return present(channel) ? { channel, markdown_text: i.body, unfurl_links: false, unfurl_media: false } : null;
    },
    "post_message",
  ),
  // An application to the approved next stage of the same job (no job transfer, no notification sender).
  composio(
    "greenhouse",
    "GREENHOUSE_MOVE_APPLICATION",
    "send",
    { id: INT, from_stage_id: INT, to_stage_id: INT, to_job_id: E, email_from_user_id: E },
    (i) => {
      const id = digits(commitField(i, "application_id"));
      const from = digits(commitField(i, "from_stage_id"));
      const to = digits(commitField(i, "to_stage_id"));
      return id === undefined || from === undefined || to === undefined ? null : { id, from_stage_id: from, to_stage_id: to };
    },
    "move_stage",
  ),
];

export const TOOL_POLICIES: readonly ToolPolicy[] = [
  // Gmail through a local Gmail MCP server (@gongrzhe/server-gmail-autoauth-mcp).
  { connector: "gmail", flavor: "gmail-mcp", tool: "send_email", role: "send", verified: false, fields: GMAIL_MCP_SEND_FIELDS, expected: (i) => ({ to: [i.to], subject: i.subject, body: i.body }) },
  read("gmail", "gmail-mcp", "search_emails"),
  read("gmail", "gmail-mcp", "read_email"),
  read("gmail", "gmail-mcp", "list_email_labels"),
  // Gmail through Composio.
  { connector: "gmail", flavor: "composio", tool: "GMAIL_SEND_EMAIL", role: "send", verified: true, fields: COMPOSIO_SEND_FIELDS, expected: (i) => ({ recipient_email: i.to, subject: i.subject, body: i.body, include_signature: false }) },
  read("gmail", "composio", "GMAIL_FETCH_EMAILS", true),
  read("gmail", "composio", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", true),
  // The CRM sheet: one append tool per flavour.
  { connector: "google-sheets", flavor: "composio", tool: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", role: "log", verified: true, fields: SHEET_APPEND_FIELDS, expected: composioSheetRow },
  { connector: "google-sheets", flavor: "sheets-mcp", tool: "append_row", role: "log", verified: false, fields: SHEET_APPEND_FIELDS, expected: sheetRow },
  // Calendar (scheduling replies): reads only.
  read("google-calendar", "composio", "GOOGLECALENDAR_FIND_FREE_SLOTS", true),
  read("google-calendar", "composio", "GOOGLECALENDAR_EVENTS_LIST", true),
  read("google-calendar", "calendar-mcp", "find_free_slots"),
  ...S16_POLICIES,
];

/**
 * Server name -> catalog ids it covers, used when the caller has no connectors.json mapping (tests, docs examples).
 * The runner passes the real mapping from connectors.json.
 */
export const DEFAULT_SERVERS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["gmail"],
  sheets: ["google-sheets"],
  calendar: ["google-calendar"],
  composio: ["gmail", "google-sheets", "google-calendar"],
};

/** Never allowed, whatever a server calls them: multiplexers, shells, code runners, forward. */
const NEVER_RE = /multi_?execute|execute|remote_?bash|bash|shell|workbench|eval|run_?action|proxy|forward|_run_|^run_/i;
/** Reply and draft tools are denied by name too, except these exact static names (s16): each binds the thread or
 * ticket to the approved item, or only creates a draft. A dynamic policy (api, computer) never gets the exception. */
const NAMED_RE = /reply|draft/i;
export const REVIEWED_NAMES: ReadonlySet<string> = new Set(["GMAIL_CREATE_EMAIL_DRAFT", "OUTLOOK_CREATE_DRAFT", "ZENDESK_REPLY_ZENDESK_TICKET", "INTERCOM_REPLY_TO_CONVERSATION", "INTERCOM_REPLY_TICKET"]);
/** Input keys that carry a nested tool call or code. */
const NESTED_KEY_RE = /^(tools?|tool_?slug|tool_?name|tool_?calls?|actions?|command|cmd|script|code|slug)$/i;

export function splitMcpName(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3 || parts[1] === "") return null;
  return { server: parts[1]!, tool: parts.slice(2).join("__") };
}

function nestedKey(x: unknown, depth = 0): string | null {
  if (depth > 8 || typeof x !== "object" || x === null) return null;
  for (const [k, v] of Object.entries(x)) {
    if (!Array.isArray(x) && NESTED_KEY_RE.test(k)) return k;
    const deeper = nestedKey(v, depth + 1);
    if (deeper !== null) return deeper;
  }
  return null;
}

/** The policy for `mcp__<server>__<tool>`, or why there is none. */
export function policyFor(name: string, servers: Readonly<Record<string, readonly string[]>> = DEFAULT_SERVERS, input?: Record<string, unknown>, extra: readonly ToolPolicy[] = []): ToolPolicy | { reason: string } {
  const mcp = splitMcpName(name);
  if (mcp === null) return { reason: "built-in tools are disabled in workflow runs" };
  const never = { reason: `${mcp.tool} is a meta, shell, forward, reply or draft tool: never allowed` };
  if (NEVER_RE.test(mcp.tool) || (NAMED_RE.test(mcp.tool) && !REVIEWED_NAMES.has(mcp.tool))) return never;
  if (input !== undefined) {
    const k = nestedKey(input);
    if (k !== null) return { reason: `input carries a nested tool call or code (${k}): never allowed` };
  }
  const covers = Object.hasOwn(servers, mcp.server) ? servers[mcp.server] : undefined;
  if (covers === undefined || !Array.isArray(covers)) return { reason: `server ${mcp.server} is not a connected server: not on the allowlist` };
  // s13: dynamic policies are bound to one server; a server with bound policies never falls back to the static table.
  const bound = extra.filter((x) => x.server === mcp.server);
  const pool = bound.length > 0 ? bound : TOOL_POLICIES;
  const p = pool.find((x) => x.tool === mcp.tool && covers.includes(x.connector));
  if (p === undefined) return { reason: `${mcp.tool} on ${mcp.server} is not on the allowlist (unknown tools are denied)` };
  if (NAMED_RE.test(p.tool) && p.server !== undefined) return never;
  return p;
}

// ---------- canonicalisation ----------

const ADDRESS_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/u;

/** Lowercased, NFC, IDN domain in ASCII (punycode). null when it is not one bare address. */
export function normaliseAddress(raw: string): string | null {
  const s = raw.normalize("NFC").trim().toLowerCase();
  if (!ADDRESS_RE.test(s)) return null;
  const at = s.lastIndexOf("@");
  const local = s.slice(0, at);
  const domain = domainToASCII(s.slice(at + 1));
  if (domain === "" || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return null;
  return `${local}@${domain}`;
}

const text = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n");
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function canonValue(key: string, spec: FieldSpec, v: unknown): { value: unknown } | { drop: true } | { reason: string } {
  switch (spec.kind) {
    case "any":
      return { value: v };
    case "empty":
      return isEmpty(v) ? { drop: true } : { reason: `${key} is not allowed` };
    case "fixed":
      return spec.values.includes(v as string | number | boolean) ? { drop: true } : { reason: `${key} must be ${spec.values.map(String).join(" or ")}` };
    case "const":
      return v === spec.value ? { drop: true } : { reason: `${key} must be ${String(spec.value)}` };
    case "int":
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return { value: String(v) };
      if (typeof v === "string" && /^[0-9]{1,18}$/.test(v)) return { value: String(BigInt(v)) };
      return { reason: `${key} must be a whole number` };
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/.test(v) ? Number(v) : Number.NaN;
      return Number.isFinite(n) ? { value: String(n) } : { reason: `${key} must be a plain decimal number` };
    }
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? { value: v } : { reason: `${key} must be a date (YYYY-MM-DD)` };
    case "time": {
      const iso = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
      const ms = typeof v === "number" && Number.isSafeInteger(v) && v >= 1e12 && v < 1e14;
      return iso || ms ? { drop: true } : { reason: `${key} must be a timestamp` };
    }
    case "object":
      return isPlainObject(v) ? canonObject(spec.fields, v, `${key}.`) : { reason: `${key} must be an object` };
    case "list": {
      if (!Array.isArray(v) || v.length === 0 || v.length > spec.max) return { reason: `${key} must be a list of 1 to ${spec.max} entries` };
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const c = canonValue(`${key}[${i}]`, spec.of, v[i]);
        if ("reason" in c) return c;
        out.push("value" in c ? c.value : null);
      }
      return { value: out };
    }
    case "map": {
      if (!isPlainObject(v) || Object.keys(v).length === 0) return { reason: `${key} must be a record of fields` };
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.trim() === "" || k.length > 100 || UNSAFE_KEYS.has(k)) return { reason: `${key} has a field name that is not allowed` };
        if (typeof x === "string") out[k] = text(x);
        else if ((typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean") out[k] = x;
        else return { reason: `${key}.${k} must be text, a number or true/false` };
      }
      return { value: out };
    }
    case "text":
    case "id":
      return typeof v === "string" ? { value: text(v) } : { reason: `${key} must be a string` };
    case "rows": {
      if (!Array.isArray(v) || !v.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string" || typeof c === "number"))) return { reason: `${key} must be rows of cells` };
      return { value: (v as Array<Array<string | number>>).map((r) => r.map((c) => text(String(c)))) };
    }
    default:
      return { reason: `${key} has no schema` };
    case "addresses": {
      const parts = typeof v === "string" ? v.split(/[,;]/) : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).flatMap((x) => x.split(/[,;]/)) : null;
      if (parts === null) return { reason: `${key} must be an address or a list of addresses` };
      const out: string[] = [];
      for (const p of parts) {
        if (p.trim() === "") continue;
        const a = normaliseAddress(p);
        if (a === null) return { reason: `${key} holds something that is not one plain address: ${JSON.stringify(p.trim()).slice(0, 80)}` };
        out.push(a);
      }
      return { value: out.sort() };
    }
  }
}

function sortedJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(sortedJson).join(",")}]`;
  if (typeof x === "object" && x !== null) {
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

/** Canonical form of the FULL argument object under the tool's schema, and its sha256. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Canonical form of one object under its field schema: unknown keys refused, every `const` required. */
function canonObject(fields: Readonly<Record<string, FieldSpec>>, input: Record<string, unknown>, prefix: string, tool?: string): { value: Record<string, unknown> } | { reason: string } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = Object.hasOwn(fields, k) ? fields[k] : undefined;
    if (spec === undefined) return { reason: `unknown argument ${prefix}${k}${tool === undefined ? "" : ` for ${tool}`}` };
    const c = canonValue(`${prefix}${k}`, spec, v);
    if ("reason" in c) return c;
    if ("value" in c) out[k] = c.value;
  }
  for (const [k, spec] of Object.entries(fields)) if (spec.kind === "const" && !Object.hasOwn(input, k)) return { reason: `${prefix}${k} is required (${String(spec.value)})` };
  return { value: out };
}

export function canonicalArgs(p: ToolPolicy, input: Record<string, unknown>): { canonical: string; hash: string } | { reason: string } {
  const fields = p.fields;
  if (fields === undefined) return { reason: `${p.tool} has no argument schema` };
  if (!isPlainObject(input)) return { reason: "arguments must be an object" };
  const c = canonObject(fields, input, "", p.tool);
  if ("reason" in c) return c;
  const canonical = sortedJson(c.value);
  return { canonical, hash: createHash("sha256").update(canonical).digest("hex") };
}

/** Hash of the arguments expected for `item` under `p`, or why it cannot be built. */
/** s16: the commit verb of an item; email items (no commit) are "send". */
export const itemVerb = (item: BatchItem): string => item.commit?.verb ?? "send";

/** The arguments `p` expects for `item` (null when the item cannot be expressed for it). Static send and draft
 * policies only fit items of their commit verb (s16: one approved item, one tool). */
export function expectedArgs(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): Record<string, unknown> | null {
  if (p.server === undefined && (p.role === "send" || p.role === "draft") && itemVerb(item) !== (p.commitVerb ?? "send")) return null;
  return p.expected?.(item, ctx) ?? null;
}

export function expectedHash(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): { hash: string } | { reason: string } {
  const args = expectedArgs(p, item, ctx);
  if (args === null) {
    if (p.connector === "google-sheets" && p.role === "log" && ctx.crmSheet === undefined) return { reason: "no CRM sheet is configured for this workflow (workflow.json inputs.crmSheet)" };
    return { reason: p.expected === undefined ? `${p.tool} has no expected arguments` : `approved item ${item.key} is not a ${p.commitVerb ?? "send"} item with the fields ${p.tool} needs` };
  }
  const c = canonicalArgs(p, args);
  return "reason" in c ? { reason: `approved item ${item.key} cannot be expressed for ${p.tool}: ${c.reason}` } : { hash: c.hash };
}

/** Role of a tool name under the default mapping (for summaries of old batch results). */
export function roleOfTool(name: string, servers?: Readonly<Record<string, readonly string[]>>, extra?: readonly ToolPolicy[]): Role | null {
  const p = policyFor(name, servers, undefined, extra);
  return "reason" in p ? null : p.role;
}
