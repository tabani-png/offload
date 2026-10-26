// s20 surface names. Captions name the same product many ways ("Instagram" / "instagram.com", "Terminal" /
// "terminal", "Chrome" / "Google Chrome"); before grouping every name is normalised: case, a domain becomes its
// product, known aliases become one name. Known products also say where they live (host, path, bundle id), so a step
// a caption places in Gmail or Granola is routed to that product even when the observed app is a stand-in (a screen
// recorder, a browser with no URL). Pure; the table is the only data.

export interface KnownSurface {
  /** Stable id (lower case, dashes). */
  id: string;
  /** Display name. */
  name: string;
  /** Lower-case names a caption may use (the name itself is always one). */
  aliases: readonly string[];
  /** Web home: host (and path prefix on a shared host). */
  host?: string;
  path?: string;
  /** Mac bundle id when it is a native app. */
  app?: string;
  /** Composio toolkit slug to try for it. */
  toolkit?: string;
  /** A product a workflow can act in (false: a container such as a browser or a shell, never a connector target). */
  routable: boolean;
}

export const KNOWN_SURFACES: readonly KnownSurface[] = [
  { id: "gmail", name: "Gmail", aliases: ["gmail", "google mail", "mail.google.com"], host: "mail.google.com", toolkit: "gmail", routable: true },
  { id: "google-docs", name: "Google Docs", aliases: ["google docs", "google doc", "docs.google.com"], host: "docs.google.com", path: "/document", toolkit: "googledocs", routable: true },
  { id: "google-sheets", name: "Google Sheets", aliases: ["google sheets", "google sheet"], host: "docs.google.com", path: "/spreadsheets", toolkit: "googlesheets", routable: true },
  { id: "google-calendar", name: "Google Calendar", aliases: ["google calendar", "calendar.google.com"], host: "calendar.google.com", toolkit: "googlecalendar", routable: true },
  { id: "google-meet", name: "Google Meet", aliases: ["google meet", "meet.google.com"], host: "meet.google.com", toolkit: "googlemeet", routable: true },
  { id: "granola", name: "Granola", aliases: ["granola", "granola.ai"], toolkit: "granola", routable: true },
  { id: "linear", name: "Linear", aliases: ["linear", "linear.app"], host: "linear.app", toolkit: "linear", routable: true },
  { id: "notion", name: "Notion", aliases: ["notion", "notion.so"], host: "www.notion.so", toolkit: "notion", routable: true },
  { id: "slack", name: "Slack", aliases: ["slack", "app.slack.com"], app: "com.tinyspeck.slackmacgap", toolkit: "slack", routable: true },
  { id: "chatgpt", name: "ChatGPT", aliases: ["chatgpt", "chat gpt", "chatgpt.com", "chat.openai.com"], host: "chatgpt.com", toolkit: "chatgpt", routable: true },
  { id: "claude", name: "Claude", aliases: ["claude.ai", "claude"], host: "claude.ai", routable: true },
  { id: "claude-code", name: "Claude Code", aliases: ["claude code"], routable: true },
  { id: "linkedin", name: "LinkedIn", aliases: ["linkedin", "linkedin.com"], host: "www.linkedin.com", toolkit: "linkedin", routable: true },
  { id: "instagram", name: "Instagram", aliases: ["instagram", "instagram.com"], host: "www.instagram.com", toolkit: "instagram", routable: true },
  { id: "youtube", name: "YouTube", aliases: ["youtube", "youtube.com", "you tube"], host: "www.youtube.com", toolkit: "youtube", routable: true },
  { id: "x", name: "X", aliases: ["twitter", "x.com", "twitter.com"], host: "x.com", toolkit: "twitter", routable: true },
  { id: "github", name: "GitHub", aliases: ["github", "github.com"], host: "github.com", toolkit: "github", routable: true },
  { id: "figma", name: "Figma", aliases: ["figma", "figma.com"], host: "www.figma.com", toolkit: "figma", routable: true },
  { id: "zoom", name: "Zoom", aliases: ["zoom", "zoom.us"], app: "us.zoom.xos", toolkit: "zoom", routable: true },
  { id: "outlook", name: "Outlook", aliases: ["outlook", "microsoft outlook"], app: "com.microsoft.Outlook", toolkit: "outlook", routable: true },
  { id: "xero", name: "Xero", aliases: ["xero", "go.xero.com"], host: "go.xero.com", toolkit: "xero", routable: true },
  { id: "greenhouse", name: "Greenhouse", aliases: ["greenhouse", "app.greenhouse.io"], host: "app.greenhouse.io", toolkit: "greenhouse", routable: true },
  { id: "zendesk", name: "Zendesk", aliases: ["zendesk"], toolkit: "zendesk", routable: true },
  { id: "hubspot", name: "HubSpot", aliases: ["hubspot", "app.hubspot.com"], host: "app.hubspot.com", toolkit: "hubspot", routable: true },
  { id: "airtable", name: "Airtable", aliases: ["airtable", "airtable.com"], host: "airtable.com", toolkit: "airtable", routable: true },
  // Containers: they name where the user was, not a product a workflow acts in.
  { id: "chrome", name: "Chrome", aliases: ["google chrome", "chrome"], app: "com.google.Chrome", routable: false },
  { id: "safari", name: "Safari", aliases: ["safari"], app: "com.apple.Safari", routable: false },
  { id: "terminal", name: "Terminal", aliases: ["terminal", "terminal.app"], app: "com.apple.Terminal", routable: false },
  { id: "iterm", name: "iTerm", aliases: ["iterm", "iterm2"], app: "com.googlecode.iterm2", routable: false },
  { id: "cursor", name: "Cursor", aliases: ["cursor"], app: "com.todesktop.230313mzl4w4u92", routable: false },
  { id: "vscode", name: "VS Code", aliases: ["vs code", "vscode", "visual studio code"], app: "com.microsoft.VSCode", routable: false },
  { id: "finder", name: "Finder", aliases: ["finder"], app: "com.apple.finder", routable: false },
  { id: "preview", name: "Preview", aliases: ["preview"], app: "com.apple.Preview", routable: false },
];

const BY_ID = new Map(KNOWN_SURFACES.map((s) => [s.id, s]));
export const knownSurfaceById = (id: string) => BY_ID.get(id);

/** Aliases longest first, so "google docs" wins over a bare "google" and "claude code" over "claude". */
const ALIASES: ReadonlyArray<[string, KnownSurface]> = KNOWN_SURFACES.flatMap((s) => [s.name.toLowerCase(), ...s.aliases].map((a) => [a, s] as [string, KnownSurface]))
  .filter((x, i, all) => all.findIndex((y) => y[0] === x[0]) === i)
  .sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALIAS_RES: ReadonlyArray<[RegExp, KnownSurface]> = ALIASES.map(([a, s]) => [new RegExp(`(^|[^a-z0-9.])(?:https?://)?(?:www\\.)?${esc(a)}(?=$|[^a-z0-9])`, "i"), s]);

/** No scheme or www, single spaces, no trailing punctuation; case kept. */
function tidy(text: string): string {
  return text
    .replace(/https?:\/\//gi, "")
    .replace(/\bwww\./gi, "")
    .replace(/[\s_]+/g, " ")
    .trim()
    .replace(/[.,;:!]+$/, "");
}

const clean = (text: string) => tidy(text).toLowerCase();

/** The known product a surface name mentions, or null ("Gmail compose" -> Gmail, "instagram.com feed" -> Instagram). */
export function knownSurfaceIn(text: string): KnownSurface | null {
  const t = clean(text);
  if (t === "") return null;
  for (const [re, s] of ALIAS_RES) if (re.test(t)) return s;
  return null;
}

/** The known product with this host (and path) or bundle id. */
export function knownSurfaceAt(app: string, host: string, path = ""): KnownSurface | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (h !== "") {
    const onHost = KNOWN_SURFACES.filter((s) => s.host !== undefined && s.host.replace(/^www\./, "") === h);
    const hit = onHost.find((s) => s.path !== undefined && path.startsWith(s.path)) ?? onHost.find((s) => s.path === undefined);
    if (hit !== undefined) return hit;
  }
  if (app !== "") return KNOWN_SURFACES.find((s) => s.app === app) ?? null;
  return null;
}

/**
 * The normalised surface name used for grouping: the known product's name replaces whatever alias the caption used
 * ("instagram.com feed" -> "Instagram feed", "Google Chrome" -> "Chrome"); a bare unknown domain becomes its name
 * ("acme.io" -> "acme"); spacing is folded and the rest keeps its case. surfaceKeyOf folds case for grouping.
 */
export function normalizeSurface(text: string): string {
  const t = tidy(text);
  if (t === "") return "";
  for (const [re, s] of ALIAS_RES) {
    const m = re.exec(t);
    if (m === null) continue;
    const at = m.index + m[1]!.length;
    return `${t.slice(0, at)}${s.name}${t.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
  }
  // A bare domain ("acme.io", "app.acme.com") is the site's name.
  const dom = /^([a-z0-9-]+\.)*([a-z0-9-]+)\.[a-z]{2,}$/i.exec(t);
  if (dom !== null) return dom[2]!.toLowerCase();
  return t;
}

/** Grouping key of a surface name: normalised and lower case. */
export const surfaceKeyOf = (text: string) => normalizeSurface(text).toLowerCase();

/** s13 slug convention (connectors/targets.ts slugify), kept here so this file imports nothing. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "app";

/** The app target ids (s13 `web-<host>` / `app-<name>`) a known product's steps get when the catalog lacks it. */
export function targetIdsOf(s: KnownSurface): string[] {
  return [...(s.host === undefined ? [] : [`web-${slug(s.host.replace(/^www\./, ""))}`]), `app-${slug(s.name)}`];
}

const BY_TARGET = new Map<string, KnownSurface>();
for (const s of KNOWN_SURFACES) if (s.routable) for (const id of targetIdsOf(s)) if (!BY_TARGET.has(id)) BY_TARGET.set(id, s);

/** The routable known product behind an app target id ("app-granola", "web-linear-app"), or null. Shared hosts
 * (docs.google.com) name the first product on them; the path decides earlier, in targetOf. */
export const knownSurfaceForTargetId = (id: string): KnownSurface | null => BY_TARGET.get(id) ?? null;
