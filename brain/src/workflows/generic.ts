// s17: generic exact approval for any Composio commit tool that has no hand-written s16 policy (SPEC s17 decision 3).
// The approved item carries the tool's COMPLETE canonical arguments and the sha256 of the input schema the person saw:
//   item.commit = { verb: "composio:<SLUG>", fields: [["schema", <sha256>], ["args", <canonical JSON>]] }
// so the batch hash covers every argument. The gate (unchanged, gate.ts) then allows `mcp__composio_cli__<SLUG>` only
// for a live, intact, approved batch with a declared send through that connection, when the policy's schema (fetched
// fresh at run time) still has the approved hash and the canonical hash of the FULL call equals the item's, once.
// Canonical form: validated against the input schema (unknown keys refused wherever the schema declares the object's
// fields, required keys present, JSON types and enums checked, prototype keys refused), strings NFC with CRLF as LF,
// keys sorted. The review (genericReview) shows every leaf of those same canonical bytes as one row; nothing is folded.
import { createHash } from "node:crypto";
import type { OutputDTO } from "../api/s14-types.ts";
import type { JsonSchema, SchemaRecord } from "../connectors/universe.ts";
import { hasStaticPolicy, neverAllowedName, sortedJson, type ToolPolicy } from "./allowlist.ts";
import type { BatchItem, ItemCommit } from "./batch.ts";

export const GENERIC_VERB_PREFIX = "composio:";
/** The server the Composio CLI executor's calls are gated under (composio.ts COMPOSIO_CLI_SERVER). */
const CLI_SERVER = "composio_cli";
export const genericVerb = (slug: string) => `${GENERIC_VERB_PREFIX}${slug}`;
export const isGenericVerb = (verb: string) => verb.startsWith(GENERIC_VERB_PREFIX) && /^[A-Z][A-Z0-9_]{1,119}$/.test(verb.slice(GENERIC_VERB_PREFIX.length));
export const DRIFT_WORDS = "the tool's fields changed since you approved it: review the batch again";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const text = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n");

type Check = { value: unknown } | { reason: string };

function typesOf(schema: Obj): string[] {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  if (isObj(schema.properties) || schema.additionalProperties !== undefined) return ["object"];
  if (schema.items !== undefined) return ["array"];
  return [];
}

function fitsType(t: string, v: unknown): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isSafeInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isObj(v);
    default:
      return false;
  }
}

/** Any JSON value, normalised (strings NFC / LF), prototype keys refused. For schemas that say nothing. */
function anyJson(v: unknown, path: string, depth: number): Check {
  if (depth > 16) return { reason: `${path || "the arguments"} are nested too deep` };
  if (typeof v === "string") return { value: text(v) };
  if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return { value: v };
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      const c = anyJson(v[i], `${path}[${i}]`, depth + 1);
      if ("reason" in c) return c;
      out.push(c.value);
    }
    return { value: out };
  }
  if (isObj(v)) {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      if (UNSAFE_KEYS.has(k)) return { reason: `${join(path, k)} is not an allowed field name` };
      const c = anyJson(x, join(path, k), depth + 1);
      if ("reason" in c) return c;
      out[k] = c.value;
    }
    return { value: out };
  }
  return { reason: `${path || "the arguments"} is not plain data` };
}

const join = (path: string, k: string) => (path === "" ? k : `${path}.${k}`);

function check(schema: unknown, v: unknown, path: string, depth = 0): Check {
  if (depth > 16) return { reason: `${path} is nested too deep` };
  if (!isObj(schema) || Object.keys(schema).length === 0) return anyJson(v, path, depth);
  for (const key of ["anyOf", "oneOf"] as const) {
    const alts = schema[key];
    if (Array.isArray(alts) && alts.length > 0) {
      let first: string | null = null;
      for (const alt of alts) {
        const c = check(alt, v, path, depth + 1);
        if (!("reason" in c)) return c;
        first ??= c.reason;
      }
      return { reason: `${path || "the arguments"} does not fit any allowed form (${first})` };
    }
  }
  if (Array.isArray(schema.allOf)) {
    let cur: Check = { value: v };
    for (const part of schema.allOf) {
      cur = check(part, v, path, depth + 1);
      if ("reason" in cur) return cur;
    }
    // allOf with siblings (type, properties) falls through to the checks below.
    if (typesOf(schema).length === 0 && !Array.isArray(schema.enum) && schema.const === undefined) return cur;
  }
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((t) => fitsType(t, v))) return { reason: `${path || "the arguments"} must be ${types.join(" or ")}` };
  let value: unknown = v;
  if (typeof v === "string") value = text(v);
  else if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) {
      const c = check(schema.items, v[i], `${path}[${i}]`, depth + 1);
      if ("reason" in c) return c;
      out.push(c.value);
    }
    value = out;
  } else if (isObj(v)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    const declared = Object.keys(props).length > 0;
    const extra = schema.additionalProperties;
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      if (UNSAFE_KEYS.has(k)) return { reason: `${join(path, k)} is not an allowed field name` };
      let c: Check;
      if (Object.hasOwn(props, k)) c = check(props[k], x, join(path, k), depth + 1);
      else if (isObj(extra)) c = check(extra, x, join(path, k), depth + 1);
      else if (extra === true || (!declared && extra === undefined)) c = anyJson(x, join(path, k), depth + 1);
      else return { reason: `unknown argument ${join(path, k)}` };
      if ("reason" in c) return c;
      out[k] = c.value;
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
    for (const r of required) if (!Object.hasOwn(v, r) || v[r] === undefined) return { reason: `${join(path, r)} is required` };
    value = out;
  } else if (v === null && types.length === 0) {
    return { reason: `${path || "the arguments"} cannot be empty here` };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => sortedJson(typeof e === "string" ? text(e) : e) === sortedJson(value))) return { reason: `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` };
  if (schema.const !== undefined && sortedJson(schema.const) !== sortedJson(value)) return { reason: `${path} must be ${JSON.stringify(schema.const)}` };
  return { value };
}

/** Canonical form of a complete argument object under the tool's input schema, and its sha256. */
export function canonicalGenericArgs(schema: JsonSchema, args: unknown): { canonical: string; hash: string; value: Obj } | { reason: string } {
  if (!isObj(args)) return { reason: "arguments must be an object" };
  const c = check(schema, args, "");
  if ("reason" in c) return c;
  if (!isObj(c.value)) return { reason: "arguments must be an object" };
  const canonical = sortedJson(c.value);
  return { canonical, hash: createHash("sha256").update(canonical).digest("hex"), value: c.value };
}

/** Why this tool can never be approved generically, or null. */
export function genericRefusal(slug: string): string | null {
  if (/^COMPOSIO_/.test(slug)) return `${slug} is a Composio helper tool: never allowed`;
  if (hasStaticPolicy(slug)) return `${slug} has a reviewed policy: it is approved through that one, not field by field`;
  const n = neverAllowedName(slug);
  return n === null ? null : `${slug} is ${n}: never allowed`;
}

/** The commit an approved item carries for one call of the tool, or why it cannot be approved. */
export function genericCommit(record: SchemaRecord, args: Record<string, unknown>): { commit: ItemCommit } | { reason: string } {
  const refused = genericRefusal(record.slug);
  if (refused !== null) return { reason: refused };
  const c = canonicalGenericArgs(record.inputSchema, args);
  if ("reason" in c) return c;
  return { commit: { verb: genericVerb(record.slug), fields: [["schema", record.hash], ["args", c.canonical]] } };
}

export interface GenericItem {
  slug: string;
  schemaHash: string;
  args: Obj;
  /** The canonical JSON exactly as it sits in the batch. */
  argsJson: string;
}

/** The generic call an item approves, or null when it is not one. */
export function parseGenericCommit(item: Pick<BatchItem, "commit">): GenericItem | null {
  const c = item.commit;
  if (c === undefined || !isGenericVerb(c.verb)) return null;
  const schema = c.fields.find(([l]) => l === "schema")?.[1];
  const argsJson = c.fields.find(([l]) => l === "args")?.[1];
  if (schema === undefined || argsJson === undefined || !/^[0-9a-f]{64}$/.test(schema) || c.fields.length !== 2) return null;
  try {
    const args = JSON.parse(argsJson) as unknown;
    return isObj(args) ? { slug: c.verb.slice(GENERIC_VERB_PREFIX.length), schemaHash: schema, args, argsJson } : null;
  } catch {
    return null;
  }
}

/** The gate policy for one tool, bound to the Composio CLI server and one connection, from the schema fetched now. */
export function genericPolicy(record: SchemaRecord, connector: string): ToolPolicy {
  const slug = record.slug;
  const mine = (item: BatchItem) => {
    const g = parseGenericCommit(item);
    return g !== null && g.slug === slug ? g : null;
  };
  return {
    connector,
    flavor: "composio",
    tool: slug,
    role: "send",
    verified: false,
    server: CLI_SERVER,
    generic: true,
    canonical: (input) => {
      const c = canonicalGenericArgs(record.inputSchema, input);
      return "reason" in c ? c : { canonical: c.canonical, hash: c.hash };
    },
    expected: (item) => {
      const g = mine(item);
      return g === null || g.schemaHash !== record.hash ? null : g.args;
    },
    whyNot: (item) => {
      const g = mine(item);
      if (g === null) return `approved item ${item.key} is not an approved call of ${slug}`;
      return g.schemaHash !== record.hash ? DRIFT_WORDS : null;
    },
  };
}

// ---------- review: every field, in plain words ----------

export type Highlight = "recipient" | "amount" | "id";

export interface ReviewRow {
  path: string;
  label: string;
  value: string;
  highlight: Highlight | null;
  required: boolean;
  description: string | null;
}

export interface GenericReview {
  rows: ReviewRow[];
  warning: string | null;
}

const RECIPIENT_KEY = /(^|_)(to|cc|bcc|recipients?|emails?|email_address(es)?|phone|phone_numbers?|channels?|assignees?|users?|members?|attendees?|owners?|invitees?)(_|$)/i;
const AMOUNT_KEY = /(amount|price|total|quantity|qty|cost|fee|refund|balance|salary|rate|payment)/i;
const ID_KEY = /(^|_)(ids?|key|uuid|slug)$|^(charge|payment_intent|customer|invoice|account|parent|thread)$/i;
const ADDRESS = /[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}/i;
const PHONE = /^\+?[0-9][0-9 ().-]{6,}$/;
const ID_VALUE = /^(?:[a-z]{2,6}_[A-Za-z0-9]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SPECIAL: Record<string, string> = { id: "ID", ids: "IDs", url: "URL", urls: "URLs", api: "API", uuid: "UUID", html: "HTML", cc: "Cc", bcc: "Bcc" };

function labelOf(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split(".")) {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(seg)!;
    const words = m[1]!
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\s-]+/)
      .filter((w) => w !== "")
      .map((w) => SPECIAL[w.toLowerCase()] ?? w.toLowerCase());
    let label = words.join(" ");
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) label += ` ${Number(idx[1]) + 1}`;
    parts.push(label);
  }
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function highlightOf(key: string, value: unknown): Highlight | null {
  if (RECIPIENT_KEY.test(key) || (typeof value === "string" && (ADDRESS.test(value) || PHONE.test(value.trim())))) return "recipient";
  if (AMOUNT_KEY.test(key)) return "amount";
  if (ID_KEY.test(key) || (typeof value === "string" && ID_VALUE.test(value))) return "id";
  return null;
}

/** The schema for a property path, with whether it is required in its parent. */
function schemaAt(root: JsonSchema | null, path: Array<string | number>): { schema: Obj | null; required: boolean } {
  let cur: unknown = root;
  let required = false;
  for (const seg of path) {
    if (!isObj(cur)) return { schema: null, required };
    if (typeof seg === "number") {
      cur = cur.items;
      continue;
    }
    const props = isObj(cur.properties) ? cur.properties : {};
    required = Array.isArray(cur.required) && cur.required.includes(seg);
    cur = Object.hasOwn(props, seg) ? props[seg] : isObj(cur.additionalProperties) ? cur.additionalProperties : null;
  }
  return { schema: isObj(cur) ? cur : null, required };
}

const display = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  return String(v);
};

/** One row per leaf of the arguments (sorted like the canonical form), empty lists and objects included. */
export function genericReview(args: Obj, record: SchemaRecord | null, meta: { destructive?: boolean; name?: string } = {}): GenericReview {
  const rows: ReviewRow[] = [];
  const walk = (v: unknown, path: Array<string | number>, key: string) => {
    const p = path.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join("");
    const leaf = (value: string, raw: unknown) => {
      const at = schemaAt(record?.inputSchema ?? null, path);
      const d = typeof at.schema?.description === "string" ? (at.schema.description.split(/(?<=\.)\s/)[0] ?? "").slice(0, 160) : null;
      rows.push({ path: p, label: labelOf(p), value, highlight: highlightOf(key, raw), required: at.required, description: d === "" ? null : d });
    };
    if (Array.isArray(v)) {
      if (v.length === 0) return leaf("(empty list)", v);
      v.forEach((x, i) => walk(x, [...path, i], key));
    } else if (isObj(v)) {
      const keys = Object.keys(v).sort();
      if (keys.length === 0) return leaf("(empty)", v);
      for (const k of keys) walk(v[k], [...path, k], k);
    } else leaf(display(v), v);
  };
  for (const k of Object.keys(args).sort()) walk(args[k], [k], k);
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { rows, warning: meta.destructive === true ? `${meta.name ?? "This tool"} deletes, refunds or overwrites something, and that cannot be undone. Check every field.` : null };
}

/** The review of an approved item, from the canonical bytes in the batch; `stale` when the schema changed. */
export function genericReviewOfItem(item: Pick<BatchItem, "commit">, record: SchemaRecord | null, meta: { destructive?: boolean; name?: string } = {}): (GenericReview & { slug: string; schemaHash: string; stale: boolean }) | null {
  const g = parseGenericCommit(item);
  if (g === null) return null;
  const r = genericReview(JSON.parse(g.argsJson) as Obj, record, meta);
  const stale = record !== null && record.hash !== g.schemaHash;
  return { ...r, slug: g.slug, schemaHash: g.schemaHash, stale, warning: stale ? "The tool's fields changed since you approved this. Offload will not send it; review it again." : r.warning };
}

// ---------- dry-run preview ----------

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const BODY_PROPS = ["body", "description", "text", "content", "message", "comment", "note", "html_body"];

function coerce(schema: Obj, raw: string): unknown {
  const types = typesOf(schema);
  if (types.includes("string") || types.length === 0) return raw;
  if (types.includes("integer")) return /^-?[0-9]{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  if (types.includes("number")) return /^-?[0-9]{1,15}(\.[0-9]{1,6})?$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
  if (types.includes("boolean")) return /^(yes|true)$/i.test(raw.trim()) ? true : /^(no|false)$/i.test(raw.trim()) ? false : undefined;
  return undefined;
}

/** What the dry run shows for a generic tool: the output's fields matched to the schema's properties by name (values
 * copied, never guessed: a value of the wrong shape is left for the person), the text into the body-like property,
 * and the required properties that could not be filled. */
export function genericPreview(record: SchemaRecord, ours: Pick<OutputDTO, "fields" | "text">): { args: Obj; fields: Array<[string, string]>; missing: string[] } {
  const props = isObj(record.inputSchema.properties) ? (record.inputSchema.properties as Record<string, Obj>) : {};
  const args: Obj = {};
  for (const f of ours.fields) {
    if (f.value === null) continue;
    const want = squash(f.label);
    const name = Object.keys(props).find((k) => squash(k) === want || (typeof props[k]!.title === "string" && squash(props[k]!.title as string) === want));
    if (name === undefined || Object.hasOwn(args, name)) continue;
    const v = coerce(props[name]!, f.value);
    if (v !== undefined) args[name] = typeof v === "string" ? text(v) : v;
  }
  if (ours.text !== null && ours.text !== "") {
    const name = BODY_PROPS.find((k) => Object.hasOwn(props, k) && !Object.hasOwn(args, k) && typesOf(props[k]!).includes("string"));
    if (name !== undefined) args[name] = text(ours.text);
  }
  const required = Array.isArray(record.inputSchema.required) ? (record.inputSchema.required as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const fields = Object.keys(args)
    .sort()
    .map((k): [string, string] => [k, display(args[k])]);
  return { args, fields, missing: required.filter((r) => !Object.hasOwn(args, r)) };
}
