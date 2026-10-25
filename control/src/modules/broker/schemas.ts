/**
 * Request/response shapes API.md writes inline for the broker and policies endpoints (`{reason}`, `{keys[]}`,
 * `{scope, targetId, reason}`, lists). The core's inline schemas are frozen, so these live in a module-local Ajv that
 * loads the same frozen `schemas/stage2` files and validates exactly like the core (2020-12, strict, no extra fields).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, Deps } from "../../app.ts";
import { STAGE2_SCHEMA_DIR } from "../../schema/registry.ts";
import { invalid } from "../../schema/http.ts";

const C = "../stage2/common.schema.json#/$defs";
const S = "../stage2";
const P = "offload/control";

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const list = (id: string, itemRef: string) => ({
  $id: `${P}/${id}.json`,
  ...obj({ items: { type: "array", items: { $ref: itemRef } }, page: { $ref: `${C}/page` } }),
});

export const BATCH_LIST = `${P}/broker-batch-list.json`;
export const KILL_LIST = `${P}/broker-kill-switch-list.json`;
export const KILL_CREATE = `${P}/broker-kill-switch-create.json`;
export const REJECT = `${P}/broker-reject.json`;
export const RELEASE = `${P}/broker-release.json`;
export const OVERNIGHT_LIST = `${P}/policies-overnight-list.json`;
/** Partial overnight policy for PATCH: the frozen schema's properties, none required (resolved inside stage2). */
export const OVERNIGHT_PATCH = "offload/stage2/overnight-policy.patch.local.json";

const LOCAL = [
  list("broker-batch-list", `${S}/batch.schema.json`),
  list("broker-kill-switch-list", `${S}/kill-switch.schema.json`),
  list("policies-overnight-list", `${S}/overnight-policy.schema.json`),
  {
    $id: KILL_CREATE,
    ...obj({
      scope: { enum: ["tenant", "person", "workflow"] },
      targetId: { oneOf: [{ $ref: `${C}/uuid` }, { type: "null" }] },
      reason: { type: "string", minLength: 1, maxLength: 200 },
    }),
  },
  { $id: REJECT, ...obj({ reason: { type: "string", minLength: 1, maxLength: 200 } }) },
  {
    $id: RELEASE,
    ...obj({ keys: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 500 } }),
  },
];

let shared: { validate(ref: string, data: unknown): string[] | null } | null = null;

/** One validator per process (schemas are frozen files; compiling them once is enough). */
export function localValidator() {
  if (shared) return shared;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  let overnight: Record<string, unknown> | null = null;
  for (const f of readdirSync(STAGE2_SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
    const schema = JSON.parse(readFileSync(join(STAGE2_SCHEMA_DIR, f), "utf8")) as Record<string, unknown>;
    ajv.addSchema(schema);
    if (schema.$id === "offload/stage2/overnight-policy.schema.json") overnight = schema;
  }
  for (const s of LOCAL) ajv.addSchema(s);
  if (overnight) {
    const { $schema: _s, $id: _i, title: _t, required: _r, ...rest } = overnight;
    ajv.addSchema({ ...rest, $id: OVERNIGHT_PATCH, required: [] });
  }
  const cache = new Map<string, ValidateFunction>();
  shared = {
    validate(ref, data) {
      let fn = cache.get(ref);
      if (!fn) {
        fn = ajv.getSchema(ref);
        if (!fn) throw new Error(`unknown schema ${ref}`);
        cache.set(ref, fn);
      }
      if (fn(data)) return null;
      return (fn.errors ?? []).slice(0, 10).map((e) => {
        const extra = e.keyword === "additionalProperties" ? ` (${String(e.params.additionalProperty)})` : "";
        return `${e.instancePath || "/"} ${e.message ?? e.keyword}${extra}`;
      });
    },
  };
  return shared;
}

export async function readLocal<T>(c: Context<AppEnv>, ref: string): Promise<T> {
  let data: unknown;
  try {
    const text = await c.req.text();
    data = text === "" ? {} : JSON.parse(text);
  } catch {
    throw invalid("body is not valid JSON");
  }
  const errors = localValidator().validate(ref, data);
  if (errors) throw invalid("request body does not match its schema", errors);
  return data as T;
}

export function replyLocal(c: Context<AppEnv>, deps: Deps, status: ContentfulStatusCode, body: unknown, ref: string): Response {
  if (deps.config.validateResponses) {
    const errors = localValidator().validate(ref, body);
    if (errors) throw new Error(`response for ${c.req.method} ${c.req.path} does not match ${ref}: ${errors.join("; ")}`);
  }
  return c.json(body as object, status);
}
