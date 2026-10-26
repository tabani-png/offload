/**
 * Request/response shapes API.md writes inline for the continuity endpoints (`{successor, inFlight, inboxStep}`, the
 * accept body, the hand-over list). The core's inline schemas are frozen, so these live in a module-local Ajv that
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

export const HANDOVER = "offload/stage2/handover.schema.json";
export const PERSON = "offload/stage2/person.schema.json";
export const OFFBOARD = "offload/stage2/offboarding-request.schema.json";
export const HANDOVER_LIST = `${P}/continuity-handover-list.json`;
export const ASSIGN = `${P}/continuity-assign.json`;
export const ACCEPT = `${P}/continuity-accept.json`;
export const EMPTY = `${P}/continuity-empty.json`;

const LOCAL = [
  {
    $id: HANDOVER_LIST,
    ...obj({ items: { type: "array", items: { $ref: `${S}/handover.schema.json` } }, page: { $ref: `${C}/page` } }),
  },
  {
    $id: ASSIGN,
    ...obj(
      {
        successor: {
          oneOf: [
            obj({ type: { const: "person" }, personId: { $ref: `${C}/uuid` } }),
            obj({ type: { const: "role_identity" }, roleIdentityId: { $ref: `${C}/uuid` } }),
          ],
        },
        inFlight: { enum: ["pause", "handover_message", "stop"] },
        inboxStep: {
          oneOf: [{ enum: ["google_migrate", "google_alias", "google_archive", "m365_shared_mailbox", "none"] }, { type: "null" }],
        },
      },
      ["successor"],
    ),
  },
  // ADR 0113 §3: the successor confirms they reviewed the one-time hand-over message (inFlight handover_message).
  { $id: ACCEPT, ...obj({ reviewedHandoverMessage: { type: "boolean" } }, []) },
  { $id: EMPTY, ...obj({}) },
];

let shared: { validate(ref: string, data: unknown): string[] | null } | null = null;

/** One validator per process (schemas are frozen files; compiling them once is enough). */
export function localValidator() {
  if (shared) return shared;
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  for (const f of readdirSync(STAGE2_SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
    ajv.addSchema(JSON.parse(readFileSync(join(STAGE2_SCHEMA_DIR, f), "utf8")) as Record<string, unknown>);
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
