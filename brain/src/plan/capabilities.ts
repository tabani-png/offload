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
  return { target: appTargetId(s.app, s.appName, s.host), targetName: surfaceName(s.app, s.appName, s.host), via: r.via, connectorId: null };
}

/** Canonical read capability for a target (s13 vocabulary: mail.read, screen.read; s14 adds file.read). */
export function readCapability(t: StepTarget): string {
  if (t.connectorId === "gmail") return "mail.read";
  if (t.via === "local_file") return "file.read";
  return "screen.read";
}

/** Canonical commit capability: the catalog target's allowlisted commit (s13 targets.ts, from the s16 policies:
 * mail.send, accounting.bill, ticket.reply, ats.move_stage, ...), else ui.commit (computer use). Sheets only append. */
export function commitCapability(t: StepTarget, verb: string): string {
  if (t.connectorId === null) return "ui.commit";
  if (t.connectorId === "google-sheets") return /^(add|append|log|record)$/.test(verb) ? "sheet.append" : "ui.commit";
  const ct = catalogTarget(t.connectorId);
  return ct?.sends[0] ?? ct?.logs[0] ?? "ui.commit";
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
