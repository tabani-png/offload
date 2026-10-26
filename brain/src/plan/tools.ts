// s14 tool recommendations: workflows are MCP/API agentic workflows first; using the app on screen is the last resort.
// For every step that needs an outside tool, 1-3 options are proposed for its CAPABILITY (not just the app the user
// happened to use): e.g. 100 outreach emails a day in Gmail -> sending through an outreach platform built for volume,
// enrichment through a data provider, the log through the CRM. Each option says why, the setup effort, a cost note and
// whether it is already connected. The default is a connected option that is good enough, else the first option.
// The design model (Opus, route "design") may reorder the options and reword `why`; it can only pick ids from the
// candidates. Creating drafts inside a tool is a non-commit step; sending or launching stays a gated commit (ADR 0006).
// SEAM (s13): OPTIONS below holds tools the connector catalog (connectors/catalog.ts, read only here) does not list yet;
// once s13's chain probes them, `connected` comes from the chain instead of connectorStatus.
import type { OutputType, PlanVariantDTO } from "../api/s14-types.ts";
import { CONNECTORS, connectorById } from "../connectors/catalog.ts";
import { capabilityById, candidateDTO } from "../connectors/capabilities.ts";
import { chainPath } from "../connectors/chain.ts";
import { existsSync, readFileSync } from "node:fs";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { universeTargetId } from "../connectors/targets.ts";
import { toolkitForApp, toolScore, type UniverseIndex, type UniverseTool } from "../connectors/universe.ts";
import { hasStaticPolicy } from "../workflows/allowlist.ts";
import { genericVerb } from "../workflows/generic.ts";

export type Via = "mcp" | "composio" | "api" | "computer" | "local";

export interface ToolOptionDTO {
  id: string;
  name: string;
  via: Via;
  why: string;
  setup: "none" | "minutes" | "about an hour";
  cost: string;
  connected: boolean;
  /** Catalog connector id when the catalog knows it. */
  connectorId: string | null;
  /** s13 capability catalog: the vendor's own MCP server is confirmed. */
  mcpConfirmed?: boolean;
  /** s13 catalog: every commit of this tool has a gate policy (allowlist.ts); false = reads only until one is added. */
  commitsAllowed?: boolean | null;
  /** A plain sentence when this option cannot do the whole step yet; null otherwise. */
  needsYou?: string | null;
  /** s17: false for a tool from the Composio universe (approved field by field, not hand-verified). */
  verified?: boolean;
  /** s17: the Composio tool slug of a universe option. */
  slug?: string;
}

export interface StepToolsDTO {
  stepId: string;
  /** Capability family ("email.send_bulk", "enrich.person", "crm.log", ...). */
  capability: string;
  /** The s13 capability catalog id it maps to (GET /catalog/capabilities/:id), null when the catalog has none. */
  catalogCapability: string | null;
  need: string;
  options: ToolOptionDTO[];
  chosen: string;
  chosenBy: "default" | "user";
  /** What the current runner uses for this step today. Template email workflows still send through Gmail until the
   * s13 chain can drive the chosen tool; a plan workflow runs with `chosen` through the chain. */
  runsWith: string;
  /** Plain one-liner for the review ("Use Instantly for sending: built for 100+ a day, warms domains. Connect via Composio."). */
  suggestion: string;
}

interface Candidate extends Omit<ToolOptionDTO, "connected"> {
  /** Good enough for volume of this many items a day. */
  maxPerDay?: number;
}

const ONSCREEN = (name: string): Candidate => ({ id: `screen:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: `${name} on screen`, via: "computer", why: `Uses ${name} the way you do, on screen. Slower, and the last resort.`, setup: "none", cost: "no extra cost", connectorId: null });

/** Candidates per capability family, best fit first. Plain notes, no prices that could go stale. */
export const OPTIONS: Readonly<Record<string, readonly Candidate[]>> = {
  "email.send_bulk": [
    { id: "instantly", name: "Instantly", via: "composio", why: "Built for sending 100+ a day: campaigns, sequences, warmed sending domains, bounce and reply tracking.", setup: "about an hour", cost: "paid plan, priced per sending volume", connectorId: null },
    { id: "smartlead", name: "Smartlead", via: "composio", why: "Outreach platform with mailbox rotation and warm-up for high daily volume.", setup: "about an hour", cost: "paid plan", connectorId: null },
    { id: "gmail", name: "Gmail", via: "mcp", why: "Sends from your own mailbox. Fine for a few dozen a day; Google limits daily volume.", setup: "minutes", cost: "no extra cost", connectorId: "gmail", maxPerDay: 50 },
  ],
  "email.send": [{ id: "gmail", name: "Gmail", via: "mcp", why: "Sends from your own mailbox, in the thread.", setup: "minutes", cost: "no extra cost", connectorId: "gmail" }],
  "email.draft": [
    { id: "gmail", name: "Gmail drafts", via: "mcp", why: "Puts each draft in your Gmail drafts for you to send.", setup: "minutes", cost: "no extra cost", connectorId: "gmail" },
    { id: "instantly", name: "Instantly campaign drafts", via: "composio", why: "Loads the drafts into a paused campaign; nothing goes out until you launch it.", setup: "about an hour", cost: "paid plan", connectorId: null },
  ],
  "enrich.person": [
    { id: "apollo", name: "Apollo", via: "composio", why: "Looks up title, company and work email in one call per person.", setup: "minutes", cost: "credits per lookup", connectorId: null },
    { id: "clay", name: "Clay", via: "api", why: "Combines several data providers per row; good when one source misses.", setup: "about an hour", cost: "credits per row", connectorId: null },
    { id: "linkedin", name: "LinkedIn", via: "composio", why: "The source you read today; its API does not show other people's profiles, so this runs on screen.", setup: "minutes", cost: "no extra cost", connectorId: "linkedin" },
  ],
  "crm.log": [
    { id: "hubspot", name: "HubSpot", via: "composio", why: "Logs each contact and email on the record.", setup: "minutes", cost: "your existing plan", connectorId: "hubspot" },
    { id: "attio", name: "Attio", via: "composio", why: "Logs each contact and email on the record.", setup: "minutes", cost: "your existing plan", connectorId: "attio" },
    { id: "google-sheets", name: "Google Sheets", via: "composio", why: "Adds a row per item to your sheet.", setup: "minutes", cost: "no extra cost", connectorId: "google-sheets" },
  ],
  "sheet.update": [{ id: "google-sheets", name: "Google Sheets", via: "composio", why: "Writes the row through the Sheets API, cell by cell, without the screen.", setup: "minutes", cost: "no extra cost", connectorId: "google-sheets" }],
  "ticket.reply": [
    { id: "zendesk", name: "Zendesk", via: "composio", why: "Posts the reply and sets the status through the Zendesk API.", setup: "minutes", cost: "your existing plan", connectorId: null },
  ],
  "order.lookup": [{ id: "shopify", name: "Shopify", via: "composio", why: "Reads the order status and tracking through the Admin API.", setup: "minutes", cost: "your existing plan", connectorId: null }],
  "accounting.bill": [
    { id: "xero", name: "Xero", via: "composio", why: "Creates the bill as a draft through the Xero API with the copied values.", setup: "minutes", cost: "your existing plan", connectorId: null },
  ],
  "ats.stage": [{ id: "greenhouse", name: "Greenhouse", via: "api", why: "Saves the scorecard and moves the stage through the Harvest API.", setup: "about an hour", cost: "your existing plan", connectorId: null }],
  "doc.read": [{ id: "local-file", name: "The file on this Mac", via: "local", why: "Reads the document from disk; no account needed.", setup: "none", cost: "no extra cost", connectorId: null }],
  "chat.message": [{ id: "slack", name: "Slack", via: "composio", why: "Posts the message in the channel through the Slack API.", setup: "minutes", cost: "your existing plan", connectorId: "slack" }],
};

/** The capability family of one plan step, from its type, the plan's output type, the target and the daily volume. */
export function capabilityFamily(step: { type: string; capability: { target: string; capability: string; via: string; role: string; need?: string } | null }, out: OutputType, perDay: number): string | null {
  const c = step.capability;
  if (c === null) return null;
  const t = c.target;
  if (c.via === "local_file") return "doc.read";
  if (step.type === "read") {
    // s22 bias audit: reading LinkedIn is a person lookup only when a person is what is read (not a feed or a post).
    if (/linkedin/.test(t) && (c.need === undefined || PERSON_WORDS.test(c.need))) return "enrich.person";
    if (/shopify/.test(t)) return "order.lookup";
    return null;
  }
  if (step.type !== "commit") return null;
  if (out === "email") return perDay >= 30 ? "email.send_bulk" : "email.send";
  if (out === "ticket_reply") return "ticket.reply";
  // s22 bias audit: a text output is a chat message only in a chat app; a post, a prompt or a note is not Slack.
  if (out === "message") return CHAT_TARGETS.test(t) ? "chat.message" : null;
  if (out === "rows") return "sheet.update";
  if (out === "form_fields" && /xero/.test(t)) return "accounting.bill";
  if (out === "stage_change" && /greenhouse/.test(t)) return "ats.stage";
  // s22 bias audit: a second commit is a CRM log only when it lands in a CRM or a sheet.
  if (c.role === "log") return CRM_TARGETS.test(t) ? "crm.log" : null;
  return null;
}

const PERSON_WORDS = /\b(profile|person|people|contact|candidate|lead|prospect)s?\b/i;
const CHAT_TARGETS = /slack|teams|discord|whatsapp|telegram|chat|messages|intercom/;
const CRM_TARGETS = /hubspot|attio|salesforce|pipedrive|crm|sheets|airtable/;

/** The family of a legacy (template) step: s05 email templates send through Gmail and log to the CRM sheet. */
export function legacyFamily(step: { type: string; connector: string | null }, kind: string, perDay: number): string | null {
  if (step.type === "send" && step.connector === "gmail") return kind === "email.outreach" ? (perDay >= 30 ? "email.send_bulk" : "email.send") : "email.send";
  if (step.type === "log") return "crm.log";
  return null;
}

function viaWords(o: ToolOptionDTO): string {
  if (o.verified === false) return o.connected ? "Already connected. You check every field before it runs." : "Set it up once in Connections.";
  if (o.needsYou != null) return o.connected ? "Connected, reads only for now." : "Reads only for now.";
  if (o.connected) return "Already connected.";
  if (o.via === "composio") return "Connect via Composio.";
  if (o.via === "mcp") return `Connect ${o.name}.`;
  if (o.via === "api") return "Connect with an API key.";
  if (o.via === "local") return "Nothing to connect.";
  return "Runs on screen.";
}

/** Tools whose campaign is started by the person: Offload adds each approved lead (s16). */
export const STARTS_IN_TOOL = new Set(["instantly", "smartlead"]);

export function suggestionFor(verb: string, o: ToolOptionDTO): string {
  const campaign = STARTS_IN_TOOL.has(o.id) ? ` Offload adds each approved lead; you start the campaign in ${o.name}.` : "";
  return `Use ${o.name} for ${verb}: ${o.why.replace(/\.$/, "")}.${campaign} ${viaWords(o)}`;
}

/** My family -> s13 capability catalog id (connectors/capabilities.ts, read only). */
export const CATALOG_CAPABILITY: Readonly<Record<string, string>> = {
  "email.send_bulk": "send-outreach-sequence",
  "email.send": "send-email",
  "enrich.person": "enrich-contact",
  "crm.log": "log-to-crm",
  "accounting.bill": "create-bill",
  "ats.stage": "update-ats-stage",
  "ticket.reply": "reply-ticket",
  "sheet.update": "write-sheet-row",
  "chat.message": "post-message",
};

/** Above this many a day a mailbox is not good enough as the sender (provider daily limits, deliverability). */
const MAILBOX_PER_DAY = 50;
const SLOW_SETUP = new Set(["instantly", "smartlead"]);
/** s13 tool ids whose catalog connector id differs. */
const CATALOG_ID: Readonly<Record<string, string>> = { googlesheets: "google-sheets" };

/** Plain words for a Composio account that may only read (s13 chain code "reads_only", connector-chain.json). */
export const READS_ONLY_WORDS = "Composio asks before every action on this account, so Offload only reads through it. Allow actions for this account in Composio, or connect the tool directly.";

/** From the s13 catalog: up to 3 candidates (the tool the person uses today kept in), each with how it connects, its
 * gate status and a needs-you sentence when it cannot commit yet. */
function catalogOptions(capId: string, current: string | null, connected: ReadonlySet<string>, readsOnly: ReadonlyMap<string, string>): ToolOptionDTO[] | null {
  const cap = capabilityById(capId);
  if (cap === undefined) return null;
  const all = cap.candidates.map((cand) => {
    const d = candidateDTO(cand);
    const connectorId = d.catalogId ?? CATALOG_ID[d.toolId] ?? (connectorById(d.toolId) !== undefined ? d.toolId : null);
    const via: Via = d.mcp.status === "CONFIRMED" ? "mcp" : d.composio.status === "CONFIRMED" ? "composio" : "api";
    // Campaign-wide launches stay denied by design (no item can bind them): the per-item commit is what counts, and
    // the person starts the campaign in the tool.
    const perItem = d.commits.filter((c) => c.verb !== "launch");
    const commitsAllowed = perItem.length === 0 ? (d.commits.length === 0 ? null : false) : perItem.some((c) => c.allowedByGate);
    const isConnected = connectorId !== null && connected.has(connectorId);
    const ro = connectorId === null ? undefined : readsOnly.get(connectorId);
    const needsYou =
      ro !== undefined
        ? ro
        : commitsAllowed === false
          ? `Offload can read through ${d.name}, but its ${d.commits.map((c) => c.verb).filter((v, i, a) => a.indexOf(v) === i).join(" and ")} actions are not approved for use yet.`
          : null;
    const o: ToolOptionDTO = { id: d.toolId, name: d.name, via, why: d.why, setup: SLOW_SETUP.has(d.toolId) ? "about an hour" : via === "api" ? "about an hour" : "minutes", cost: d.cost, connected: isConnected, connectorId, mcpConfirmed: d.mcp.status === "CONFIRMED", commitsAllowed, needsYou };
    return o;
  });
  let top = all.slice(0, 3);
  // Keep the tool the person uses today, else one already connected, among the three shown.
  const mine = (current === null ? undefined : all.find((o) => o.connectorId === current || o.id === current)) ?? all.find((o) => o.connected);
  if (mine !== undefined && !top.includes(mine)) top = [...top.slice(0, 2), mine];
  return top;
}

// ---------- s17: tools from the Composio universe ----------

/** Words a family's tools are found by (name words count most, then description words). */
export const FAMILY_WORDS: Readonly<Record<string, readonly string[]>> = {
  "email.send_bulk": ["send", "email", "campaign", "lead", "outreach", "sequence"],
  "email.send": ["send", "email"],
  "email.draft": ["draft", "email"],
  "enrich.person": ["enrich", "person", "people", "contact", "lookup", "profile"],
  "crm.log": ["note", "activity", "log", "contact", "crm"],
  "sheet.update": ["row", "rows", "record", "append", "sheet", "table"],
  "ticket.reply": ["ticket", "tickets", "reply", "support", "conversation"],
  "order.lookup": ["order", "orders", "tracking", "shipment"],
  "accounting.bill": ["bill", "bills", "invoice", "expense", "payable"],
  "ats.stage": ["candidate", "application", "stage", "applicant"],
  "chat.message": ["message", "post", "channel", "chat"],
};
/** Families whose step reads (the rest commit). */
const READ_FAMILIES = new Set(["enrich.person", "order.lookup"]);

const writeRank = (t: UniverseTool) => (t.hints.includes("createHint") ? 0 : t.hints.includes("updateHint") ? 1 : 2) + (t.destructive ? 3 : 0);

/** Universe tools of one class for some words, at most one per toolkit, best first; tools with a hand-written policy,
 * toolkits already among the options and Composio's own helpers are left out. */
export function universeTools(idx: UniverseIndex, want: readonly string[], cls: "read" | "commit", o: { toolkit?: string; exclude?: ReadonlySet<string>; limit?: number; perToolkit?: number } = {}): UniverseTool[] {
  const scored = Object.values(idx.tools)
    .filter((t) => t.class === cls && t.toolkit !== "composio" && !hasStaticPolicy(t.slug) && !(o.exclude?.has(t.toolkit) ?? false) && (o.toolkit === undefined || t.toolkit === o.toolkit))
    .map((t) => ({ t, s: toolScore(t, want) }))
    .filter((x) => o.toolkit !== undefined || x.s > 0)
    .sort((a, b) => b.s - a.s || writeRank(a.t) - writeRank(b.t) || Number(b.t.important) - Number(a.t.important) || a.t.slug.length - b.t.slug.length || a.t.slug.localeCompare(b.t.slug));
  const out: UniverseTool[] = [];
  const per = new Map<string, number>();
  for (const { t } of scored) {
    const n = per.get(t.toolkit) ?? 0;
    if (n >= (o.perToolkit ?? 1)) continue;
    per.set(t.toolkit, n + 1);
    out.push(t);
    if (out.length >= (o.limit ?? 3)) break;
  }
  return out;
}

/** One universe tool as a step option: approved field by field, never above a hand-verified tool. */
export function universeOption(idx: UniverseIndex, t: UniverseTool, connected: ReadonlySet<string>): ToolOptionDTO {
  const tk = idx.toolkits[t.toolkit];
  const name = tk?.name ?? t.toolkit;
  const connectorId = universeTargetId(t.toolkit);
  const isConnected = connected.has(connectorId);
  return {
    id: genericVerb(t.slug),
    name,
    via: "composio",
    why: `${t.name.replace(/\.$/, "")} in ${name}, through Composio. You see every field before it runs.`,
    setup: "minutes",
    cost: "your existing plan",
    connected: isConnected,
    connectorId,
    mcpConfirmed: false,
    commitsAllowed: t.class === "commit" ? true : null,
    needsYou: isConnected ? null : `Set up ${name} once in Connections.`,
    verified: false,
    slug: t.slug,
  };
}

const toolkitsOf = (options: readonly ToolOptionDTO[]): Set<string> => {
  const out = new Set<string>();
  for (const o of options) {
    out.add(o.id.replace(/-/g, ""));
    if (o.connectorId !== null) {
      const c = connectorById(o.connectorId);
      if (c !== undefined && c.how.startsWith("composio:")) out.add(c.how.slice("composio:".length));
      out.add(o.connectorId.replace(/-/g, ""));
    }
  }
  return out;
};

/** Options for one family (+ the on-screen last resort), default chosen: connected and good enough, else the first. */
export function optionsFor(family: string, appName: string, connected: ReadonlySet<string>, perDay: number, o: { current?: string | null; readsOnly?: ReadonlyMap<string, string>; universe?: UniverseIndex | null } = {}): { options: ToolOptionDTO[]; chosen: string } {
  const capId = CATALOG_CAPABILITY[family];
  const fromCatalog = capId === undefined ? null : catalogOptions(capId, o.current ?? null, connected, o.readsOnly ?? new Map());
  let options: ToolOptionDTO[];
  if (fromCatalog !== null) options = fromCatalog;
  else {
    const mk = (c: Candidate): ToolOptionDTO => {
      const { maxPerDay: _m, ...rest } = c;
      return { ...rest, connected: c.via === "local" || (c.connectorId !== null && connected.has(c.connectorId)) };
    };
    options = (OPTIONS[family] ?? []).map(mk).slice(0, 3);
  }
  // s17: the remaining slots go to Composio universe tools for this family, after every catalog candidate.
  const words = FAMILY_WORDS[family];
  if (o.universe != null && words !== undefined && options.length < 3) {
    const cls = READ_FAMILIES.has(family) ? "read" : "commit";
    for (const t of universeTools(o.universe, words, cls, { exclude: toolkitsOf(options), limit: 3 - options.length })) options.push(universeOption(o.universe, t, connected));
  }
  if (options.length < 3 && family !== "doc.read") {
    const s = ONSCREEN(appName);
    options.push({ ...s, connected: false });
  }
  const mailbox = (x: ToolOptionDTO) => x.id === "gmail" || x.id === "outlook";
  // s17: a universe tool is never the default pick while a hand-verified one is offered.
  const verifiedOffered = options.some((x) => x.verified !== false && x.via !== "computer");
  const enough = (x: ToolOptionDTO) => x.needsYou == null && x.via !== "computer" && !(verifiedOffered && x.verified === false) && !(family === "email.send_bulk" && mailbox(x) && perDay > MAILBOX_PER_DAY);
  // 1. connected and good enough; 2. the tool the person uses today, when it is good enough; 3. the first option.
  const good = options.find((x) => x.connected && enough(x)) ?? options.find((x) => o.current != null && (x.connectorId === o.current || x.id === o.current) && enough(x));
  return { options, chosen: good?.id ?? options[0]!.id };
}

const VERBS: Record<string, string> = { "email.send_bulk": "sending", "email.send": "sending", "email.draft": "drafts", "enrich.person": "looking people up", "crm.log": "the log", "sheet.update": "writing the rows", "ticket.reply": "replies", "order.lookup": "order lookups", "accounting.bill": "bills", "ats.stage": "the candidate update", "doc.read": "reading the documents", "chat.message": "messages" };

export interface ToolInputs {
  plan?: { outputType: OutputType; variant: PlanVariantDTO };
  legacy?: { kind: string; steps: ReadonlyArray<{ id: string; type: string; title: string; connector: string | null }> };
  perDay: number;
  connected: ReadonlySet<string>;
  /** Catalog ids whose Composio account may only read (s13 chain), with the plain reason. */
  readsOnly?: ReadonlyMap<string, string>;
  /** s17: the Composio universe index; absent = the s14 options only. */
  universe?: UniverseIndex | null;
}

/** Rules recommendations for every step that needs a tool. */
export function recommendTools(i: ToolInputs): StepToolsDTO[] {
  const out: StepToolsDTO[] = [];
  const add = (stepId: string, family: string, need: string, appName: string, runsWith?: string, current?: string | null) => {
    const { options, chosen } = optionsFor(family, appName, i.connected, i.perDay, { current: current ?? null, ...(i.readsOnly === undefined ? {} : { readsOnly: i.readsOnly }), ...(i.universe == null ? {} : { universe: i.universe }) });
    const pick = options.find((o) => o.id === chosen)!;
    out.push({ stepId, capability: family, catalogCapability: CATALOG_CAPABILITY[family] ?? null, need, options, chosen, chosenBy: "default", runsWith: runsWith ?? chosen, suggestion: suggestionFor(VERBS[family] ?? "this step", pick) });
  };
  if (i.plan !== undefined) {
    for (const s of i.plan.variant.steps) {
      const f = capabilityFamily(s, i.plan.outputType, i.perDay);
      if (f !== null && s.capability !== null) add(s.id, f, s.capability.need, s.capability.targetName, undefined, s.capability.via === "catalog" ? s.capability.target : null);
      // s17: a commit in an app the catalog does not know: that app's own tools from the Composio universe.
      else if (f === null && s.type === "commit" && s.capability !== null && i.universe != null) {
        const step = universeStep(i.universe, s.id, s.capability, `${s.title} ${s.detail}`, i.connected);
        if (step !== null) out.push(step);
      }
    }
  }
  if (i.legacy !== undefined) {
    for (const s of i.legacy.steps) {
      const f = legacyFamily(s, i.legacy.kind, i.perDay);
      if (f !== null) add(s.id, f, s.title, s.connector === null ? "the app" : (connectorById(s.connector)?.name ?? s.connector), s.connector ?? "local", s.connector);
    }
  }
  return out;
}

/** s17: the step for a commit in an app only the universe knows: up to two of its commit tools, then the screen. */
export function universeStep(idx: UniverseIndex, stepId: string, cap: { need: string; target: string; targetName: string }, words: string, connected: ReadonlySet<string>): StepToolsDTO | null {
  const tk = toolkitForApp(idx, cap.targetName) ?? toolkitForApp(idx, cap.target.replace(/^(app|web)-/, "").replace(/-/g, "."));
  if (tk === null) return null;
  const want = `${words} ${cap.need}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const tools = universeTools(idx, want, "commit", { toolkit: tk.slug, limit: 2, perToolkit: 2 });
  if (tools.length === 0) return null;
  const options = [...tools.map((t) => universeOption(idx, t, connected)), { ...ONSCREEN(cap.targetName), connected: false }];
  const pick = options[0]!;
  return { stepId, capability: "universe.commit", catalogCapability: null, need: cap.need, options, chosen: pick.id, chosenBy: "default", runsWith: pick.id, suggestion: suggestionFor("this step", pick) };
}

const BAD = /[\d<>\u0000-\u001f]/;

/** Opus may reorder each step's options and reword `why` (ids from the candidates only; no digits). Invalid = ignored. */
export async function refineTools(tools: StepToolsDTO[], o: { model: Model; models: ModelConfig; context: string }): Promise<StepToolsDTO[]> {
  if (tools.length === 0) return tools;
  const baseline = { steps: tools.map((t) => ({ stepId: t.stepId, capability: t.capability, need: t.need, options: t.options.map((x) => ({ id: x.id, name: x.name, why: x.why, connected: x.connected })) })) };
  const prompt = [o.context, "<baseline>", JSON.stringify(baseline, null, 2), "</baseline>"].filter((l) => l !== "").join("\n");
  const system = [
    "For each workflow step below, order the tool options best first for this person's task and say in one plain sentence why each fits.",
    "Prefer an API or MCP route over using an app on screen. Prefer a tool already connected when it is good enough. No hype, no digits.",
    "Use only the option ids given. Reply with JSON only: {\"steps\":[{\"stepId\":\"...\",\"options\":[{\"id\":\"...\",\"why\":\"...\"}]}]}.",
  ].join("\n");
  const check = (t: string): StepToolsDTO[] | null => {
    const m = t.match(/\{[\s\S]*\}/);
    if (m === null) return null;
    let v: { steps?: Array<{ stepId?: unknown; options?: Array<{ id?: unknown; why?: unknown }> }> };
    try {
      v = JSON.parse(m[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(v.steps) || v.steps.length !== tools.length) return null;
    const next: StepToolsDTO[] = [];
    for (let k = 0; k < tools.length; k++) {
      const base = tools[k]!;
      const r = v.steps[k]!;
      if (r.stepId !== base.stepId || !Array.isArray(r.options) || r.options.length === 0 || r.options.length > 3) return null;
      const opts: ToolOptionDTO[] = [];
      for (const x of r.options) {
        const b = base.options.find((y) => y.id === x.id);
        if (b === undefined || opts.some((y) => y.id === b.id)) return null;
        const why = x.why === undefined ? b.why : x.why;
        if (typeof why !== "string" || why.trim() === "" || why.length > 200 || BAD.test(why)) return null;
        opts.push({ ...b, why: why.trim() });
      }
      // The default stays the rules default when it is still offered (connected and good enough wins over order).
      const chosen = opts.some((y) => y.id === base.chosen) ? base.chosen : opts[0]!.id;
      next.push({ ...base, options: opts, chosen, suggestion: suggestionFor(VERBS[base.capability] ?? "this step", opts.find((y) => y.id === chosen)!) });
    }
    return next;
  };
  try {
    const reply = await o.model.complete({ role: "workflow_design", model: modelFor("workflow_design", o.models), system, prompt, maxTokens: 2000, validate: (t) => (check(t) === null ? "the reply broke the tool rules" : null) });
    return check(reply) ?? tools;
  } catch {
    // The rules options are complete; the model only orders and words them.
    return tools;
  }
}

/** Every catalog id, for tests and the review: what the catalog already knows. */
export const CATALOG_IDS = new Set(CONNECTORS.map((c) => c.id));

/** The user's pick for one step (POST /workflows/:id/tools). Unknown step or option -> null. */
export function chooseTool(tools: readonly StepToolsDTO[], stepId: string, toolId: string, template: boolean): StepToolsDTO[] | null {
  const t = tools.find((x) => x.stepId === stepId);
  const o = t?.options.find((x) => x.id === toolId);
  if (t === undefined || o === undefined) return null;
  return tools.map((x) => (x.stepId !== stepId ? x : { ...x, chosen: o.id, chosenBy: "user" as const, runsWith: template ? x.runsWith : o.id, suggestion: suggestionFor(VERBS[x.capability] ?? "this step", o) }));
}

/** Keeps the user's picks for steps that are still there (a new variant was chosen). */
export function carryChoices(next: StepToolsDTO[], prev: readonly StepToolsDTO[] | undefined): StepToolsDTO[] {
  return next.map((t) => {
    const p = prev?.find((x) => x.stepId === t.stepId && x.capability === t.capability && x.chosenBy === "user");
    return p === undefined || !t.options.some((o) => o.id === p.chosen) ? t : { ...t, chosen: p.chosen, chosenBy: "user", runsWith: p.runsWith };
  });
}

/** Catalog ids whose cached s13 chain decision says Composio may only read (code "reads_only"), with the reason.
 * Read-only use of connector-chain.json; a missing or broken file means none. */
export function chainReadsOnly(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const p = chainPath(home);
  if (!existsSync(p)) return out;
  try {
    const f = JSON.parse(readFileSync(p, "utf8")) as { decisions?: Record<string, { methods?: Array<{ method?: string; code?: string }> }> };
    for (const [id, d] of Object.entries(f.decisions ?? {})) if ((d.methods ?? []).some((m) => m.method === "composio" && m.code === "reads_only")) out.set(id, READS_ONLY_WORDS);
  } catch {
    // Unreadable cache: nothing is known to be read-only.
  }
  return out;
}
