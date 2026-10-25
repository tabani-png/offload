// s17: the Composio universe. A local, read-only, versioned index of every Composio toolkit and tool, so any app
// Composio supports can be found, recommended and connected, also offline. The sync runs only listing commands
// (`composio dev toolkits list`, `composio tools list <toolkit>`) through the read-only guard; input schemas are
// fetched on demand (`composio execute <SLUG> --get-schema`, nothing executed) and cached one file per tool with the
// sha256 of the canonical schema, which generic approvals bind (workflows/generic.ts). Nothing here can touch an
// account: there is no execute, run, proxy, link or --dry-run path in this module.
//   $OFFLOAD_HOME/composio-universe/index.json      { version: 1, syncedAt, cliVersion, complete, toolkits, tools }
//   $OFFLOAD_HOME/composio-universe/schemas/<SLUG>.json
// A failed sync never replaces a good index; a toolkit whose listing fails keeps its previous tools.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { neverAllowedName, sortedJson } from "../workflows/allowlist.ts";
import { ensureDir, writePrivate } from "../workflows/store.ts";
import { COMPOSIO_META_RE, parseJsonOut, readOnlyRunner } from "./composio.ts";
import type { Env } from "./config.ts";
import { linkEnv, type LinkRunner, type LinkRunResult } from "./link.ts";

export const UNIVERSE_VERSION = 1;
export const UNIVERSE_TTL_MS = 24 * 60 * 60_000;
/** The CLI answers at most 1000 toolkits per listing, so the sync also lists these queries and unions them. */
export const UNIVERSE_SEEDS: readonly string[] = ["e", "o", "u", "n", "r", "l", "c", "m", "p", "d", "b", "a", "i", "s", "t", "k", "g", "h", "w", "y", "f", "v", "x", "z", "j", "q", "api", "crm", "ai", "app", "data", "cloud", "mail", "sales"];
export const UNIVERSE_LIST_TIMEOUT_MS = 60_000;
export const UNIVERSE_SCHEMA_TIMEOUT_MS = 20_000;
const DESCRIPTION_MAX = 400;
/** A Composio tool slug: upper-case letters, digits and underscores. Anything else never reaches the CLI. */
export const SLUG_RE = /^[A-Z][A-Z0-9_]{1,119}$/;
const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HINTS = new Set(["readOnlyHint", "createHint", "updateHint", "destructiveHint", "idempotentHint", "openWorldHint"]);

export type ToolClass = "read" | "draft" | "commit" | "denied";

export interface UniverseToolkit {
  slug: string;
  name: string;
  description: string;
  toolsCount: number;
  noAuth: boolean;
  /** Order in the CLI's base listing (its own popularity order); seed-only toolkits come after. */
  rank: number;
  /** False when its tools could not be listed in the last sync (its previous tools are kept). */
  listed: boolean;
  /** Composio's auth modes (OAUTH2, API_KEY, ...), filled on demand by `dev toolkits info`. */
  authModes?: string[];
}

export interface UniverseTool {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  /** Composio's hint tags only (readOnlyHint, createHint, updateHint, destructiveHint, idempotentHint, openWorldHint). */
  hints: string[];
  class: ToolClass;
  /** Why it is denied (or a draft), null otherwise. */
  reason: string | null;
  destructive: boolean;
  /** Composio's "important" tag. */
  important: boolean;
}

export interface UniverseIndex {
  version: 1;
  syncedAt: number;
  cliVersion: string | null;
  /** Every toolkit's tools were listed in the last sync. */
  complete: boolean;
  toolkits: Record<string, UniverseToolkit>;
  tools: Record<string, UniverseTool>;
}

export const universeDir = (home: string) => join(home, "composio-universe");
export const indexPath = (home: string) => join(universeDir(home), "index.json");
export const schemaPath = (home: string, slug: string) => join(universeDir(home), "schemas", `${slug}.json`);

// ---------- classification ----------

/** The class of one tool, deterministic and fail closed (SPEC s17 decision 2). */
export function classifyTool(slug: string, toolkit: string, tags: readonly string[]): { class: ToolClass; reason: string | null } {
  if (toolkit === "composio" || COMPOSIO_META_RE.test(slug)) return { class: "denied", reason: "a Composio helper tool, not an app action" };
  const named = neverAllowedName(slug);
  // Reading a list of drafts is a read; only creating one is a draft.
  const draftish = /DRAFT/.test(slug) && !/REPLY|FORWARD/.test(slug);
  if (named !== null && !(draftish && !/(^|_)(SEND|UPDATE)_/.test(slug))) return { class: "denied", reason: named };
  const has = (h: string) => tags.includes(h);
  const writes = has("createHint") || has("updateHint") || has("destructiveHint");
  if (has("readOnlyHint") && !writes) return { class: "read", reason: null };
  if (draftish) return { class: "draft", reason: "drafts are made only through the reviewed Gmail and Outlook tools" };
  return { class: "commit", reason: null };
}

// ---------- reading and writing ----------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max = DESCRIPTION_MAX) => (typeof x === "string" ? x.slice(0, max) : "");

/** The index, or null when there is none or it cannot be trusted (bad JSON, other version). */
export function readUniverse(home: string): UniverseIndex | null {
  const p = indexPath(home);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as Partial<UniverseIndex>;
    if (v.version !== UNIVERSE_VERSION || !isObj(v.toolkits) || !isObj(v.tools) || typeof v.syncedAt !== "number") return null;
    return v as UniverseIndex;
  } catch {
    return null;
  }
}

export function writeUniverse(home: string, idx: UniverseIndex): void {
  ensureDir(universeDir(home));
  writePrivate(indexPath(home), JSON.stringify(idx) + "\n");
}

export interface UniverseStatus {
  syncedAt: number | null;
  stale: boolean;
  complete: boolean;
  toolkits: number;
  tools: number;
  classes: Record<ToolClass, number>;
  cliVersion: string | null;
}

export function universeStatus(idx: UniverseIndex | null, now: number): UniverseStatus {
  const classes: Record<ToolClass, number> = { read: 0, draft: 0, commit: 0, denied: 0 };
  if (idx === null) return { syncedAt: null, stale: true, complete: false, toolkits: 0, tools: 0, classes, cliVersion: null };
  for (const t of Object.values(idx.tools)) classes[t.class] += 1;
  return { syncedAt: idx.syncedAt, stale: now - idx.syncedAt >= UNIVERSE_TTL_MS, complete: idx.complete, toolkits: Object.keys(idx.toolkits).length, tools: Object.keys(idx.tools).length, classes, cliVersion: idx.cliVersion };
}

// ---------- sync ----------

export class UniverseSyncError extends Error {}

export interface SyncOptions {
  home: string;
  runner: LinkRunner;
  env: Env;
  now: () => number;
  seeds?: readonly string[];
  /** Toolkit tool listings run this many at a time (default 4). */
  concurrency?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface SyncResult {
  index: UniverseIndex;
  failedToolkits: string[];
  commands: number;
}

const failed = (r: LinkRunResult) => r.spawnError !== undefined || r.timedOut || r.code !== 0;

function parseToolkits(stdout: string): Array<Omit<UniverseToolkit, "rank" | "listed">> {
  const v = parseJsonOut(stdout);
  if (!Array.isArray(v)) return [];
  const out: Array<Omit<UniverseToolkit, "rank" | "listed">> = [];
  for (const x of v) {
    if (!isObj(x) || typeof x.slug !== "string" || !TOOLKIT_RE.test(x.slug)) continue;
    out.push({ slug: x.slug, name: str(x.name, 120) || x.slug, description: str(x.description), toolsCount: typeof x.tools_count === "number" && x.tools_count >= 0 ? x.tools_count : 0, noAuth: x.is_no_auth === true });
  }
  return out;
}

function parseTools(stdout: string, toolkit: string): UniverseTool[] | null {
  const v = parseJsonOut(stdout);
  if (!Array.isArray(v)) return null;
  const out: UniverseTool[] = [];
  for (const x of v) {
    if (!isObj(x) || typeof x.slug !== "string" || !SLUG_RE.test(x.slug)) continue;
    const tags = Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === "string") : [];
    const hints = tags.filter((t) => HINTS.has(t));
    const c = classifyTool(x.slug, toolkit, hints);
    out.push({ slug: x.slug, toolkit, name: str(x.name, 120) || x.slug, description: str(x.description), hints, class: c.class, reason: c.reason, destructive: hints.includes("destructiveHint"), important: tags.includes("important") });
  }
  return out;
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const x = items[i++]!;
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/** One full read-only sync. Throws UniverseSyncError (and keeps the old index) when no toolkit could be listed. */
export async function syncUniverse(o: SyncOptions): Promise<SyncResult> {
  const run = readOnlyRunner(o.runner);
  const opts = { timeoutMs: o.timeoutMs ?? UNIVERSE_LIST_TIMEOUT_MS, env: linkEnv(o.env) };
  const prior = readUniverse(o.home);
  let commands = 0;
  const exec = async (argv: string[]) => {
    commands += 1;
    return run.run(argv, opts);
  };
  const v = await exec(["composio", "--version"]);
  if (v.spawnError !== undefined) throw new UniverseSyncError("Composio is not installed on this Mac.");
  const cliVersion = failed(v) ? null : (/\d+\.\d+\.\d+[\w.-]*/.exec(v.stdout)?.[0] ?? null);
  // 1. toolkits: the base listing, then every seed query, unioned by slug.
  const base = await exec(["composio", "dev", "toolkits", "list", "--limit", "1000"]);
  if (failed(base)) throw new UniverseSyncError("Composio did not list its apps.");
  const toolkits: Record<string, UniverseToolkit> = {};
  let rank = 0;
  for (const t of parseToolkits(base.stdout)) if (toolkits[t.slug] === undefined) toolkits[t.slug] = { ...t, rank: rank++, listed: false };
  if (Object.keys(toolkits).length === 0) throw new UniverseSyncError("Composio listed no apps.");
  for (const q of o.seeds ?? UNIVERSE_SEEDS) {
    const r = await exec(["composio", "dev", "toolkits", "list", "--limit", "1000", "--query", q]);
    if (failed(r)) continue;
    for (const t of parseToolkits(r.stdout)) if (toolkits[t.slug] === undefined) toolkits[t.slug] = { ...t, rank: rank++, listed: false };
  }
  // 2. tools per toolkit.
  const tools: Record<string, UniverseTool> = {};
  const failedToolkits: string[] = [];
  await pool(Object.values(toolkits), o.concurrency ?? 4, async (tk) => {
    if (tk.toolsCount === 0) {
      tk.listed = true;
      return;
    }
    const r = await exec(["composio", "tools", "list", tk.slug, "--limit", "1000"]);
    const list = failed(r) ? null : parseTools(r.stdout, tk.slug);
    if (list === null) {
      failedToolkits.push(tk.slug);
      // Keep what the last good sync knew about this toolkit.
      for (const t of Object.values(prior?.tools ?? {})) if (t.toolkit === tk.slug) tools[t.slug] = t;
      const was = prior?.toolkits[tk.slug];
      if (was?.authModes !== undefined) tk.authModes = was.authModes;
      return;
    }
    tk.listed = true;
    const was = prior?.toolkits[tk.slug];
    if (was?.authModes !== undefined) tk.authModes = was.authModes;
    for (const t of list) tools[t.slug] = t;
  });
  failedToolkits.sort();
  const index: UniverseIndex = { version: 1, syncedAt: o.now(), cliVersion, complete: failedToolkits.length === 0, toolkits, tools };
  writeUniverse(o.home, index);
  o.log?.(`brain: Composio app list synced: ${Object.keys(toolkits).length} apps, ${Object.keys(tools).length} tools${failedToolkits.length > 0 ? `, ${failedToolkits.length} apps kept from the last sync` : ""}`);
  return { index, failedToolkits, commands };
}

/** Composio's auth modes for a toolkit (`dev toolkits info`, read-only), cached in the index; null when unknown. */
export async function toolkitAuthModes(o: { home: string; runner: LinkRunner; env: Env; toolkit: string; timeoutMs?: number }): Promise<string[] | null> {
  const idx = readUniverse(o.home);
  const tk = idx?.toolkits[o.toolkit];
  if (tk === undefined || idx === null) return null;
  if (tk.authModes !== undefined) return tk.authModes;
  if (!TOOLKIT_RE.test(o.toolkit)) return null;
  const r = await readOnlyRunner(o.runner).run(["composio", "dev", "toolkits", "info", o.toolkit], { timeoutMs: o.timeoutMs ?? UNIVERSE_SCHEMA_TIMEOUT_MS, env: linkEnv(o.env) });
  if (failed(r)) return null;
  const v = parseJsonOut(r.stdout);
  if (!isObj(v)) return null;
  const modes = (Array.isArray(v.auth_modes) ? v.auth_modes : Array.isArray(v.auth_schemes) ? v.auth_schemes : []).filter((m): m is string => typeof m === "string").slice(0, 20);
  const fresh = readUniverse(o.home);
  if (fresh?.toolkits[o.toolkit] !== undefined) {
    fresh.toolkits[o.toolkit]!.authModes = modes;
    writeUniverse(o.home, fresh);
  }
  return modes;
}

// ---------- schemas ----------

export type JsonSchema = Record<string, unknown>;

export interface SchemaRecord {
  version: 1;
  slug: string;
  /** Composio's tool version string, when the CLI gave one. */
  toolVersion: string | null;
  inputSchema: JsonSchema;
  /** sha256 of the canonical (key-sorted) input schema. */
  hash: string;
  fetchedAt: number;
}

export const schemaHash = (inputSchema: unknown): string => createHash("sha256").update(sortedJson(inputSchema)).digest("hex");

export function schemaRecord(slug: string, inputSchema: JsonSchema, fetchedAt: number, toolVersion: string | null = null): SchemaRecord {
  return { version: 1, slug, toolVersion, inputSchema, hash: schemaHash(inputSchema), fetchedAt };
}

/** `composio execute <SLUG> --get-schema` output -> a record; null when it is not a schema. */
export function parseSchemaOutput(stdout: string, now: number): SchemaRecord | null {
  const v = parseJsonOut(stdout);
  if (!isObj(v) || typeof v.slug !== "string" || !SLUG_RE.test(v.slug) || !isObj(v.inputSchema)) return null;
  return schemaRecord(v.slug, v.inputSchema, now, typeof v.version === "string" ? v.version : null);
}

export function readSchema(home: string, slug: string): SchemaRecord | null {
  if (!SLUG_RE.test(slug)) return null;
  const p = schemaPath(home, slug);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as Partial<SchemaRecord>;
    if (v.version !== 1 || v.slug !== slug || !isObj(v.inputSchema) || typeof v.hash !== "string" || typeof v.fetchedAt !== "number") return null;
    // A record whose hash does not match its schema was edited: never trusted.
    return schemaHash(v.inputSchema) === v.hash ? (v as SchemaRecord) : null;
  } catch {
    return null;
  }
}

export interface FetchSchemaOptions {
  home: string;
  runner: LinkRunner;
  env: Env;
  now: () => number;
  slug: string;
  /** Use the cached record when it is younger than this (default 24 h). 0 = always fetch fresh (run time). */
  maxAgeMs?: number;
  timeoutMs?: number;
}

/** The tool's input schema: cached when fresh enough, else fetched read-only and cached. null when it cannot be had
 * (a fresh fetch that fails never falls back to an old copy). */
export async function fetchSchema(o: FetchSchemaOptions): Promise<SchemaRecord | null> {
  if (!SLUG_RE.test(o.slug)) return null;
  const maxAge = o.maxAgeMs ?? UNIVERSE_TTL_MS;
  const cached = readSchema(o.home, o.slug);
  if (cached !== null && maxAge > 0 && o.now() - cached.fetchedAt < maxAge) return cached;
  const r = await readOnlyRunner(o.runner).run(["composio", "execute", o.slug, "--get-schema"], { timeoutMs: o.timeoutMs ?? UNIVERSE_SCHEMA_TIMEOUT_MS, env: linkEnv(o.env) });
  if (failed(r)) return null;
  const rec = parseSchemaOutput(r.stdout, o.now());
  if (rec === null || rec.slug !== o.slug) return null;
  ensureDir(join(universeDir(o.home), "schemas"));
  writePrivate(schemaPath(o.home, o.slug), JSON.stringify(rec) + "\n");
  return rec;
}

// ---------- search ----------

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length >= 2);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How well a name / slug / description matches a query (0 = not at all). */
export function matchScore(t: Pick<UniverseToolkit, "name" | "slug" | "description">, q: string): number {
  return toolkitScore(t, q, words(q));
}

function toolkitScore(t: Pick<UniverseToolkit, "name" | "slug" | "description">, q: string, qs: string[]): number {
  const name = squash(t.name);
  const slug = squash(t.slug);
  const sq = squash(q);
  let score = 0;
  if (sq !== "" && (slug === sq || name === sq)) score += 100;
  else if (sq.length >= 2 && (slug.startsWith(sq) || name.startsWith(sq))) score += 50;
  else if (sq.length >= 3 && (slug.includes(sq) || name.includes(sq))) score += 30;
  const desc = new Set(words(t.description));
  const nameWords = new Set(words(t.name));
  for (const w of qs) {
    if (nameWords.has(w)) score += 10;
    else if (desc.has(w) || [...desc].some((d) => d.length >= 5 && w.length >= 5 && (d.startsWith(w) || w.startsWith(d)))) score += 5;
  }
  return score;
}

/** Toolkits matching a query, best first (name and slug before description words; then Composio's own order). */
export function searchToolkits(idx: UniverseIndex, q: string, limit = 20): UniverseToolkit[] {
  const qs = words(q);
  return Object.values(idx.toolkits)
    .filter((t) => t.slug !== "composio")
    .map((t) => ({ t, s: toolkitScore(t, q, qs) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.rank - b.t.rank)
    .slice(0, limit)
    .map((x) => x.t);
}

/** A tool's relevance to some words: name words count most, then description words. */
export function toolScore(t: UniverseTool, qs: readonly string[]): number {
  const name = new Set([...words(t.name), ...words(t.slug.replace(/_/g, " "))]);
  const desc = new Set(words(t.description));
  let s = 0;
  for (const w of qs) {
    const stem = w.replace(/s$/, "");
    if (name.has(w) || name.has(stem) || name.has(`${stem}s`)) s += 3;
    else if (desc.has(w) || desc.has(stem) || desc.has(`${stem}s`)) s += 1;
  }
  return s;
}

export function searchTools(idx: UniverseIndex, q: string, o: { toolkit?: string; classes?: readonly ToolClass[]; limit?: number } = {}): UniverseTool[] {
  const qs = words(q);
  return Object.values(idx.tools)
    .filter((t) => (o.toolkit === undefined || t.toolkit === o.toolkit) && (o.classes === undefined || o.classes.includes(t.class)))
    .map((t) => ({ t, s: toolScore(t, qs) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.slug.length - b.t.slug.length || a.t.slug.localeCompare(b.t.slug))
    .slice(0, o.limit ?? 20)
    .map((x) => x.t);
}

export const toolsOf = (idx: UniverseIndex, toolkit: string): UniverseTool[] => Object.values(idx.tools).filter((t) => t.toolkit === toolkit);

/** The toolkit for an app name or host, when one matches it well (exact name / slug, or a host label). */
export function toolkitForApp(idx: UniverseIndex, nameOrHost: string): UniverseToolkit | null {
  const labels = [squash(nameOrHost), ...nameOrHost.toLowerCase().split(/[.\s/-]+/).map(squash)].filter((x) => x.length >= 4 && !["www", "app", "admin", "com", "mail", "docs", "web", "apple", "google", "microsoft"].includes(x));
  for (const l of labels) {
    const hit = Object.values(idx.toolkits).find((t) => t.slug !== "composio" && (squash(t.slug) === l || squash(t.name) === l));
    if (hit !== undefined) return hit;
  }
  return null;
}
