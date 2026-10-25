// Connector catalog: which tools can reach a task, and how (ADR 0004: Gmail MCP first, Composio for the long tail).
// `reach` (0..1) is the reachability factor in the ranking score: how much of the task the connector can do.
import type { ConnectorHow } from "../api/types.ts";
import type { TaskProfile } from "../types.ts";

export type { ConnectorHow };

export interface Connector {
  id: string;
  name: string;
  how: ConnectorHow;
  reach: number;
  /** Matching rules: any host, or any bundle id; `pathPrefix` narrows a shared host (docs.google.com). s14: a host
   * that starts with "." matches every subdomain (".zendesk.com" matches acme.zendesk.com). */
  hosts: readonly string[];
  apps: readonly string[];
  pathPrefix?: string;
  limits?: string;
}

export const CONNECTORS: readonly Connector[] = [
  { id: "gmail", name: "Gmail", how: "gmail-mcp", reach: 1, hosts: ["mail.google.com"], apps: [] },
  { id: "google-calendar", name: "Google Calendar", how: "composio:googlecalendar", reach: 0.9, hosts: ["calendar.google.com"], apps: [] },
  { id: "slack", name: "Slack", how: "composio:slack", reach: 0.9, hosts: ["app.slack.com"], apps: ["com.tinyspeck.slackmacgap"] },
  {
    id: "linkedin",
    name: "LinkedIn",
    how: "composio:linkedin",
    reach: 0.3,
    hosts: ["www.linkedin.com", "linkedin.com"],
    apps: [],
    limits: "Posting and own profile only; feed reading, search and messages are not available through the API.",
  },
  { id: "google-sheets", name: "Google Sheets", how: "composio:googlesheets", reach: 0.9, hosts: ["docs.google.com"], apps: [], pathPrefix: "/spreadsheets" },
  { id: "notion", name: "Notion", how: "composio:notion", reach: 0.9, hosts: ["www.notion.so", "notion.so"], apps: ["notion.id"] },
  { id: "hubspot", name: "HubSpot", how: "composio:hubspot", reach: 0.9, hosts: ["app.hubspot.com"], apps: [] },
  { id: "attio", name: "Attio", how: "composio:attio", reach: 0.9, hosts: ["app.attio.com"], apps: [] },
  // s14 (after s16 commit schemas): tools the builder can route to; their commits have gate policies (allowlist.ts).
  { id: "outlook", name: "Outlook", how: "composio:outlook", reach: 0.9, hosts: ["outlook.office.com", "outlook.office365.com", "outlook.live.com"], apps: ["com.microsoft.Outlook"] },
  { id: "instantly", name: "Instantly", how: "composio:instantly", reach: 0.9, hosts: ["app.instantly.ai"], apps: [], limits: "Adds approved leads to a campaign; you start the campaign yourself in Instantly." },
  { id: "smartlead", name: "Smartlead", how: "composio:smartlead", reach: 0.9, hosts: ["app.smartlead.ai"], apps: [], limits: "Sends one approved email or resumes one lead; you start campaigns yourself." },
  { id: "salesforce", name: "Salesforce", how: "composio:salesforce", reach: 0.9, hosts: [".lightning.force.com", ".my.salesforce.com"], apps: [] },
  { id: "xero", name: "Xero", how: "composio:xero", reach: 0.9, hosts: ["go.xero.com"], apps: [], limits: "Bills are created as drafts; you approve them in Xero." },
  { id: "quickbooks", name: "QuickBooks", how: "composio:quickbooks", reach: 0.9, hosts: ["app.qbo.intuit.com", "qbo.intuit.com"], apps: [] },
  { id: "zendesk", name: "Zendesk", how: "composio:zendesk", reach: 0.9, hosts: [".zendesk.com"], apps: [] },
  { id: "intercom", name: "Intercom", how: "composio:intercom", reach: 0.9, hosts: ["app.intercom.com"], apps: [] },
  { id: "airtable", name: "Airtable", how: "composio:airtable", reach: 0.9, hosts: ["airtable.com"], apps: [] },
  { id: "greenhouse", name: "Greenhouse", how: "composio:greenhouse", reach: 0.9, hosts: ["app.greenhouse.io"], apps: [] },
  {
    id: "zoom",
    name: "Zoom",
    how: "composio:zoom",
    reach: 0.4,
    hosts: ["zoom.us", "app.zoom.us"],
    apps: ["us.zoom.xos"],
    limits: "Scheduling, recordings and transcripts only; it cannot attend a call for you.",
  },
];

export function connectorById(id: string): Connector | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

function matches(c: Connector, p: TaskProfile): boolean {
  const onHost = p.host !== "" && c.hosts.some((h) => (h.startsWith(".") ? p.host.endsWith(h) : h === p.host));
  const onApp = c.apps.includes(p.app);
  if (!onHost && !onApp) return false;
  return c.pathPrefix === undefined || p.urlPattern.startsWith(c.pathPrefix);
}

export interface ConnectorMatch {
  /** The connector for the app the task happens in, or null. */
  primary: Connector | null;
  /** Connectors the workflow also needs, e.g. Calendar for scheduling. */
  also: Connector[];
  /** primary first, then also. */
  all: Connector[];
  /** Reachability factor for ranking = primary reach, 0 without one. */
  reachability: number;
}

export const SCHEDULING_SHARE_FOR_CALENDAR = 0.3;

export function connectorsFor(profile: TaskProfile): ConnectorMatch {
  const primary = CONNECTORS.find((c) => matches(c, profile)) ?? null;
  const also: Connector[] = [];
  const calendar = connectorById("google-calendar");
  if (calendar !== undefined && primary?.id !== calendar.id && profile.schedulingShare >= SCHEDULING_SHARE_FOR_CALENDAR) also.push(calendar);
  return { primary, also, all: primary === null ? also : [primary, ...also], reachability: primary?.reach ?? 0 };
}

// s13: capability -> candidate tools (a workflow may use a better tool than the app the person used, e.g. Instantly for
// bulk outreach instead of Gmail). The data lives in capabilities.ts; this is the app -> capability bridge.
export { CAPABILITIES, capabilityById, TOOLS } from "./capabilities.ts";

/** The capabilities whose candidates include the tool this catalog connector maps to (gmail -> send-email, ...). */
export async function capabilitiesForConnector(id: string): Promise<string[]> {
  const { CAPABILITIES: caps, TOOLS: tools } = await import("./capabilities.ts");
  return caps.filter((c) => c.candidates.some((k) => tools[k.tool]?.catalogId === id)).map((c) => c.id);
}
