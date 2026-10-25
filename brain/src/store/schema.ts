// Validates decrypted lines against schemas/event.schema.json. The validator is driven by the schema file itself
// (required, additionalProperties:false, per-property type/enum), so a schema change cannot drift from this code.
import schema from "../../../schemas/event.schema.json" with { type: "json" };
import type { OffloadEvent } from "../types.ts";

interface PropertySchema {
  type?: string;
  enum?: readonly string[];
}

const required: readonly string[] = schema.required;
const properties: Readonly<Record<string, PropertySchema>> = schema.properties;

export type ValidationResult = { ok: true; event: OffloadEvent } | { ok: false; error: string };

function checkProperty(name: string, spec: PropertySchema, value: unknown): string | null {
  if (spec.enum !== undefined) {
    return typeof value === "string" && spec.enum.includes(value) ? null : `${name} must be one of ${spec.enum.join(", ")}`;
  }
  switch (spec.type) {
    case "string":
      return typeof value === "string" ? null : `${name} must be a string`;
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) ? null : `${name} must be an integer`;
    case undefined:
      return null;
    default:
      return `${name}: unsupported schema type ${spec.type}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateEvent(value: unknown): ValidationResult {
  if (!isRecord(value)) return { ok: false, error: "event must be a JSON object" };
  for (const name of required) {
    if (!(name in value)) return { ok: false, error: `missing required property ${name}` };
  }
  for (const [name, v] of Object.entries(value)) {
    const spec = properties[name];
    if (spec === undefined) return { ok: false, error: `unknown property ${name}` };
    const problem = checkProperty(name, spec, v);
    if (problem !== null) return { ok: false, error: problem };
  }
  // Every property was checked against the schema above, so the record has the OffloadEvent shape.
  return { ok: true, event: value as unknown as OffloadEvent };
}
