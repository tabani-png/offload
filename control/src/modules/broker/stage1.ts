/**
 * The Stage 1 gate functions, imported read-only from the brain (ADR 0105 §3: one implementation for Mac and cloud).
 * Every function used here is pure: batch.ts and denied.ts import only node:crypto; allowlist.ts adds node:url
 * (`domainToASCII`). Nothing is copied, so `broker/stage1/` does not exist (SPEC S2-07 "Reuse").
 *
 * The bridge between a Stage 2 batch item (`{key, capability, fields: [label, value][]}`, batch.schema.json) and a
 * Stage 1 `BatchItem` is fixed and lossless:
 *   fields = [["to", to], ["subject", subject], ["body", body]]                       an email item (no commit)
 *          + [["verb", commit.verb], ...commit.fields]                                 an item that carries its commit
 * "to", "subject" and "body" are required, once each; "verb" at most once. Any other label is a commit field, kept in
 * order. Commit fields without "verb" mean verb "send" (s16: an email with extra fields, e.g. Smartlead from_email).
 * The key is the lowercased recipient, as in Stage 1 `makeBatch`.
 */
import { createHash } from "node:crypto";
import { batchHash, type BatchItem, type ItemCommit } from "../../../../brain/src/workflows/batch.ts";
import {
  canonicalArgs,
  expectedArgs,
  expectedHash,
  normaliseAddress,
  TOOL_POLICIES,
  type CrmSheet,
  type Flavor,
  type ToolPolicy,
} from "../../../../brain/src/workflows/allowlist.ts";
import { DENIED_ON_PURPOSE } from "../../../../brain/src/workflows/denied.ts";
import { TOOL_CAPABILITY } from "../../../../brain/src/connectors/targets.ts";

export { batchHash, canonicalArgs, expectedArgs, expectedHash, normaliseAddress, DENIED_ON_PURPOSE };
export type { BatchItem, CrmSheet, ToolPolicy };

/** Stage 2 batches are always live Stage 1 batches (dry-run nights queue for a person, they are not dry-run batches). */
export const KIND = "live" as const;

export type Field = [string, string];

export interface Stage2Item {
  key: string;
  capability: string;
  fields: Field[];
}

const RESERVED = new Set(["to", "subject", "body", "verb"]);

/** Fields → Stage 1 item, or why the fields cannot be one. */
export function toStage1(item: Stage2Item): { item: BatchItem } | { reason: string } {
  const seen = new Map<string, string>();
  const commitFields: Field[] = [];
  for (const f of item.fields) {
    if (!Array.isArray(f) || f.length !== 2 || typeof f[0] !== "string" || typeof f[1] !== "string") {
      return { reason: "every field is a [label, value] pair of strings" };
    }
    const [label, value] = f;
    if (RESERVED.has(label)) {
      if (seen.has(label)) return { reason: `field "${label}" appears twice` };
      seen.set(label, value);
    } else {
      commitFields.push([label, value]);
    }
  }
  for (const r of ["to", "subject", "body"]) if (!seen.has(r)) return { reason: `field "${r}" is required` };
  const to = seen.get("to")!;
  if (to.trim() === "") return { reason: "the recipient (to) is empty" };
  if (item.key !== to.toLowerCase()) return { reason: `item key must be the lowercased recipient (${JSON.stringify(item.key).slice(0, 60)})` };
  const verb = seen.get("verb");
  if (verb !== undefined && verb.trim() === "") return { reason: "verb is empty" };
  const commit: ItemCommit | undefined =
    verb !== undefined || commitFields.length > 0 ? { verb: verb ?? "send", fields: commitFields } : undefined;
  return {
    item: {
      key: to.toLowerCase(),
      to,
      subject: seen.get("subject")!,
      body: seen.get("body")!,
      warnings: [],
      ...(commit === undefined ? {} : { commit }),
    },
  };
}

/** Stage 1 item → fields, in the canonical order above (toStage1(fromStage1(i)) == i). */
export function fromStage1(i: BatchItem): Field[] {
  const out: Field[] = [
    ["to", i.to],
    ["subject", i.subject],
    ["body", i.body],
  ];
  if (i.commit !== undefined) out.push(["verb", i.commit.verb], ...i.commit.fields.map(([l, v]) => [l, v] as Field));
  return out;
}

/** The Stage 1 batch hash of a Stage 2 batch (brain `batchHash`, byte for byte). */
export function stage1Hash(workflowId: string, items: readonly BatchItem[]): string {
  return batchHash(workflowId, KIND, items);
}

/** Per-item hash: the Stage 1 batch hash of a batch holding only this item. */
export function itemHashOf(workflowId: string, item: BatchItem): string {
  return batchHash(workflowId, KIND, [item]);
}

/** Content-free reference to an item, as Stage 1 `itemRef` (gate.ts): sha256(workflow id NUL key), 16 hex. */
export function itemRef(workflowId: string, key: string): string {
  return createHash("sha256").update(`${workflowId}\u0000${key.toLowerCase()}`).digest("hex").slice(0, 16);
}

/** The recipient as the allowlist and the ledger see it (normalised address, or the lowercased raw value). */
export function recipientOf(item: BatchItem): string {
  return normaliseAddress(item.to) ?? item.to.trim().toLowerCase();
}

// ---------- commit capability → Stage 1 tool policy ----------

/** How the broker reaches a connection. Read-only vault credentials never commit. */
export type Method = "composio" | "mcp" | "api";

/** Policy flavours each method may use. Direct API calls use the verified Composio argument schemas (same fields). */
const FLAVORS: Record<Method, readonly Flavor[]> = {
  composio: ["composio"],
  mcp: ["gmail-mcp", "sheets-mcp"],
  api: ["composio"],
};

const COMPOSIO_CONNECTORS = [
  "gmail", "google-sheets", "outlook", "instantly", "smartlead", "hubspot", "attio", "salesforce", "xero",
  "quickbooks", "zendesk", "intercom", "airtable", "slack", "greenhouse",
];

/** Brain connector ids a connection kind can commit through. linkedin_personal: none, ever. */
export const CONNECTORS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  gmail: ["gmail", "google-sheets"],
  google_workspace_shared: ["gmail", "google-sheets"],
  outlook: ["outlook"],
  m365_shared_mailbox: ["outlook"],
  composio_org: COMPOSIO_CONNECTORS,
  company_mcp: ["gmail", "google-sheets"],
  api: COMPOSIO_CONNECTORS,
  crm: ["hubspot", "attio", "salesforce"],
  company_linkedin_page: [],
  linkedin_personal: [],
  other: COMPOSIO_CONNECTORS,
};

export function methodOf(provider: string): Method | null {
  if (provider === "composio") return "composio";
  if (provider === "mcp") return "mcp";
  if (provider === "api") return "api";
  return null;
}

/** Commit capabilities the Stage 1 allowlist knows (role send or log). */
export const COMMIT_CAPABILITIES: ReadonlySet<string> = new Set(
  TOOL_POLICIES.filter((p) => (p.role === "send" || p.role === "log") && TOOL_CAPABILITY[p.tool] !== undefined).map(
    (p) => TOOL_CAPABILITY[p.tool]!,
  ),
);

/**
 * The one Stage 1 policy that commits this item: a static allowlist policy for the capability, reachable by the
 * connection, whose expected arguments can be built for the item and pass the policy's own schema. Read, draft and
 * input tools never commit; "still denied on purpose" tools are never chosen.
 */
export function policyForItem(
  capability: string,
  item: BatchItem,
  conn: { kind: string; method: Method },
  ctx: { batchHash: string; crmSheet?: CrmSheet },
): { policy: ToolPolicy } | { reason: string } {
  const connectors = CONNECTORS_BY_KIND[conn.kind] ?? [];
  const candidates = TOOL_POLICIES.filter(
    (p) =>
      (p.role === "send" || p.role === "log") &&
      p.server === undefined &&
      TOOL_CAPABILITY[p.tool] === capability &&
      FLAVORS[conn.method].includes(p.flavor) &&
      connectors.includes(p.connector) &&
      !DENIED_ON_PURPOSE.has(p.tool),
  );
  if (candidates.length === 0) return { reason: `no allowlisted ${capability} commit through a ${conn.kind} connection` };
  let first: string | null = null;
  for (const p of candidates) {
    const h = expectedHash(p, item, ctx);
    if (!("reason" in h)) return { policy: p };
    first ??= h.reason;
  }
  return { reason: first ?? `the item cannot be expressed as ${capability}` };
}

/** Gate check (Stage 1 `matchItem` for one item): the call's full canonical arguments must hash like the approved
 * item's expected arguments under the same policy. */
export function checkCall(
  p: ToolPolicy,
  item: BatchItem,
  args: Record<string, unknown>,
  ctx: { batchHash: string; crmSheet?: CrmSheet },
): { ok: true } | { ok: false; reason: string } {
  const got = canonicalArgs(p, args);
  if ("reason" in got) return { ok: false, reason: got.reason };
  const exp = expectedHash(p, item, ctx);
  if ("reason" in exp) return { ok: false, reason: exp.reason };
  return exp.hash === got.hash
    ? { ok: true }
    : { ok: false, reason: "arguments differ from the approved item (every field must be exactly as approved)" };
}
