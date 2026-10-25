// The tool allowlist the approval gate enforces (REVIEW-1 B1, H1, M1). Per connector and server flavour there is
// exactly one canonical send tool, at most one canonical CRM log tool, and an explicit list of read tools. Each
// side-effect tool declares its full argument schema. The gate canonicalises the whole argument object with that
// schema (sorted keys, normalised addresses incl. IDN, normalised text) and compares its hash with the hash of the
// arguments it expects for an approved item. Anything not listed here is denied: unknown tools, meta/multiplexer
// tools, shells, forward, reply, drafts. Tool names marked `verified: false` were taken from the servers' docs and are
// not yet checked against a live Gmail MCP / Composio account (brain/CONNECTORS.md); a renamed tool fails closed.
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import type { BatchItem } from "./batch.ts";

export type Role = "read" | "send" | "log";
export type Flavor = "gmail-mcp" | "composio" | "sheets-mcp" | "calendar-mcp";

/** How one argument is checked and canonicalised. */
export type FieldSpec =
  /** Recipient list: a string (comma/semicolon separated) or an array; normalised, sorted. Required when expected. */
  | { kind: "addresses" }
  /** Free text (subject, body): NFC, CRLF -> LF, otherwise exact. */
  | { kind: "text" }
  /** An id that must equal the configured value exactly (spreadsheet id, range). */
  | { kind: "id" }
  /** Rows of cells: string[][], each cell text-normalised. */
  | { kind: "rows" }
  /** Optional; when present it must be one of `values`. Dropped from the canonical form. */
  | { kind: "fixed"; values: readonly (string | boolean)[] }
  /** Optional; when present it must be empty ("", [], null). Anything else is refused by name. */
  | { kind: "empty" }
  /** Read tools: any value (reads are not matched to items). */
  | { kind: "any" };

export interface CrmSheet {
  spreadsheetId: string;
  range: string;
}

export interface ToolPolicy {
  connector: string;
  flavor: Flavor;
  tool: string;
  role: Role;
  /** Checked against a live server on this machine. All false until a human connects an account (CONNECTORS.md). */
  verified: boolean;
  /** Side-effect tools only: every key the tool may receive. Unknown keys are refused. */
  fields?: Readonly<Record<string, FieldSpec>>;
  /** The arguments the gate expects for one approved item (before canonicalisation). null = cannot be built. */
  expected?: (item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }) => Record<string, unknown> | null;
}

const GMAIL_MCP_SEND_FIELDS: Record<string, FieldSpec> = {
  to: { kind: "addresses" },
  subject: { kind: "text" },
  body: { kind: "text" },
  cc: { kind: "empty" },
  bcc: { kind: "empty" },
  htmlBody: { kind: "empty" },
  attachments: { kind: "empty" },
  threadId: { kind: "empty" },
  inReplyTo: { kind: "empty" },
  references: { kind: "empty" },
  messageId: { kind: "empty" },
  mimeType: { kind: "fixed", values: ["text/plain"] },
};

const COMPOSIO_SEND_FIELDS: Record<string, FieldSpec> = {
  recipient_email: { kind: "addresses" },
  subject: { kind: "text" },
  body: { kind: "text" },
  cc: { kind: "empty" },
  bcc: { kind: "empty" },
  extra_recipients: { kind: "empty" },
  attachment: { kind: "empty" },
  thread_id: { kind: "empty" },
  is_html: { kind: "fixed", values: [false] },
  user_id: { kind: "fixed", values: ["me"] },
};

const SHEET_APPEND_FIELDS: Record<string, FieldSpec> = {
  spreadsheetId: { kind: "id" },
  range: { kind: "id" },
  values: { kind: "rows" },
  valueInputOption: { kind: "fixed", values: ["RAW", "USER_ENTERED"] },
  insertDataOption: { kind: "fixed", values: ["INSERT_ROWS"] },
};

/** The CRM row the log tool may append for an item: no timestamp, so it is fixed at approval time. */
export const crmRow = (item: BatchItem, batchHash: string): string[] => [item.to, item.subject, batchHash.slice(0, 12), "sent"];

const sheetRow = (item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }) =>
  ctx.crmSheet === undefined ? null : { spreadsheetId: ctx.crmSheet.spreadsheetId, range: ctx.crmSheet.range, values: [crmRow(item, ctx.batchHash)] };

const read = (connector: string, flavor: Flavor, tool: string): ToolPolicy => ({ connector, flavor, tool, role: "read", verified: false });

export const TOOL_POLICIES: readonly ToolPolicy[] = [
  // Gmail through a local Gmail MCP server (@gongrzhe/server-gmail-autoauth-mcp).
  { connector: "gmail", flavor: "gmail-mcp", tool: "send_email", role: "send", verified: false, fields: GMAIL_MCP_SEND_FIELDS, expected: (i) => ({ to: [i.to], subject: i.subject, body: i.body }) },
  read("gmail", "gmail-mcp", "search_emails"),
  read("gmail", "gmail-mcp", "read_email"),
  read("gmail", "gmail-mcp", "list_email_labels"),
  // Gmail through Composio.
  { connector: "gmail", flavor: "composio", tool: "GMAIL_SEND_EMAIL", role: "send", verified: false, fields: COMPOSIO_SEND_FIELDS, expected: (i) => ({ recipient_email: i.to, subject: i.subject, body: i.body }) },
  read("gmail", "composio", "GMAIL_FETCH_EMAILS"),
  read("gmail", "composio", "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"),
  // The CRM sheet: one append tool per flavour.
  { connector: "google-sheets", flavor: "composio", tool: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", role: "log", verified: false, fields: SHEET_APPEND_FIELDS, expected: sheetRow },
  { connector: "google-sheets", flavor: "sheets-mcp", tool: "append_row", role: "log", verified: false, fields: SHEET_APPEND_FIELDS, expected: sheetRow },
  // Calendar (scheduling replies): reads only.
  read("google-calendar", "composio", "GOOGLECALENDAR_FIND_FREE_SLOTS"),
  read("google-calendar", "composio", "GOOGLECALENDAR_EVENTS_LIST"),
  read("google-calendar", "calendar-mcp", "find_free_slots"),
];

/**
 * Server name -> catalog ids it covers, used when the caller has no connectors.json mapping (tests, docs examples).
 * The runner passes the real mapping from connectors.json.
 */
export const DEFAULT_SERVERS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["gmail"],
  sheets: ["google-sheets"],
  calendar: ["google-calendar"],
  composio: ["gmail", "google-sheets", "google-calendar"],
};

/** Never allowed, whatever a server calls them: multiplexers, shells, code runners, forward, reply, drafts. */
const NEVER_RE = /multi_?execute|execute|remote_?bash|bash|shell|workbench|eval|run_?action|proxy|forward|reply|draft|_run_|^run_/i;
/** Input keys that carry a nested tool call or code. */
const NESTED_KEY_RE = /^(tools?|tool_?slug|tool_?name|tool_?calls?|actions?|command|cmd|script|code|slug)$/i;

export function splitMcpName(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3 || parts[1] === "") return null;
  return { server: parts[1]!, tool: parts.slice(2).join("__") };
}

function nestedKey(x: unknown, depth = 0): string | null {
  if (depth > 8 || typeof x !== "object" || x === null) return null;
  for (const [k, v] of Object.entries(x)) {
    if (!Array.isArray(x) && NESTED_KEY_RE.test(k)) return k;
    const deeper = nestedKey(v, depth + 1);
    if (deeper !== null) return deeper;
  }
  return null;
}

/** The policy for `mcp__<server>__<tool>`, or why there is none. */
export function policyFor(name: string, servers: Readonly<Record<string, readonly string[]>> = DEFAULT_SERVERS, input?: Record<string, unknown>): ToolPolicy | { reason: string } {
  const mcp = splitMcpName(name);
  if (mcp === null) return { reason: "built-in tools are disabled in workflow runs" };
  if (NEVER_RE.test(mcp.tool)) return { reason: `${mcp.tool} is a meta, shell, forward, reply or draft tool: never allowed` };
  if (input !== undefined) {
    const k = nestedKey(input);
    if (k !== null) return { reason: `input carries a nested tool call or code (${k}): never allowed` };
  }
  const covers = Object.hasOwn(servers, mcp.server) ? servers[mcp.server] : undefined;
  if (covers === undefined || !Array.isArray(covers)) return { reason: `server ${mcp.server} is not a connected server: not on the allowlist` };
  const p = TOOL_POLICIES.find((x) => x.tool === mcp.tool && covers.includes(x.connector));
  if (p === undefined) return { reason: `${mcp.tool} on ${mcp.server} is not on the allowlist (unknown tools are denied)` };
  return p;
}

// ---------- canonicalisation ----------

const ADDRESS_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/u;

/** Lowercased, NFC, IDN domain in ASCII (punycode). null when it is not one bare address. */
export function normaliseAddress(raw: string): string | null {
  const s = raw.normalize("NFC").trim().toLowerCase();
  if (!ADDRESS_RE.test(s)) return null;
  const at = s.lastIndexOf("@");
  const local = s.slice(0, at);
  const domain = domainToASCII(s.slice(at + 1));
  if (domain === "" || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return null;
  return `${local}@${domain}`;
}

const text = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n");
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

function canonValue(key: string, spec: FieldSpec, v: unknown): { value: unknown } | { drop: true } | { reason: string } {
  switch (spec.kind) {
    case "any":
      return { value: v };
    case "empty":
      return isEmpty(v) ? { drop: true } : { reason: `${key} is not allowed` };
    case "fixed":
      return spec.values.includes(v as string | boolean) ? { drop: true } : { reason: `${key} must be ${spec.values.map(String).join(" or ")}` };
    case "text":
    case "id":
      return typeof v === "string" ? { value: text(v) } : { reason: `${key} must be a string` };
    case "rows": {
      if (!Array.isArray(v) || !v.every((r) => Array.isArray(r) && r.every((c) => typeof c === "string" || typeof c === "number"))) return { reason: `${key} must be rows of cells` };
      return { value: (v as Array<Array<string | number>>).map((r) => r.map((c) => text(String(c)))) };
    }
    default:
      return { reason: `${key} has no schema` };
    case "addresses": {
      const parts = typeof v === "string" ? v.split(/[,;]/) : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]).flatMap((x) => x.split(/[,;]/)) : null;
      if (parts === null) return { reason: `${key} must be an address or a list of addresses` };
      const out: string[] = [];
      for (const p of parts) {
        if (p.trim() === "") continue;
        const a = normaliseAddress(p);
        if (a === null) return { reason: `${key} holds something that is not one plain address: ${JSON.stringify(p.trim()).slice(0, 80)}` };
        out.push(a);
      }
      return { value: out.sort() };
    }
  }
}

function sortedJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(sortedJson).join(",")}]`;
  if (typeof x === "object" && x !== null) {
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((x as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

/** Canonical form of the FULL argument object under the tool's schema, and its sha256. */
export function canonicalArgs(p: ToolPolicy, input: Record<string, unknown>): { canonical: string; hash: string } | { reason: string } {
  const fields = p.fields;
  if (fields === undefined) return { reason: `${p.tool} has no argument schema` };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { reason: "arguments must be an object" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const spec = Object.hasOwn(fields, k) ? fields[k] : undefined;
    if (spec === undefined) return { reason: `unknown argument ${k} for ${p.tool}` };
    const c = canonValue(k, spec, v);
    if ("reason" in c) return c;
    if ("value" in c) out[k] = c.value;
  }
  const canonical = sortedJson(out);
  return { canonical, hash: createHash("sha256").update(canonical).digest("hex") };
}

/** Hash of the arguments expected for `item` under `p`, or why it cannot be built. */
export function expectedHash(p: ToolPolicy, item: BatchItem, ctx: { batchHash: string; crmSheet?: CrmSheet }): { hash: string } | { reason: string } {
  const args = p.expected?.(item, ctx) ?? null;
  if (args === null) return { reason: p.role === "log" ? "no CRM sheet is configured for this workflow (workflow.json inputs.crmSheet)" : `${p.tool} has no expected arguments` };
  const c = canonicalArgs(p, args);
  return "reason" in c ? { reason: `approved item ${item.key} cannot be expressed for ${p.tool}: ${c.reason}` } : { hash: c.hash };
}

/** Role of a tool name under the default mapping (for summaries of old batch results). */
export function roleOfTool(name: string, servers?: Readonly<Record<string, readonly string[]>>): Role | null {
  const p = policyFor(name, servers);
  return "reason" in p ? null : p.role;
}
