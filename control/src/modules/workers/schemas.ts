/**
 * Request bodies API.md writes inline for the cloud worker endpoints, plus list wrappers. Like the broker's, a
 * module-local Ajv loads the frozen `schemas/stage2` files and validates exactly like the core (2020-12, strict).
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

const schedule = {
  oneOf: [obj({ cron: { type: "string", minLength: 1, maxLength: 100 }, timezone: { type: "string", minLength: 1, maxLength: 64 } }), { type: "null" }],
};

export const WORKER_CREATE = `${P}/workers-create.json`;
export const WORKER_PATCH = `${P}/workers-patch.json`;
export const RUN_CREATE = `${P}/workers-run-create.json`;
export const WORKER_LIST = `${P}/workers-list.json`;
export const RUN_LIST = `${P}/workers-run-list.json`;
export const PROPOSE_INPUT = `${P}/workers-propose-input.json`;
export const WORKER = "offload/stage2/worker.schema.json";
export const WORKER_RUN = "offload/stage2/worker-run.schema.json";
export const DIGEST = "offload/stage2/digest.schema.json";

const LOCAL = [
  {
    $id: WORKER_CREATE,
    ...obj(
      {
        workflowId: { $ref: `${C}/uuid` },
        version: { type: "integer", minimum: 1 },
        identityId: { $ref: `${C}/uuid` },
        commitConnectionId: { $ref: `${C}/uuid` },
        schedule,
        sessionBudgetCents: { type: "integer", minimum: 1, maximum: 100000 },
      },
      ["workflowId", "version", "identityId", "sessionBudgetCents"],
    ),
  },
  { $id: WORKER_PATCH, ...obj({ schedule, sessionBudgetCents: { type: "integer", minimum: 1, maximum: 100000 } }, []) },
  {
    $id: RUN_CREATE,
    ...obj(
      {
        inputs: obj(
          {
            recipients: { type: "array", items: { type: "string", format: "email", maxLength: 254 }, maxItems: 500 },
            context: { type: "string", maxLength: 20000 },
          },
          [],
        ),
      },
      [],
    ),
  },
  { $id: WORKER_LIST, ...obj({ items: { type: "array", items: { $ref: `${S}/worker.schema.json` } }, page: { $ref: `${C}/page` } }) },
  { $id: RUN_LIST, ...obj({ items: { type: "array", items: { $ref: `${S}/worker-run.schema.json` } }, page: { $ref: `${C}/page` } }) },
  {
    // What the agent may hand to offload_propose_batch (validated before anything reaches the broker).
    $id: PROPOSE_INPUT,
    ...obj({
      items: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: obj({
          capability: { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$", maxLength: 64 },
          fields: {
            type: "array",
            minItems: 3,
            maxItems: 40,
            items: { type: "array", minItems: 2, maxItems: 2, items: { type: "string", maxLength: 20000 } },
          },
        }),
      },
    }),
  },
];

let shared: { validate(ref: string, data: unknown): string[] | null } | null = null;

export function localValidator() {
  if (shared) return shared;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  for (const f of readdirSync(STAGE2_SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(STAGE2_SCHEMA_DIR, f), "utf8")));
  }
  for (const s of LOCAL) ajv.addSchema(s);
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
