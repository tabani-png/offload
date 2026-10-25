// s13: what the connector chain resolves. A target is a catalog connector (gmail, slack, ...) or any app a task profile
// touches that the catalog does not know (`app-<slug>` for a Mac app, `web-<slug>` for a site in the browser). Every
// target carries a capability vocabulary: canonical action names the chain matches methods against. Capabilities of
// catalog targets come from the gate's allowlist (allowlist.ts), never from a tool's name.
import type { TaskProfile } from "../types.ts";
import { TOOL_POLICIES, type Role } from "../workflows/allowlist.ts";
import { CONNECTORS, connectorById, connectorsFor, type Connector } from "./catalog.ts";

export interface ChainTarget {
  id: string;
  name: string;
  /** True for a catalog connector; false for an app target derived from a task profile. */
  catalog: boolean;
  bundleIds: string[];
  hosts: string[];
  /** The Composio toolkit slug to try first (catalog `how`, else a guess from the name). */
  toolkit: string;
  /** Canonical read capabilities, e.g. mail.search. */
  reads: string[];
  /** Canonical commit capabilities (role send), e.g. mail.send; app targets: ui.commit. */
  sends: string[];
  /** Canonical log capabilities (role log), e.g. sheet.append. */
  logs: string[];
}

/** The capability each allowlisted tool stands for. A tool missing here gives no capability (it still is gated). */
export const TOOL_CAPABILITY: Readonly<Record<string, string>> = {
  send_email: "mail.send",
  search_emails: "mail.search",
  read_email: "mail.read",
  list_email_labels: "mail.labels",
  GMAIL_SEND_EMAIL: "mail.send",
  GMAIL_FETCH_EMAILS: "mail.search",
  GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: "mail.read",
  GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND: "sheet.append",
  append_row: "sheet.append",
  GOOGLECALENDAR_FIND_FREE_SLOTS: "calendar.free_slots",
  GOOGLECALENDAR_EVENTS_LIST: "calendar.events",
  find_free_slots: "calendar.free_slots",
};

/** What computer use reads and commits for an app the catalog has no allowlisted tool for. */
export const SCREEN_READ = "screen.read";
export const UI_COMMIT = "ui.commit";

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The capability of an allowlisted tool for a connector, with its role; null when it has none. */
export function capabilityOf(connector: string, tool: string): { capability: string; role: Role } | null {
  const p = TOOL_POLICIES.find((x) => x.connector === connector && x.tool === tool);
  const capability = TOOL_CAPABILITY[tool];
  return p === undefined || capability === undefined ? null : { capability, role: p.role };
}

function catalogCapabilities(id: string): Pick<ChainTarget, "reads" | "sends" | "logs"> {
  const reads: string[] = [];
  const sends: string[] = [];
  const logs: string[] = [];
  for (const p of TOOL_POLICIES) {
    if (p.connector !== id) continue;
    const c = TOOL_CAPABILITY[p.tool];
    if (c === undefined) continue;
    (p.role === "read" ? reads : p.role === "log" ? logs : sends).push(c);
  }
  // A catalog app with no allowlisted commit (Slack, Notion, ...) can still be driven on screen.
  return { reads: uniq(reads), sends: sends.length === 0 && logs.length === 0 ? [UI_COMMIT] : uniq(sends), logs: uniq(logs) };
}

/** Lowercase letters, digits and single dashes; at most 40 characters; "app" when nothing is left. */
export function slugify(s: string): string {
  const out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return out === "" ? "app" : out;
}

/** The Composio toolkit slug guess for a name: lowercase letters and digits only ("Google Sheets" -> googlesheets). */
export const toolkitGuess = (name: string) => slugify(name).replace(/-/g, "") || "app";

export function targetForConnector(c: Connector): ChainTarget {
  return {
    id: c.id,
    name: c.name,
    catalog: true,
    bundleIds: [...c.apps],
    hosts: [...c.hosts],
    toolkit: c.how.startsWith("composio:") ? c.how.slice("composio:".length) : c.id,
    ...catalogCapabilities(c.id),
  };
}

export const CATALOG_TARGETS: readonly ChainTarget[] = CONNECTORS.map(targetForConnector);

export function catalogTarget(id: string): ChainTarget | null {
  const c = connectorById(id);
  return c === undefined ? null : targetForConnector(c);
}

/** Browsers: a task in one of these happens on its host, not in the app. */
const BROWSERS = new Set(["com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.brave.Browser"]);

/** The id of the app target for a profile: `web-<host>` for a browser task with a host, else `app-<name or bundle>`. */
export function appTargetId(p: Pick<TaskProfile, "app" | "appName" | "host">): string {
  if (p.host !== "" && (BROWSERS.has(p.app) || p.app === "")) return `web-${slugify(p.host.replace(/^www\./, ""))}`;
  return `app-${slugify(p.appName !== "" ? p.appName : p.app)}`;
}

/** The target for a task profile: its catalog connector when there is one, else an app target. */
export function targetForProfile(p: Pick<TaskProfile, "app" | "appName" | "host" | "urlPattern" | "schedulingShare">): ChainTarget {
  const primary = connectorsFor(p as TaskProfile).primary;
  if (primary !== null) return targetForConnector(primary);
  const web = appTargetId(p).startsWith("web-");
  const host = p.host.replace(/^www\./, "");
  const name = web ? host : p.appName !== "" ? p.appName : p.app;
  return {
    id: appTargetId(p),
    name,
    catalog: false,
    bundleIds: web || p.app === "" ? [] : [p.app],
    hosts: web ? [p.host] : [],
    toolkit: toolkitGuess(web ? host.split(".").slice(-2, -1)[0] ?? host : name),
    reads: [SCREEN_READ],
    sends: [UI_COMMIT],
    logs: [],
  };
}

/** Every capability a target offers to a caller, reads first. */
export const allCapabilities = (t: ChainTarget) => [...t.reads, ...t.sends, ...t.logs];

/** True when `id` looks like an app target id (`app-…` or `web-…`). */
export const isAppTargetId = (id: string) => /^(app|web)-[a-z0-9-]{1,40}$/.test(id);
