// Frame note validation driven by schemas/frame-note.schema.json itself (required, const, additionalProperties:false,
// string maxLength, array maxItems + item maxLength, number minimum/maximum), so the schema cannot drift from the code.
// `coerceFields` trims model output into those limits before validation: a model that writes 230 characters gets cut
// to 200, not rejected.
import schema from "../../../schemas/frame-note.schema.json" with { type: "json" };
import type { CaptionFields, FrameNote } from "./types.ts";

interface PropSpec {
  type?: string;
  const?: unknown;
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  items?: { type?: string; maxLength?: number };
}

const props = schema.properties as Readonly<Record<string, PropSpec>>;
const required: readonly string[] = schema.required;

/** Caption field names, in the order the prompt lists them. */
export const CAPTION_FIELDS = ["activity", "verb", "object", "counterpart", "surface", "step", "inputs", "outputs", "identifiers", "confidence"] as const;
const STRING_FIELDS = ["activity", "verb", "object", "counterpart", "surface", "step"] as const;
const LIST_FIELDS = ["inputs", "outputs", "identifiers"] as const;

export const limits = (name: string): PropSpec => props[name] ?? {};

export type NoteValidation = { ok: true; note: FrameNote } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkProp(name: string, spec: PropSpec, v: unknown): string | null {
  if ("const" in spec && spec.const !== undefined) return v === spec.const ? null : `${name} must be ${JSON.stringify(spec.const)}`;
  switch (spec.type) {
    case "string":
      if (typeof v !== "string") return `${name} must be a string`;
      if (spec.maxLength !== undefined && [...v].length > spec.maxLength) return `${name} is longer than ${spec.maxLength}`;
      return null;
    case "integer":
      return typeof v === "number" && Number.isSafeInteger(v) ? null : `${name} must be an integer`;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${name} must be a number`;
      if (spec.minimum !== undefined && v < spec.minimum) return `${name} is below ${spec.minimum}`;
      if (spec.maximum !== undefined && v > spec.maximum) return `${name} is above ${spec.maximum}`;
      return null;
    case "array": {
      if (!Array.isArray(v)) return `${name} must be an array`;
      if (spec.maxItems !== undefined && v.length > spec.maxItems) return `${name} has more than ${spec.maxItems} items`;
      for (const item of v) {
        if (typeof item !== "string") return `${name} items must be strings`;
        if (spec.items?.maxLength !== undefined && [...item].length > spec.items.maxLength) return `${name} item longer than ${spec.items.maxLength}`;
      }
      return null;
    }
    default:
      return `${name}: unsupported schema type ${String(spec.type)}`;
  }
}

export function validateFrameNote(value: unknown): NoteValidation {
  if (!isRecord(value)) return { ok: false, error: "frame note must be a JSON object" };
  for (const r of required) if (!(r in value)) return { ok: false, error: `missing required property ${r}` };
  for (const [k, v] of Object.entries(value)) {
    const spec = props[k];
    if (spec === undefined) return { ok: false, error: `unknown property ${k}` };
    const problem = checkProp(k, spec, v);
    if (problem !== null) return { ok: false, error: problem };
  }
  if (typeof value.activity === "string" && value.activity.trim() === "") return { ok: false, error: "activity is empty" };
  return { ok: true, note: value as unknown as FrameNote };
}

/** Cuts a string to `max` code points, on a word boundary when one is close, and collapses whitespace. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const cps = [...flat];
  if (cps.length <= max) return flat;
  const cut = cps.slice(0, max).join("");
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

export class CaptionShapeError extends Error {}

const ID_SHAPE = /[0-9#._\-/@:]/;

/** Model output (any JSON) -> CaptionFields within the schema limits. Throws CaptionShapeError when there is no usable
 * activity sentence. Unknown keys are dropped; empty strings and empty lists are omitted. */
export function coerceFields(raw: unknown): CaptionFields {
  if (!isRecord(raw)) throw new CaptionShapeError("caption is not a JSON object");
  const activity = typeof raw.activity === "string" ? clip(raw.activity, limits("activity").maxLength ?? 200) : "";
  if (activity === "") throw new CaptionShapeError("caption has no activity sentence");
  let confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : typeof raw.confidence === "string" ? Number(raw.confidence) : NaN;
  if (!Number.isFinite(confidence)) confidence = 0.5;
  if (confidence > 1 && confidence <= 100) confidence = confidence / 100; // "85" meaning 85 %
  confidence = Math.min(1, Math.max(0, confidence));
  const out: CaptionFields = { activity, confidence: Math.round(confidence * 1000) / 1000 };
  for (const f of STRING_FIELDS) {
    if (f === "activity") continue;
    const v = raw[f];
    if (typeof v !== "string") continue;
    const c = clip(v, limits(f).maxLength ?? 80);
    if (c !== "" && !/^(n\/a|none|null|unknown|-)$/i.test(c)) out[f] = c;
  }
  for (const f of LIST_FIELDS) {
    const v = raw[f];
    if (!Array.isArray(v)) continue;
    const spec = limits(f);
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of v) {
      if (typeof item !== "string" && typeof item !== "number") continue;
      const c = clip(String(item), spec.items?.maxLength ?? 80);
      if (c === "" || seen.has(c.toLowerCase())) continue;
      // An identifier is a record id, file name or domain: it has a digit or id punctuation. Plain words (names,
      // headings) are not identifiers and are dropped here rather than stored as one.
      if (f === "identifiers" && !ID_SHAPE.test(c)) continue;
      seen.add(c.toLowerCase());
      items.push(c);
      if (items.length >= (spec.maxItems ?? 8)) break;
    }
    if (items.length > 0) out[f] = items;
  }
  return out;
}

/** JSON schema of the caption fields only, for Ollama structured output (`format`). Built from the note schema. */
export function captionJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of CAPTION_FIELDS) {
    const s = limits(f);
    if (s.type === "array") properties[f] = { type: "array", items: { type: "string" }, maxItems: s.maxItems };
    else if (s.type === "number") properties[f] = { type: "number", minimum: 0, maximum: 1 };
    else properties[f] = { type: "string" };
  }
  return { type: "object", properties, required: [...CAPTION_FIELDS] };
}
