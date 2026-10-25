// s16 SCHEMA: the policies match the live Composio schemas recorded read-only on 2026-10-25 (`composio execute <SLUG>
// --get-schema`, fixtures/composio-schemas.json): no invented argument names, every required argument is in the
// expected arguments, and the expected arguments validate against the schema (types, enums, required).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_POLICIES, type FieldSpec, type ToolPolicy } from "../../src/workflows/allowlist.ts";
import { batchOf, CASES } from "./cases.ts";

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
}

const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "composio-schemas.json"), "utf8")) as { source: string; tools: Record<string, { version: string; inputSchema: JsonSchema }> };
const commits = () => TOOL_POLICIES.filter((p) => p.flavor === "composio" && p.role !== "read");
const NEW = Object.keys(CASES);

/** Every argument path a field spec names (objects and list items included). */
function specPaths(fields: Readonly<Record<string, FieldSpec>>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, s] of Object.entries(fields)) {
    const p = `${prefix}${k}`;
    out.push(p);
    if (s.kind === "object") out.push(...specPaths(s.fields, `${p}.`));
    if (s.kind === "list" && s.of.kind === "object") out.push(...specPaths(s.of.fields, `${p}[].`));
  }
  return out;
}

/** Whether `path` exists in the schema. Free-form objects (additionalProperties) accept any key below them. */
function schemaHas(s: JsonSchema, path: string): boolean {
  let cur: JsonSchema | undefined = s;
  for (const part of path.split(".")) {
    if (cur === undefined) return false;
    const key = part.endsWith("[]") ? part.slice(0, -2) : part;
    const opts: JsonSchema[] = cur.anyOf ?? [cur];
    const holder = opts.find((o) => o.properties?.[key] !== undefined) ?? opts.find((o) => o.additionalProperties === true || (o.type === "object" && o.properties === undefined));
    if (holder === undefined) return false;
    if (holder.properties?.[key] === undefined) return true; // free-form below here
    let next: JsonSchema = holder.properties[key]!;
    if (part.endsWith("[]")) {
      const arr = (next.anyOf ?? [next]).find((o) => o.type === "array") ?? next;
      next = arr.items ?? {};
    }
    cur = next;
  }
  return true;
}

function validate(s: JsonSchema, v: unknown, at: string, errors: string[]): void {
  if (s.anyOf !== undefined) {
    const ok = s.anyOf.some((o) => {
      const e: string[] = [];
      validate(o, v, at, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${at}: matches no anyOf branch`);
    return;
  }
  if (s.enum !== undefined && !s.enum.includes(v)) errors.push(`${at}: ${JSON.stringify(v)} not in enum`);
  switch (s.type) {
    case "string":
      if (typeof v !== "string") errors.push(`${at}: not a string`);
      break;
    case "integer":
      if (!Number.isInteger(v)) errors.push(`${at}: not an integer`);
      break;
    case "number":
      if (typeof v !== "number") errors.push(`${at}: not a number`);
      break;
    case "boolean":
      if (typeof v !== "boolean") errors.push(`${at}: not a boolean`);
      break;
    case "array":
      if (!Array.isArray(v)) errors.push(`${at}: not an array`);
      else if (s.items !== undefined) v.forEach((x, i) => validate(s.items!, x, `${at}[${i}]`, errors));
      break;
    case "object": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        errors.push(`${at}: not an object`);
        break;
      }
      for (const r of s.required ?? []) if (!(r in v)) errors.push(`${at}.${r}: required`);
      for (const [k, x] of Object.entries(v)) if (s.properties?.[k] !== undefined) validate(s.properties[k]!, x, `${at}.${k}`, errors);
      break;
    }
  }
}

describe("s16 schemas", () => {
  test("SCHEMA: the fixture was recorded read-only with --get-schema and holds every allowlisted Composio commit", () => {
    expect(FIX.source).toContain("--get-schema");
    expect(FIX.source).toContain("2026-10-25");
    for (const p of commits()) expect(FIX.tools[p.tool]).toBeDefined();
  });

  test.each(NEW)("SCHEMA: %s: every argument the policy names exists in the live schema", (n) => {
    const p = TOOL_POLICIES.find((x) => x.tool === n && x.flavor === "composio") as ToolPolicy;
    const s = FIX.tools[n]!.inputSchema;
    for (const path of specPaths(p.fields!)) if (!schemaHas(s, path)) throw new Error(`${n}: ${path} is not in the live schema`);
  });

  test.each(NEW)("SCHEMA: %s: the expected arguments for the case item validate against the live schema", (n) => {
    const c = CASES[n]!(batchOf);
    const p = TOOL_POLICIES.find((x) => x.tool === n && x.flavor === "composio") as ToolPolicy;
    const b = batchOf(c.item);
    const args = p.expected!(c.item, { batchHash: b.hash });
    expect(args).not.toBeNull();
    const errors: string[] = [];
    validate({ ...FIX.tools[n]!.inputSchema, type: "object" }, args, n, errors);
    expect(errors).toEqual([]);
  });

  test("SCHEMA: the sheet log's expected arguments carry the valueInputOption Composio requires", () => {
    const p = TOOL_POLICIES.find((x) => x.tool === "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND")!;
    const c = CASES.OUTLOOK_SEND_EMAIL!(batchOf);
    const args = p.expected!(c.item, { batchHash: "h".repeat(64), crmSheet: { spreadsheetId: "s1", range: "CRM!A:D" } });
    const errors: string[] = [];
    validate({ ...FIX.tools.GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND!.inputSchema, type: "object" }, args, "sheet", errors);
    expect(errors).toEqual([]);
    expect(args).toMatchObject({ valueInputOption: "RAW" });
  });
});
