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
  /** Matching rules: any host, or any bundle id; `pathPrefix` narrows a shared host (docs.google.com). */
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
  const onHost = p.host !== "" && c.hosts.includes(p.host);
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
