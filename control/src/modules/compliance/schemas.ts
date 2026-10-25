/**
 * Request/response shapes of the compliance endpoints that API.md writes inline. The core validator is built by S2-01
 * and cannot be extended from a module, so this module keeps its own Ajv over the same frozen stage2 schemas.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, Deps } from "../../app.ts";
import { STAGE2_SCHEMA_DIR, type Validator } from "../../schema/registry.ts";
import { readBody, send } from "../../schema/http.ts";

// Relative to `offload/compliance/<name>.json`, so they resolve to `offload/stage2/...`.
const S = "../stage2";
const C = `${S}/common.schema.json#/$defs`;
const FE = `${S}/feature-enablement.schema.json#/properties`;
export const P = "offload/compliance";

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const list = (id: string, items: unknown) => ({
  $id: `${P}/${id}.json`,
  ...obj({ items: { type: "array", items }, page: { $ref: `${C}/page` } }),
});

const SCHEMAS: Array<{ $id: string } & Record<string, unknown>> = [
  {
    // feature-enablement without the server's fields (API.md: without enabledBy/At/effectiveAt/disabledAt).
    $id: `${P}/enable-request.json`,
    ...obj({
      feature: { $ref: `${FE}/feature` },
      jurisdictions: { $ref: `${FE}/jurisdictions` },
      legalBasis: { $ref: `${FE}/legalBasis` },
      dpiaAttestation: { $ref: `${FE}/dpiaAttestation` },
      noticeVersionId: { $ref: `${FE}/noticeVersionId` },
      noticePeriodDays: { $ref: `${FE}/noticePeriodDays` },
      worksAgreementRef: { $ref: `${FE}/worksAgreementRef` },
      quebecActivationAck: { $ref: `${FE}/quebecActivationAck` },
      purposeLock: { $ref: `${FE}/purposeLock` },
    }),
  },
  list("feature-enablement-list", { $ref: `${S}/feature-enablement.schema.json` }),
  {
    $id: `${P}/notice-create.json`,
    ...obj({
      template: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z0-9-]+$" },
      title: { $ref: `${C}/name` },
      markdown: { type: "string", minLength: 1, maxLength: 65536 },
      features: { type: "array", items: { $ref: `${C}/feature` }, maxItems: 3, uniqueItems: true },
      jurisdictions: { type: "array", items: { $ref: `${C}/jurisdiction` }, maxItems: 100, uniqueItems: true },
    }),
  },
  list("notice-list", { $ref: `${S}/notice.schema.json` }),
  list("notice-ack-list", obj({ personId: { $ref: `${C}/uuid` }, acknowledgedAt: { $ref: `${C}/tsMs` } })),
  list(
    "template-list",
    obj({
      id: { type: "string", maxLength: 80 },
      title: { $ref: `${C}/name` },
      jurisdictions: { type: "array", items: { $ref: `${C}/jurisdiction` }, minItems: 1 },
    }),
  ),
  {
    $id: `${P}/correction-request.json`,
    ...obj({
      field: { type: "string", minLength: 1, maxLength: 80 },
      message: { type: "string", minLength: 1, maxLength: 2000 },
    }),
  },
  { $id: `${P}/correction-response.json`, ...obj({ id: { $ref: `${C}/uuid` } }) },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function build(): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addFormat("email", EMAIL);
  const ids: string[] = [];
  for (const f of readdirSync(STAGE2_SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort()) {
    const s = JSON.parse(readFileSync(join(STAGE2_SCHEMA_DIR, f), "utf8")) as { $id: string };
    ajv.addSchema(s);
    ids.push(s.$id);
  }
  for (const s of SCHEMAS) {
    ajv.addSchema(s);
    ids.push(s.$id);
  }
  return {
    ids,
    validate(ref, data) {
      const fn = ajv.getSchema(ref);
      if (!fn) throw new Error(`unknown schema ${ref}`);
      return fn(data)
        ? { ok: true }
        : {
            ok: false,
            errors: (fn.errors ?? []).slice(0, 10).map((e) => {
              const extra = e.keyword === "additionalProperties" ? ` (${String(e.params.additionalProperty)})` : "";
              return `${e.instancePath || "/"} ${e.message ?? e.keyword}${extra}`;
            }),
          };
    },
  };
}

export const local = build();

export function bodyOf<T>(c: Context<AppEnv>, ref: string): Promise<T> {
  return readBody<T>(c, local, ref);
}

export function replyLocal(c: Context<AppEnv>, deps: Deps, status: ContentfulStatusCode, data: unknown, ref: string) {
  return send(c, local, deps.config.validateResponses, status, data, ref);
}
