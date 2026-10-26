// s14 capability needs: what each plan step needs from an app, in plain words, for the s13 connector chain
// (MCP -> Composio -> direct API -> computer use) to resolve to a method. This file only NAMES needs; it never picks a
// method or a tool. Target ids follow s13's convention (connectors/targets.ts appTargetId): a catalog connector id
// when the surface is in the catalog, else `web-<host slug>` for a site in a browser and `app-<name slug>` for a Mac app.
// s13 is merged: commit capabilities come from its targets.ts (catalogTarget); `slugify`/`appTargetId` mirror its
// convention. SEAM left: `CapabilityResolver` -> connectors/chain.ts resolve(target, [capability]).
import type { CapabilityNeedDTO, CapabilityResolutionDTO } from "../api/s14-types.ts";
import { connectorById } from "../connectors/catalog.ts";
import { catalogTarget } from "../connectors/targets.ts";
import type { UnderstandingStep } from "../types.ts";
import { surfaceReach } from "../understanding/reach.ts";
import { knownSurfaceAt } from "../understanding/surfaces.ts";
import { baseVerb } from "../understanding/verbs.ts";

/** Lowercase letters, digits and single dashes; at most 40 characters; "app" when nothing is left (s13 slugify). */
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

const BROWSERS = new Set(["com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.brave.Browser"]);

/** s13 appTargetId: `web-<host>` for a browser surface with a host, else `app-<name or bundle>`. */
export function appTargetId(app: string, appName: string, host: string): string {
  if (host !== "" && (BROWSERS.has(app) || app === "")) return `web-${slugify(host.replace(/^www\./, ""))}`;
  return `app-${slugify(appName !== "" ? appName : app)}`;
}

const cap = (s: string) => (s === "" ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** Display name of a site or app ("go.xero.com" -> "Xero", "acme.zendesk.com" -> "Zendesk"). */
export function surfaceName(app: string, appName: string, host: string): string {
  if (host === "" || !(BROWSERS.has(app) || app === "")) return appName !== "" ? appName : app;
  const parts = host.replace(/^www\./, "").split(".");
  const base = parts.length >= 2 ? parts[parts.length - 2]! : parts[0]!;
  return cap(base);
}

export interface StepTarget {
  target: string;
  targetName: string;
  via: CapabilityNeedDTO["via"];
  connectorId: string | null;
}

export function targetOf(s: Pick<UnderstandingStep, "app" | "appName" | "host" | "surfaceKey">): StepTarget {
  const r = surfaceReach({ app: s.app, host: s.host, urlPattern: s.surfaceKey.split("|")[2] ?? "", activeMs: 0 });
  if (r.connectorId !== null) return { target: r.connectorId, targetName: connectorById(r.connectorId)?.name ?? s.appName, via: "catalog", connectorId: r.connectorId };
  // s20: a known product keeps its own name ("Google Docs", not "Google" from docs.google.com).
  const known = knownSurfaceAt(s.app, s.host, s.surfaceKey.split("|")[2] ?? "");
  return { target: appTargetId(s.app, s.appName, s.host), targetName: known?.routable === true ? known.name : surfaceName(s.app, s.appName, s.host), via: r.via, connectorId: null };
}

/** Canonical read capability for a target (s13 vocabulary: mail.read, screen.read; s14 adds file.read). */
export function readCapability(t: StepTarget): string {
  if (t.connectorId === "gmail") return "mail.read";
  if (t.via === "local_file") return "file.read";
  return "screen.read";
}

/** s20 review 4: the verbs each catalog commit capability really does. A commit capability must MATCH the step's verb:
 * "delete the email" is never mail.send and "pay the invoice" never accounting.bill. A capability missing here does no
 * verb (a new allowlisted one must be added on purpose). */
export const CAPABILITY_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  "mail.send": new Set(["send", "reply", "answer", "respond", "write", "message", "compose", "forward"]),
  "chat.post": new Set(["post", "message", "send", "reply", "answer", "respond", "comment", "write"]),
  "ticket.reply": new Set(["reply", "answer", "respond", "send", "write", "comment"]),
  "crm.note": new Set(["note", "log", "record", "add", "write", "comment"]),
  "crm.task": new Set(["create", "add", "assign", "schedule", "log"]),
  "accounting.bill": new Set(["create", "enter", "add", "record", "key in", "fill in", "file", "bill"]),
  "sheet.append": new Set(["add", "append", "log", "record"]),
  "table.create_record": new Set(["create", "add", "enter", "record", "log", "key in", "fill in"]),
  "ats.move_stage": new Set(["move", "update", "advance"]),
  "outreach.add_lead": new Set(["add", "enter", "upload", "import"]),
  "outreach.resume_lead": new Set(["resume"]),
};

/** s20 review 5: verbs that say only "change something" (add, create, record, ...): they map to a catalog commit only
 * when the step's object is what that commit makes ("create the invoice" = a bill; "create the contact" is not). */
export const BROAD_VERBS: ReadonlySet<string> = new Set(["add", "create", "record", "update", "log", "enter", "key in", "fill in", "file", "edit"]);
/** What each catalog commit makes or changes (matched on the step's object for a broad verb). */
export const CAPABILITY_OBJECTS: Readonly<Record<string, RegExp>> = {
  "mail.send": /\b(e-?mails?|mails?|messages?|repl(y|ies)|drafts?)\b/i,
  "chat.post": /\b(messages?|posts?|repl(y|ies)|comments?|threads?)\b/i,
  "ticket.reply": /\b(tickets?|repl(y|ies)|cases?|conversations?|comments?)\b/i,
  "crm.note": /\b(notes?|comments?|activit(y|ies))\b/i,
  "crm.task": /\b(tasks?|to-?dos?|follow-?ups?|reminders?)\b/i,
  "accounting.bill": /\b(bills?|invoices?|expenses?|receipts?|claims?)\b/i,
  "sheet.append": /\b(rows?|lines?|entr(y|ies)|leads?|records?|sheets?|logs?)\b/i,
  "table.create_record": /\b(records?|rows?|entr(y|ies)|items?)\b/i,
  // Greenhouse "update candidate record" moving its stage is pinned by s14 (plan.test.ts), so candidates count.
  "ats.move_stage": /\b(stages?|status|applications?|candidates?)\b/i,
  "outreach.add_lead": /\b(leads?|prospects?|contacts?)\b/i,
  "outreach.resume_lead": /\b(leads?|sequences?)\b/i,
};

/** Canonical commit capability: the catalog target's allowlisted commit (s13 targets.ts, from the s16 policies) whose
 * verbs include the step's verb, and for a broad verb whose object is the step's object (when the caller knows it),
 * else ui.commit (computer use, gated like every commit). Never another write. */
export function commitCapability(t: StepTarget, verb: string, object?: string): string {
  if (t.connectorId === null) return "ui.commit";
  const ct = catalogTarget(t.connectorId);
  const v = baseVerb(verb);
  const fits = (c: string) => CAPABILITY_VERBS[c]?.has(v) === true && (object === undefined || !BROAD_VERBS.has(v) || CAPABILITY_OBJECTS[c]?.test(object) === true);
  return [...(ct?.sends ?? []), ...(ct?.logs ?? [])].find(fits) ?? "ui.commit";
}

/** The chain's answer for every need. */
export interface CapabilityResolver {
  resolve(needs: readonly CapabilityNeedDTO[]): Promise<CapabilityResolutionDTO[]>;
}

/** Default until s13's chain is wired in: every need is `pending`, with the method the chain would try first. */
export class PendingChainResolver implements CapabilityResolver {
  async resolve(needs: readonly CapabilityNeedDTO[]): Promise<CapabilityResolutionDTO[]> {
    const seen = new Set<string>();
    const out: CapabilityResolutionDTO[] = [];
    for (const n of needs) {
      const k = `${n.target}\u0000${n.capability}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const first = n.via === "catalog" ? "its connector" : n.via === "local_file" ? "reading the file on this Mac" : "using the app on screen";
      out.push({ target: n.target, capability: n.capability, status: "pending", method: null, reason: `${n.targetName}: not checked yet; Offload will try ${first} first` });
    }
    return out;
  }
}
