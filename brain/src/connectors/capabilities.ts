// s13 (operator clarification): workflows are MCP / API first; computer use is only the last resort, and a workflow
// may use a better tool than the app the person used (bulk outreach through Instantly instead of sending one by one
// from Gmail). So next to the app -> connector catalog (catalog.ts) there is a capability -> candidate tools catalog.
// Per capability, every candidate tool records:
//   - the vendor's official MCP server (CONFIRMED with a URL and the date it was checked, or UNKNOWN),
//   - its Composio toolkit slug, checked read-only on this Mac (`composio tools list <slug> --limit 1000`),
//   - the direct API docs URL,
//   - which of its tool calls are reads and which are commits (send, launch, create, update, delete), so the gate can
//     map each commit to one approved item (allowlist.ts). A commit listed here is still DENIED until it has an
//     allowlist entry with a full argument schema: this catalog recommends, the allowlist allows.
//   - a one-line why / cost note.
// Read-only research: nothing here was executed against a real account. s14's workflow builder reads it
// (GET /catalog/capabilities) to recommend tools. Pure data + lookups.
import type { CapabilityDTO, CapabilityToolDTO } from "../api/types.ts";
import { TOOL_POLICIES } from "../workflows/allowlist.ts";

export const CATALOG_CHECKED_AT = "2026-10-25";

export type Evidence = "CONFIRMED" | "UNKNOWN";
export type CommitVerb = "send" | "launch" | "create" | "update" | "delete";

export interface ToolInfo {
  id: string;
  name: string;
  /** The vendor's own MCP server. UNKNOWN = no vendor evidence found on the check date (community servers do not count). */
  mcp: { status: Evidence; url: string | null; kind: "remote" | "local" | null; checkedAt: string; evidence: string };
  /** Composio toolkit, listed read-only with the Composio CLI on the check date. */
  composio: { toolkit: string; status: Evidence; tools: number; checkedAt: string };
  apiDocs: string;
  /** The catalog connector id (catalog.ts) when Offload already maps an app to it. */
  catalogId: string | null;
  note: string;
}

export interface CandidateCall {
  /** Composio tool slug (the gate sees it as mcp__composio_cli__<slug>). */
  slug: string;
  kind: "read" | "commit";
  verb?: CommitVerb;
  note?: string;
}

export interface Candidate {
  tool: string;
  why: string;
  cost: string;
  calls: CandidateCall[];
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  /** Candidates in the order Offload recommends them. */
  candidates: Candidate[];
}

const r = (slug: string, note?: string): CandidateCall => ({ slug, kind: "read", ...(note === undefined ? {} : { note }) });
const c = (slug: string, verb: CommitVerb, note?: string): CandidateCall => ({ slug, kind: "commit", verb, ...(note === undefined ? {} : { note }) });

/** Composio toolkits, counted on 2026-10-25 (composio CLI 0.4.2, `tools list <slug> --limit 1000`, read-only). */
const COMPOSIO_COUNTS: Record<string, number> = {
  instantly: 122, smartlead: 42, gmail: 63, outlook: 328, apollo: 72, hubspot: 295, attio: 114, salesforce: 242, xero: 68, quickbooks: 114,
  greenhouse: 134, lever: 64, zendesk: 457, intercom: 133, googlesheets: 58, airtable: 28, notion: 60, slack: 171, calendly: 57,
};

type Mcp = ToolInfo["mcp"];
const yes = (url: string, kind: "remote" | "local", evidence: string): Mcp => ({ status: "CONFIRMED", url, kind, checkedAt: CATALOG_CHECKED_AT, evidence });
const unknown = (evidence: string): Mcp => ({ status: "UNKNOWN", url: null, kind: null, checkedAt: CATALOG_CHECKED_AT, evidence });

/** The vendors' official MCP servers, checked on 2026-10-25 (web research on vendor pages only; community servers do
 * not count). Where `url` is a docs page, the vendor publishes no single public endpoint (or it was not verified). */
const MCP: Record<string, Mcp> = {
  instantly: yes("https://mcp.instantly.ai/mcp", "remote", "help.instantly.ai: Instantly MCP, API key in the Authorization header"),
  smartlead: yes("https://mcp.smartlead.ai/sse", "remote", "helpcenter.smartlead.ai: Smartlead MCP Server (SSE, API key as a query parameter)"),
  gmail: yes("https://gmailmcp.googleapis.com/mcp/v1", "remote", "developers.google.com: Configure the Gmail MCP server (Workspace Developer Preview, not GA)"),
  outlook: yes("https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-mail-tools", "remote", "learn.microsoft.com: Mail tools for Microsoft Graph (preview, Copilot Studio); docs page, no public endpoint"),
  apollo: yes("https://mcp.apollo.io/mcp", "remote", "docs.apollo.io: Apollo MCP (hosted, OAuth)"),
  hubspot: yes("https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server", "remote", "developers.hubspot.com: remote HubSpot MCP server for CRM data; docs page, endpoint not verified"),
  attio: yes("https://mcp.attio.com/mcp", "remote", "attio.com/apps/mcp: hosted MCP server (OAuth); endpoint from third-party listings"),
  salesforce: yes("https://developer.salesforce.com/docs/platform/hosted-mcp-servers", "remote", "Salesforce Developers blog 2026-04: Hosted MCP Servers GA; endpoints per org; docs page"),
  xero: yes("https://github.com/XeroAPI/xero-mcp-server", "local", "github.com/XeroAPI (vendor org); Xero also runs a hosted Developer Remote MCP"),
  quickbooks: yes("https://github.com/intuit/quickbooks-online-mcp-server", "local", "Intuit Developer blog 2025-10-21: local MCP server, early preview, sandbox only"),
  greenhouse: yes("https://support.greenhouse.io/hc/en-us/articles/52096319906971-Set-up-Greenhouse-MCP-with-supported-AI-tools", "remote", "greenhouse.com: Greenhouse MCP; support article, endpoint not captured, remote inferred"),
  lever: unknown("no Lever / Employ page or repo found; only community servers"),
  zendesk: unknown("no zendesk.com page for a ticket-access MCP server found; only community servers"),
  intercom: yes("https://mcp.intercom.com/mcp", "remote", "developers.intercom.com/docs/guides/mcp (US; EU workspaces use mcp.eu.intercom.com)"),
  googlesheets: yes("https://sheetsmcp.googleapis.com/mcp/v1", "remote", "developers.google.com: Configure the Sheets MCP server (Workspace Developer Preview, not GA)"),
  airtable: yes("https://mcp.airtable.com/mcp", "remote", "airtable.com/developers/agents/mcp/getting-started: Server URL https://mcp.airtable.com/mcp"),
  notion: yes("https://mcp.notion.com/mcp", "remote", "developers.notion.com/docs/mcp: remote MCP server hosted by Notion"),
  slack: yes("https://mcp.slack.com/mcp", "remote", "docs.slack.dev/ai/mcp-server: requests go to https://mcp.slack.com/mcp"),
  calendly: yes("https://mcp.calendly.com", "remote", "developer.calendly.com: Calendly MCP, fully hosted at https://mcp.calendly.com"),
};

/** Vendor API reference pages (several written from known vendor doc roots, not each opened on the check date). */
const API_DOCS = {
  instantly: "https://developer.instantly.ai/",
  smartlead: "https://api.smartlead.ai/reference/welcome",
  gmail: "https://developers.google.com/workspace/gmail/api/reference/rest",
  outlook: "https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview",
  apollo: "https://docs.apollo.io/reference",
  hubspot: "https://developers.hubspot.com/docs/api-reference",
  attio: "https://docs.attio.com/rest-api/overview",
  salesforce: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/",
  xero: "https://developer.xero.com/documentation/api/accounting/overview",
  quickbooks: "https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account",
  greenhouse: "https://developers.greenhouse.io/harvest.html",
  lever: "https://hire.lever.co/developer/documentation",
  zendesk: "https://developer.zendesk.com/api-reference/",
  intercom: "https://developers.intercom.com/docs/references/rest-api/api.intercom.io",
  googlesheets: "https://developers.google.com/workspace/sheets/api/reference/rest",
  airtable: "https://airtable.com/developers/web/api/introduction",
  notion: "https://developers.notion.com/reference/intro",
  slack: "https://docs.slack.dev/apis/web-api/",
  calendly: "https://developer.calendly.com/api-docs",
} as const;

const tool = (id: keyof typeof API_DOCS, name: string, catalogId: string | null, note: string): ToolInfo => ({
  id,
  name,
  mcp: MCP[id] ?? unknown("not checked"),
  composio: { toolkit: id, status: (COMPOSIO_COUNTS[id] ?? 0) > 0 ? "CONFIRMED" : "UNKNOWN", tools: COMPOSIO_COUNTS[id] ?? 0, checkedAt: CATALOG_CHECKED_AT },
  apiDocs: API_DOCS[id],
  catalogId,
  note,
});

export const TOOLS: Readonly<Record<string, ToolInfo>> = Object.fromEntries(
  [
    tool("instantly", "Instantly", null, "Cold-email sequences with sending accounts and warm-up; built for volume."),
    tool("smartlead", "Smartlead", null, "Cold-email sequences with mailbox rotation; agency friendly."),
    tool("gmail", "Gmail", "gmail", "One mailbox; fine for personal sends, rate-limited for bulk."),
    tool("outlook", "Outlook", null, "Microsoft 365 mail through Microsoft Graph."),
    tool("apollo", "Apollo.io", null, "Contact data, enrichment and sequences in one place."),
    tool("hubspot", "HubSpot", "hubspot", "CRM with contacts, deals, notes and engagements."),
    tool("attio", "Attio", "attio", "Flexible CRM with records and notes."),
    tool("salesforce", "Salesforce", null, "Enterprise CRM; objects, tasks and notes."),
    tool("xero", "Xero", null, "Accounting; a bill is an invoice of type ACCPAY."),
    tool("quickbooks", "QuickBooks Online", null, "Accounting with bills, vendors and payments."),
    tool("greenhouse", "Greenhouse", null, "Applicant tracking: applications, stages, hires."),
    tool("lever", "Lever", null, "Applicant tracking: opportunities and stages."),
    tool("zendesk", "Zendesk", null, "Support tickets and comments."),
    tool("intercom", "Intercom", null, "Support conversations, tickets and replies."),
    tool("googlesheets", "Google Sheets", "google-sheets", "Spreadsheet rows; the simplest log."),
    tool("airtable", "Airtable", null, "Base tables with typed fields."),
    tool("notion", "Notion", "notion", "Pages and database rows."),
    tool("slack", "Slack", "slack", "Team messages in channels and DMs."),
    tool("calendly", "Calendly", null, "Booking links and scheduled events."),
  ].map((t) => [t.id, t]),
);

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "send-outreach-sequence",
    name: "Send an outreach sequence",
    description: "Put approved prospects into a multi-step cold-email sequence and start it, instead of sending each email by hand.",
    candidates: [
      { tool: "instantly", why: "Made for bulk cold email: sending accounts, warm-up, follow-ups and reply detection.", cost: "Paid plan per sending volume.", calls: [r("INSTANTLY_LIST_CAMPAIGNS"), r("INSTANTLY_GET_CAMPAIGN_ANALYTICS"), c("INSTANTLY_ADD_LEADS_BULK", "create", "adds the approved leads to a campaign"), c("INSTANTLY_ACTIVATE_CAMPAIGN", "launch", "starts sending")] },
      { tool: "smartlead", why: "Bulk cold email with mailbox rotation; good when many inboxes send.", cost: "Paid plan per sending volume.", calls: [r("SMARTLEAD_GET_CAMPAIGNS"), r("SMARTLEAD_LIST_CAMPAIGN_LEADS"), c("SMARTLEAD_CREATE_CAMPAIGN", "create"), c("SMARTLEAD_RESUME_CAMPAIGN_LEAD", "launch"), c("SMARTLEAD_SEND_SINGLE_EMAIL", "send")] },
      { tool: "apollo", why: "Sequences next to the contact data, if the team already prospects in Apollo.", cost: "Paid seat; sequences on paid plans.", calls: [r("APOLLO_SEARCH_SEQUENCES"), c("APOLLO_ADD_CONTACTS_TO_SEQUENCE", "create"), c("APOLLO_ACTIVATE_SEQUENCE", "launch")] },
      { tool: "gmail", why: "What the person uses today: one approved email at a time from their own mailbox.", cost: "Free with the mailbox; daily send limits.", calls: [r("GMAIL_FETCH_EMAILS"), c("GMAIL_SEND_EMAIL", "send")] },
      { tool: "outlook", why: "Same as Gmail for Microsoft 365 mailboxes.", cost: "Included with Microsoft 365.", calls: [r("OUTLOOK_LIST_MESSAGES"), c("OUTLOOK_SEND_EMAIL", "send")] },
    ],
  },
  {
    id: "send-email",
    name: "Send one email",
    description: "Send a single approved email (a reply, a follow-up, an intro).",
    candidates: [
      { tool: "gmail", why: "Sends from the person's own Gmail, as they do today.", cost: "Free with the mailbox.", calls: [r("GMAIL_FETCH_EMAILS"), c("GMAIL_SEND_EMAIL", "send"), c("GMAIL_CREATE_EMAIL_DRAFT", "create", "a draft in your own mailbox; you send it yourself")] },
      { tool: "outlook", why: "Sends from a Microsoft 365 mailbox.", cost: "Included with Microsoft 365.", calls: [r("OUTLOOK_LIST_MESSAGES"), c("OUTLOOK_SEND_EMAIL", "send"), c("OUTLOOK_CREATE_DRAFT", "create", "a draft in your own mailbox; you send it yourself"), c("OUTLOOK_REPLY_EMAIL", "send")] },
    ],
  },
  {
    id: "enrich-contact",
    name: "Enrich a contact",
    description: "Find a person's role, company and work email from a name or domain.",
    candidates: [
      { tool: "apollo", why: "Large contact database; one call per person or in bulk.", cost: "Uses Apollo credits per enrichment (a read that spends money).", calls: [r("APOLLO_PEOPLE_ENRICHMENT", "spends credits"), r("APOLLO_BULK_PEOPLE_ENRICHMENT", "spends credits"), r("APOLLO_ORGANIZATION_ENRICHMENT", "spends credits"), r("APOLLO_PEOPLE_SEARCH")] },
      { tool: "hubspot", why: "Company data the CRM already holds, before paying for enrichment.", cost: "Included in the HubSpot plan.", calls: [r("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA"), r("HUBSPOT_LIST_CONTACTS")] },
    ],
  },
  {
    id: "log-to-crm",
    name: "Log to the CRM",
    description: "Record what was sent or agreed on the contact in the CRM.",
    candidates: [
      { tool: "hubspot", why: "Notes and engagements attach to the contact's timeline.", cost: "Included in the HubSpot plan.", calls: [r("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA"), c("HUBSPOT_CREATE_NOTE", "create"), c("HUBSPOT_CREATE_CONTACT", "create"), c("HUBSPOT_CREATE_ENGAGEMENT", "create")] },
      { tool: "attio", why: "Records and notes on any object, if the team runs Attio.", cost: "Included in the Attio plan.", calls: [r("ATTIO_FIND_RECORD"), r("ATTIO_SEARCH_RECORDS"), c("ATTIO_CREATE_NOTE", "create"), c("ATTIO_CREATE_RECORD", "create")] },
      { tool: "salesforce", why: "Tasks and notes on leads and contacts for Salesforce teams.", cost: "Needs API access (Enterprise edition or the API add-on).", calls: [r("SALESFORCE_QUERY_CONTACTS_BY_NAME"), c("SALESFORCE_CREATE_TASK", "create"), c("SALESFORCE_CREATE_NOTE", "create"), c("SALESFORCE_CREATE_LEAD", "create")] },
      { tool: "googlesheets", why: "A sheet as a light CRM when there is none (what Offload logs to today).", cost: "Free with Google Workspace.", calls: [r("GOOGLESHEETS_VALUES_GET"), c("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", "create")] },
    ],
  },
  {
    id: "create-bill",
    name: "Create a bill",
    description: "Enter a supplier bill from an invoice the person received.",
    candidates: [
      { tool: "quickbooks", why: "Bills against vendors, ready for payment runs.", cost: "Included in QuickBooks Online plans.", calls: [r("QUICKBOOKS_QUERY_VENDORS"), r("QUICKBOOKS_QUERY_BILLS"), c("QUICKBOOKS_CREATE_BILL", "create"), c("QUICKBOOKS_CREATE_VENDOR", "create")] },
      { tool: "xero", why: "Bills are invoices of type ACCPAY in Xero.", cost: "Included in Xero plans; API rate limits per tenant.", calls: [r("XERO_LIST_INVOICES"), r("XERO_GET_INVOICE"), c("XERO_CREATE_INVOICE", "create", "with Type ACCPAY for a bill")] },
    ],
  },
  {
    id: "update-ats-stage",
    name: "Move a candidate's stage",
    description: "Move an application to the next interview stage in the applicant tracking system.",
    candidates: [
      { tool: "greenhouse", why: "Moves an application between stages of its job.", cost: "Needs a Harvest API key from a Greenhouse admin.", calls: [r("GREENHOUSE_LIST_APPLICATIONS"), r("GREENHOUSE_LIST_JOB_INTERVIEW_STAGES"), c("GREENHOUSE_MOVE_APPLICATION", "update"), c("GREENHOUSE_REJECT_APPLICATION", "delete")] },
      { tool: "lever", why: "Opportunities move through stages; Composio has no stage-change tool (checked 2026-10-25), so the change goes through the Lever API (PUT /opportunities/{id}/stage) or computer use.", cost: "Needs a Lever API key.", calls: [r("LEVER_LIST_OPPORTUNITIES"), r("LEVER_LIST_STAGES"), r("LEVER_GET_OPPORTUNITY")] },
    ],
  },
  {
    id: "reply-ticket",
    name: "Reply to a support ticket",
    description: "Post an approved reply on a customer's ticket or conversation.",
    candidates: [
      { tool: "zendesk", why: "Public replies and internal notes on tickets.", cost: "Included in Zendesk Suite plans.", calls: [r("ZENDESK_GET_TICKET_COMMENTS"), r("ZENDESK_GET_TICKETS_CONVERSATION_LOG"), c("ZENDESK_REPLY_ZENDESK_TICKET", "send")] },
      { tool: "intercom", why: "Replies inside the customer's conversation.", cost: "Included in Intercom plans.", calls: [r("INTERCOM_GET_CONVERSATION"), r("INTERCOM_SEARCH_CONVERSATIONS"), c("INTERCOM_REPLY_TO_CONVERSATION", "send"), c("INTERCOM_REPLY_TICKET", "send"), c("INTERCOM_CLOSE_CONVERSATION", "update")] },
    ],
  },
  {
    id: "write-sheet-row",
    name: "Write a row",
    description: "Add one row to a sheet, table or database.",
    candidates: [
      { tool: "googlesheets", why: "Appends a row; the gate already allows the CRM-log row (allowlist.ts).", cost: "Free with Google Workspace.", calls: [r("GOOGLESHEETS_VALUES_GET"), r("GOOGLESHEETS_BATCH_GET"), c("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", "create")] },
      { tool: "airtable", why: "Typed fields and views.", cost: "Free tier has record limits.", calls: [r("AIRTABLE_LIST_RECORDS"), r("AIRTABLE_GET_RECORD"), c("AIRTABLE_CREATE_RECORD", "create")] },
      { tool: "notion", why: "A database row with properties.", cost: "Free for personal use.", calls: [r("NOTION_QUERY_DATABASE"), r("NOTION_FETCH_DATABASE"), c("NOTION_INSERT_ROW_DATABASE", "create")] },
    ],
  },
  {
    id: "post-message",
    name: "Post a team message",
    description: "Post an approved message to a channel or a person.",
    candidates: [{ tool: "slack", why: "Channels and DMs; the message shows as the connected user or bot.", cost: "Included in Slack plans.", calls: [r("SLACK_LIST_CONVERSATIONS"), r("SLACK_FETCH_CONVERSATION_HISTORY"), c("SLACK_SEND_MESSAGE", "send"), c("SLACK_CHAT_POST_MESSAGE", "send")] }],
  },
  {
    id: "schedule-meeting",
    name: "Offer a meeting time",
    description: "Send a booking link or find open times for a meeting.",
    candidates: [{ tool: "calendly", why: "A single-use booking link per person, no back and forth.", cost: "Paid plans for multiple event types.", calls: [r("CALENDLY_LIST_EVENT_TYPES"), r("CALENDLY_LIST_EVENT_TYPE_AVAILABLE_TIMES"), c("CALENDLY_CREATE_SINGLE_USE_SCHEDULING_LINK", "create"), c("CALENDLY_CANCEL_SCHEDULED_EVENT", "delete")] }],
  },
];

export const capabilityById = (id: string): Capability | undefined => CAPABILITIES.find((x) => x.id === id);

/** True when the gate already has a hash-bound policy for this Composio commit (else it is denied until one is added). */
export const gateAllows = (slug: string): boolean => TOOL_POLICIES.some((p) => p.flavor === "composio" && p.tool === slug && p.role !== "read");

/** How the gate should map a Composio tool listed here: read, commit, or unknown (not in the catalog: denied). */
export function gateRoleOf(slug: string): "read" | "commit" | "unknown" {
  for (const cap of CAPABILITIES) for (const cand of cap.candidates) for (const call of cand.calls) if (call.slug === slug) return call.kind;
  return "unknown";
}

export function candidateDTO(cand: Candidate): CapabilityToolDTO {
  const t = TOOLS[cand.tool]!;
  return {
    toolId: t.id,
    name: t.name,
    why: cand.why,
    cost: cand.cost,
    mcp: { ...t.mcp },
    composio: { ...t.composio },
    apiDocs: t.apiDocs,
    catalogId: t.catalogId,
    reads: cand.calls.filter((x) => x.kind === "read").map((x) => ({ slug: x.slug, gateTool: `mcp__composio_cli__${x.slug}`, ...(x.note === undefined ? {} : { note: x.note }) })),
    commits: cand.calls.filter((x) => x.kind === "commit").map((x) => ({ slug: x.slug, verb: x.verb!, gateTool: `mcp__composio_cli__${x.slug}`, allowedByGate: gateAllows(x.slug), ...(x.note === undefined ? {} : { note: x.note }) })),
    note: t.note,
  };
}

export function capabilityDTO(cap: Capability): CapabilityDTO {
  return { id: cap.id, name: cap.name, description: cap.description, checkedAt: CATALOG_CHECKED_AT, candidates: cap.candidates.map(candidateDTO) };
}
