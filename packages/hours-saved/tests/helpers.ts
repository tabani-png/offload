// Test builders, a seeded PRNG and a small JSON-schema checker for schemas/stage2 (tests only; no dependencies).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineSample, ReviewEvent, RunInput, RunOutcome, RunOutcomeKind, UserEstimate } from "../src/index.ts";

export const ulid = (n: number): string => "01JC" + String(n).padStart(22, "0");
export const uuid = (kind: number, n: number): string =>
  `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const ref = (n: number): string => n.toString(16).padStart(32, "0");

export const WF = (n: number): string => uuid(0xa, n);
export const PERSON = (n: number): string => uuid(0xb, n);
export const DEPT = (n: number): string => uuid(0xc, n);
export const ROLE = (n: number): string => uuid(0xd, n);

let sampleSeq = 1;
export function sample(workflowId: string, version: number, seconds: readonly number[], opts: { id?: string; refStart?: number; refs?: readonly number[] } = {}): BaselineSample {
  const start = opts.refStart ?? 1;
  return {
    id: opts.id ?? ulid(900000 + sampleSeq++),
    kind: "baseline_sample",
    createdAt: 1_790_000_000_000,
    workflowId,
    version,
    windowStart: "2026-09-01",
    windowEnd: "2026-09-30",
    instances: seconds.map((s, i) => ({ instanceRef: ref(opts.refs?.[i] ?? start + i), activeSeconds: s, day: "2026-09-15" })),
  };
}

export interface RunOpts {
  readonly n: number;
  readonly workflowId: string;
  readonly version?: number;
  readonly sent?: number;
  readonly outcome?: RunOutcomeKind;
  readonly endedAt?: number;
  readonly runtime?: "mac" | "cloud";
  readonly overnight?: boolean;
  readonly policy?: boolean;
}

export function run(o: RunOpts): RunOutcome {
  const endedAt = o.endedAt ?? Date.UTC(2026, 9, 14, 15, 0, 0);
  const sent = o.sent ?? 1;
  return {
    id: ulid(100000 + o.n),
    kind: "run_outcome",
    createdAt: endedAt,
    runId: ulid(200000 + o.n),
    workflowId: o.workflowId,
    version: o.version ?? 1,
    runtime: o.runtime ?? "mac",
    startedAt: endedAt - 60_000,
    endedAt,
    outcome: o.outcome ?? "success",
    items: { total: sent, sent, failedBeforeSend: 0, unknown: 0, pending: 0 },
    batchHash: null,
    approverKind: o.policy ? "policy" : "person",
    overnightPolicyId: o.policy ? uuid(0xe, 1) : null,
    costCents: 0,
    errorCode: null,
    overnight: o.overnight ?? false,
  };
}

export function attributed(r: RunOutcome, person: string, dept: string | null, role: string | null, deviceOutcome: RunOutcomeKind | null = null): RunInput {
  return { run: r, personId: person, departmentId: dept, jobRoleId: role, deviceOutcome };
}

let reviewSeq = 1;
export function review(
  r: RunOutcome,
  seconds: { review?: number; edit?: number; fix?: number },
  opts: { id?: string; surface?: ReviewEvent["surface"]; decision?: ReviewEvent["decision"] } = {},
): ReviewEvent {
  return {
    id: opts.id ?? ulid(300000 + reviewSeq++),
    kind: "review_event",
    createdAt: r.endedAt + 1000,
    runId: r.runId,
    reviewSeconds: seconds.review ?? 0,
    editSeconds: seconds.edit ?? 0,
    fixSeconds: seconds.fix ?? 0,
    itemsEdited: 0,
    decision: opts.decision ?? "approved",
    surface: opts.surface ?? "mac_review",
  };
}

export function estimate(workflowId: string, version: number, seconds: number, n = 1): UserEstimate {
  return { id: uuid(0xf, n), workflowId, version, seconds, setBy: PERSON(999), setAt: 1_790_000_000_000 + n };
}

/** mulberry32: deterministic PRNG for property tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ------------------------------------------------------------------------------------- schema check (tests only)

const SCHEMA_DIR = join(import.meta.dir, "../../../schemas/stage2");
type Schema = Record<string, unknown>;
const cache = new Map<string, Schema>();
function load(file: string): Schema {
  let s = cache.get(file);
  if (s === undefined) {
    s = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Schema;
    cache.set(file, s);
  }
  return s;
}

function resolve(refStr: string, file: string): { schema: Schema; file: string } {
  const [f, frag] = refStr.split("#");
  const target = f && f.length > 0 ? f : file;
  let node: unknown = load(target);
  for (const part of (frag ?? "").split("/").filter(Boolean)) node = (node as Schema)[part];
  return { schema: node as Schema, file: target };
}

/** Returns a list of violations (empty = valid) for the subset of JSON Schema the stage2 contracts use. */
export function validate(value: unknown, schema: Schema, file: string, path = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const r = resolve(schema.$ref, file);
    return validate(value, r.schema, r.file, path);
  }
  const errs: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    const ok = (schema.oneOf as Schema[]).filter((s) => validate(value, s, file, path).length === 0).length;
    if (ok !== 1) errs.push(`${path}: matches ${ok} of oneOf`);
    return errs;
  }
  if ("const" in schema && value !== schema.const) errs.push(`${path}: not const ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) errs.push(`${path}: not in enum`);
  const t = schema.type;
  if (t === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: not an object`];
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const k of (schema.required ?? []) as string[]) if (!(k in obj)) errs.push(`${path}: missing ${k}`);
    for (const k of Object.keys(obj)) {
      if (props[k]) errs.push(...validate(obj[k], props[k], file, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: extra ${k}`);
    }
  } else if (t === "array") {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errs.push(`${path}: too many items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items as Schema, file, `${path}[${i}]`)));
  } else if (t === "integer") {
    if (!Number.isInteger(value)) errs.push(`${path}: not an integer`);
    else if (typeof schema.minimum === "number" && (value as number) < schema.minimum) errs.push(`${path}: below minimum`);
  } else if (t === "number") {
    if (typeof value !== "number") errs.push(`${path}: not a number`);
    else if (typeof schema.minimum === "number" && value < schema.minimum) errs.push(`${path}: below minimum`);
  } else if (t === "string") {
    if (typeof value !== "string") errs.push(`${path}: not a string`);
    else {
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern ${schema.pattern}`);
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errs.push(`${path}: too long`);
    }
  } else if (t === "boolean") {
    if (typeof value !== "boolean") errs.push(`${path}: not a boolean`);
  } else if (t === "null") {
    if (value !== null) errs.push(`${path}: not null`);
  }
  return errs;
}

export function validateAgainst(file: string, value: unknown): string[] {
  return validate(value, load(file), file);
}
