// Runtime check of sync objects against the frozen contracts in schemas/stage2 (ADR 0103: "each object is checked
// against its schema"). A small JSON Schema 2020-12 subset validator, enough for these files: type, enum, const,
// properties, required, additionalProperties: false, items, min/maxItems, min/maxLength, pattern, minimum, maximum,
// oneOf and $ref (same file or sibling file). The brain has no Ajv; adding one needs sign-off, and the subset is small.
// Anything else in a schema is an error here, so a later schema change cannot be silently ignored.
import common from "../../../schemas/stage2/common.schema.json";
import noticeAck from "../../../schemas/stage2/notice-ack.schema.json";
import runOutcome from "../../../schemas/stage2/run-outcome.schema.json";
import reviewEvent from "../../../schemas/stage2/review-event.schema.json";
import baselineSample from "../../../schemas/stage2/baseline-sample.schema.json";
import dailyAggregate from "../../../schemas/stage2/daily-aggregate.schema.json";
import workingTime from "../../../schemas/stage2/working-time-aggregate.schema.json";
import workflowDefinition from "../../../schemas/stage2/workflow-definition.schema.json";
import syncEnvelope from "../../../schemas/stage2/sync-envelope.schema.json";
import syncReceipt from "../../../schemas/stage2/sync-receipt.schema.json";
import deviceConfig from "../../../schemas/stage2/device-config.schema.json";
import deviceEnrollment from "../../../schemas/stage2/device-enrollment.schema.json";
import errorSchema from "../../../schemas/stage2/error.schema.json";
import type { SyncKind } from "./types.ts";

type Schema = Record<string, unknown>;

const FILES: Record<string, Schema> = Object.fromEntries(
  [common, noticeAck, runOutcome, reviewEvent, baselineSample, dailyAggregate, workingTime, workflowDefinition, syncEnvelope, syncReceipt, deviceConfig, deviceEnrollment, errorSchema].map((s) => [
    String((s as Schema).$id).replace(/^offload\/stage2\//, ""),
    s as Schema,
  ]),
);

export const SCHEMA_OF_KIND: Record<SyncKind, string> = {
  notice_ack: "notice-ack.schema.json",
  run_outcome: "run-outcome.schema.json",
  review_event: "review-event.schema.json",
  baseline_sample: "baseline-sample.schema.json",
  daily_aggregate: "daily-aggregate.schema.json",
  working_time_aggregate: "working-time-aggregate.schema.json",
  workflow_proposal: "workflow-definition.schema.json",
};

const KNOWN = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "oneOf"]);

export class SchemaError extends Error {}

function resolve(ref: string, file: string): { schema: Schema; file: string } {
  const [path, frag] = ref.split("#") as [string, string | undefined];
  const f = path === "" ? file : path;
  let node: unknown = FILES[f];
  if (node === undefined) throw new SchemaError(`unknown schema file ${f}`);
  for (const part of (frag ?? "").split("/").filter((p) => p !== "")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "object" || node === null) throw new SchemaError(`unresolvable $ref ${ref}`);
  return { schema: node as Schema, file: f };
}

const typeOk = (t: string, v: unknown): boolean => {
  switch (t) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      throw new SchemaError(`unsupported type ${t}`);
  }
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function check(s: Schema, v: unknown, file: string, at: string, errs: string[]): void {
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new SchemaError(`schema keyword ${k} is not supported (${file})`);
  if (typeof s.$ref === "string") {
    const r = resolve(s.$ref, file);
    check(r.schema, v, r.file, at, errs);
  }
  if (typeof s.type === "string" && !typeOk(s.type, v)) return void errs.push(`${at}: must be ${s.type}`);
  if ("const" in s && !same(s.const, v)) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, v))) errs.push(`${at}: must be one of ${s.enum.join(", ")}`);
  if (Array.isArray(s.oneOf)) {
    const ok = s.oneOf.filter((sub) => {
      const e: string[] = [];
      check(sub as Schema, v, file, at, e);
      return e.length === 0;
    }).length;
    if (ok !== 1) errs.push(`${at}: must match exactly one alternative (matched ${ok})`);
  }
  if (typeof v === "string") {
    if (typeof s.minLength === "number" && [...v].length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && [...v].length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) errs.push(`${at}: does not match ${s.pattern}`);
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) errs.push(`${at}: below ${s.minimum}`);
    if (typeof s.maximum === "number" && v > s.maximum) errs.push(`${at}: above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (typeof s.items === "object" && s.items !== null) v.forEach((item, i) => check(s.items as Schema, item, file, `${at}[${i}]`, errs));
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) if (!(r in rec)) errs.push(`${at}.${r}: required`);
    for (const [k, val] of Object.entries(rec)) {
      if (props[k] !== undefined) check(props[k], val, file, `${at}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
    }
  }
}

/** Problems of `value` against `ref` ("run-outcome.schema.json" or "device-enrollment.schema.json#/$defs/request"). */
export function validate(ref: string, value: unknown): string[] {
  const r = resolve(ref, ref.split("#")[0]!);
  const errs: string[] = [];
  check(r.schema, value, r.file, "$", errs);
  return errs;
}

export function assertValid(ref: string, value: unknown): void {
  const errs = validate(ref, value);
  if (errs.length > 0) throw new SchemaError(`${ref}: ${errs.slice(0, 5).join("; ")}`);
}
