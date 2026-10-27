// s12 Frame notes (ADR 0007): what a local vision model saw on one masked keyframe. The validator is driven by
// schemas/frame-note.schema.json (required, additionalProperties:false, type/const/maxLength/maxItems/min/max), so the
// schema and this code cannot drift. Notes come from store events of kind "frame" (s11) and, until s11 stores them,
// from a fixture sidecar `frames/<day>.jsonl` or `frames/<day>.jsonl.enc` encrypted with that day's key: once the
// observer purges the key the sidecar is unreadable, and days older than 30 local days are refused.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import schema from "../../../schemas/frame-note.schema.json" with { type: "json" };
import { decryptLine, KEY_BYTES, LineCryptoError } from "../store/crypto.ts";
import { keyPath } from "../store/reader.ts";
import { isExpired } from "../store/vault.ts";
import type { DayLabel, Span } from "../types.ts";

export interface FrameNote {
  id: string;
  ts: number;
  kind: "frame";
  frameId: string;
  phash?: string;
  app?: string;
  host?: string;
  model: string;
  activity: string;
  verb?: string;
  object?: string;
  counterpart?: string;
  surface?: string;
  step?: string;
  inputs?: string[];
  outputs?: string[];
  identifiers?: string[];
  confidence: number;
}

interface PropSchema {
  type?: string;
  const?: string;
  maxLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  items?: { type?: string; maxLength?: number };
}

const required: readonly string[] = schema.required;
const properties = schema.properties as Readonly<Record<string, PropSchema>>;

export type FrameValidation = { ok: true; note: FrameNote } | { ok: false; error: string };

function checkString(name: string, v: unknown, max: number | undefined): string | null {
  if (typeof v !== "string") return `${name} must be a string`;
  if (max !== undefined && v.length > max) return `${name} is longer than ${max}`;
  return null;
}

function checkProp(name: string, spec: PropSchema, v: unknown): string | null {
  if (spec.const !== undefined) return v === spec.const ? null : `${name} must be ${spec.const}`;
  switch (spec.type) {
    case "string":
      return checkString(name, v, spec.maxLength);
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
        const p = checkString(`${name}[]`, item, spec.items?.maxLength);
        if (p !== null) return p;
      }
      return null;
    }
    default:
      return `${name}: unsupported schema type ${String(spec.type)}`;
  }
}

export function validateFrameNote(value: unknown): FrameValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "frame note must be a JSON object" };
  const rec = value as Record<string, unknown>;
  for (const name of required) if (!(name in rec)) return { ok: false, error: `missing required property ${name}` };
  for (const [name, v] of Object.entries(rec)) {
    const spec = properties[name];
    if (spec === undefined) return { ok: false, error: `unknown property ${name}` };
    const problem = checkProp(name, spec, v);
    if (problem !== null) return { ok: false, error: problem };
  }
  return { ok: true, note: rec as unknown as FrameNote };
}

export interface FrameRead {
  frames: FrameNote[];
  /** Lines or events that failed validation or decryption; never used, always counted. */
  invalid: number;
  errors: string[];
}

/** Frame notes among store events (s11 writes them as events of kind "frame"). Other kinds are ignored. */
export function framesFromEvents(events: readonly unknown[]): FrameRead {
  const out: FrameRead = { frames: [], invalid: 0, errors: [] };
  for (const e of events) {
    if (typeof e !== "object" || e === null || (e as { kind?: unknown }).kind !== "frame") continue;
    const r = validateFrameNote(e);
    if (r.ok) out.frames.push(r.note);
    else {
      out.invalid += 1;
      if (out.errors.length < 5) out.errors.push(r.error);
    }
  }
  return out;
}

export const framesDir = (home: string) => join(home, "frames");

/** Reads the fixture sidecar for `days`. Encrypted files use the raw 32-byte day key; a missing key = unreadable. */
export function readFrameSidecars(home: string, days: readonly DayLabel[], opts: { now?: number } = {}): FrameRead {
  const out: FrameRead = { frames: [], invalid: 0, errors: [] };
  for (const day of days) {
    if (opts.now !== undefined && isExpired(day, opts.now)) {
      out.errors.push(`refused frames for ${day}: older than 30 local days`);
      continue;
    }
    const plain = join(framesDir(home), `${day}.jsonl`);
    const enc = join(framesDir(home), `${day}.jsonl.enc`);
    const lines: string[] = [];
    if (existsSync(enc)) {
      const kp = keyPath(home, day);
      const key = existsSync(kp) ? readFileSync(kp) : null;
      const encLines = readFileSync(enc, "utf8").split("\n").filter((l) => l.trim() !== "");
      if (key === null || key.length !== KEY_BYTES) {
        out.invalid += encLines.length;
        out.errors.push(`frames for ${day}: no raw day key, ${encLines.length} notes unreadable`);
      } else {
        for (const l of encLines) {
          try {
            lines.push(decryptLine(key, l));
          } catch (err) {
            if (!(err instanceof LineCryptoError)) throw err;
            out.invalid += 1;
          }
        }
      }
    }
    if (existsSync(plain)) lines.push(...readFileSync(plain, "utf8").split("\n").filter((l) => l.trim() !== ""));
    for (const l of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(l);
      } catch {
        // A line that is not JSON is a bad note: counted, not used.
        out.invalid += 1;
        continue;
      }
      const r = validateFrameNote(parsed);
      if (r.ok) out.frames.push(r.note);
      else out.invalid += 1;
    }
  }
  out.frames.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Unique by id, time order. */
export function mergeFrames(...lists: ReadonlyArray<readonly FrameNote[]>): FrameNote[] {
  const byId = new Map<string, FrameNote>();
  for (const l of lists) for (const f of l) if (!byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Frame notes per span: a note belongs to the span whose [start, end) holds its time, when the note names no app or
 * the span's app. Notes outside every span (idle, paused) are dropped.
 */
export function attachFrames(spans: readonly Span[], frames: readonly FrameNote[]): Map<string, FrameNote[]> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const out = new Map<string, FrameNote[]>();
  for (const f of frames) {
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.start <= f.ts) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Spans can touch; walk back over spans that started at the same time or still cover the note.
    for (let i = idx; i >= 0 && i >= idx - 3; i--) {
      const s = sorted[i]!;
      if (f.ts >= s.start && (f.ts < s.end || (f.ts === s.end && s.end === s.start)) && (f.app === undefined || f.app === s.app)) {
        const list = out.get(s.id) ?? [];
        list.push(f);
        out.set(s.id, list);
        break;
      }
    }
  }
  return out;
}
