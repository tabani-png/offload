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
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";

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
}

export interface StepToolsDTO {
  stepId: string;
  /** Capability family ("email.send_bulk", "enrich.person", "crm.log", ...). */
  capability: string;
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
export function capabilityFamily(step: { type: string; capability: { target: string; capability: string; via: string; role: string } | null }, out: OutputType, perDay: number): string | null {
  const c = step.capability;
  if (c === null) return null;
  const t = c.target;
  if (c.via === "local_file") return "doc.read";
  if (step.type === "read") {
    if (/linkedin/.test(t)) return "enrich.person";
    if (/shopify/.test(t)) return "order.lookup";
    return null;
  }
  if (step.type !== "commit") return null;
  if (out === "email") return perDay >= 30 ? "email.send_bulk" : "email.send";
  if (out === "ticket_reply") return "ticket.reply";
  if (out === "message") return "chat.message";
  if (out === "rows") return "sheet.update";
  if (out === "form_fields" && /xero/.test(t)) return "accounting.bill";
  if (out === "stage_change" && /greenhouse/.test(t)) return "ats.stage";
  if (c.role === "log") return "crm.log";
  return null;
}

/** The family of a legacy (template) step: s05 email templates send through Gmail and log to the CRM sheet. */
export function legacyFamily(step: { type: string; connector: string | null }, kind: string, perDay: number): string | null {
  if (step.type === "send" && step.connector === "gmail") return kind === "email.outreach" ? (perDay >= 30 ? "email.send_bulk" : "email.send") : "email.send";
  if (step.type === "log") return "crm.log";
  return null;
}

function viaWords(o: ToolOptionDTO): string {
  if (o.connected) return "Already connected.";
  if (o.via === "composio") return "Connect via Composio.";
  if (o.via === "mcp") return "Connect its MCP server.";
  if (o.via === "api") return "Connect with an API key.";
  if (o.via === "local") return "Nothing to connect.";
  return "Runs on screen.";
}

export function suggestionFor(verb: string, o: ToolOptionDTO): string {
  return `Use ${o.name} for ${verb}: ${o.why.replace(/\.$/, "")}. ${viaWords(o)}`;
}

/** Options for one family (+ the on-screen last resort), default chosen: connected and good enough, else the first. */
export function optionsFor(family: string, appName: string, connected: ReadonlySet<string>, perDay: number): { options: ToolOptionDTO[]; chosen: string } {
  const cands = [...(OPTIONS[family] ?? [])];
  const mk = (c: Candidate): ToolOptionDTO => {
    const { maxPerDay: _m, ...rest } = c;
    return { ...rest, connected: c.via === "local" || (c.connectorId !== null && connected.has(c.connectorId)) };
  };
  const all = cands.map(mk);
  const options = all.slice(0, 3);
  if (options.length < 3 && family !== "doc.read") options.push(mk(ONSCREEN(appName)));
  const good = cands.find((c) => c.connectorId !== null && connected.has(c.connectorId) && (c.maxPerDay === undefined || perDay <= c.maxPerDay));
  return { options, chosen: good?.id ?? options[0]!.id };
}

const VERBS: Record<string, string> = { "email.send_bulk": "sending", "email.send": "sending", "email.draft": "drafts", "enrich.person": "looking people up", "crm.log": "the log", "sheet.update": "writing the rows", "ticket.reply": "replies", "order.lookup": "order lookups", "accounting.bill": "bills", "ats.stage": "the candidate update", "doc.read": "reading the documents", "chat.message": "messages" };

export interface ToolInputs {
  plan?: { outputType: OutputType; variant: PlanVariantDTO };
  legacy?: { kind: string; steps: ReadonlyArray<{ id: string; type: string; title: string; connector: string | null }> };
  perDay: number;
  connected: ReadonlySet<string>;
}

/** Rules recommendations for every step that needs a tool. */
export function recommendTools(i: ToolInputs): StepToolsDTO[] {
  const out: StepToolsDTO[] = [];
  const add = (stepId: string, family: string, need: string, appName: string, runsWith?: string) => {
    const { options, chosen } = optionsFor(family, appName, i.connected, i.perDay);
    const pick = options.find((o) => o.id === chosen)!;
    out.push({ stepId, capability: family, need, options, chosen, chosenBy: "default", runsWith: runsWith ?? chosen, suggestion: suggestionFor(VERBS[family] ?? "this step", pick) });
  };
  if (i.plan !== undefined) {
    for (const s of i.plan.variant.steps) {
      const f = capabilityFamily(s, i.plan.outputType, i.perDay);
      if (f !== null && s.capability !== null) add(s.id, f, s.capability.need, s.capability.targetName);
    }
  }
  if (i.legacy !== undefined) {
    for (const s of i.legacy.steps) {
      const f = legacyFamily(s, i.legacy.kind, i.perDay);
      if (f !== null) add(s.id, f, s.title, s.connector === null ? "the app" : (connectorById(s.connector)?.name ?? s.connector), s.connector ?? "local");
    }
  }
  return out;
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
