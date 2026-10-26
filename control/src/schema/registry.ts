import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { INLINE_SCHEMAS } from "./inline.ts";

export const STAGE2_SCHEMA_DIR = join(import.meta.dir, "../../../schemas/stage2");

// RFC 5322-lite: one @, no spaces, a dot in the domain. `format: email` is the only format the contracts use.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Validator {
  /** Validates `data` against a schema ref such as `offload/stage2/person.schema.json` or `...#/$defs/request`. */
  validate(ref: string, data: unknown): { ok: true } | { ok: false; errors: string[] };
  ids: string[];
}

function fmt(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 10).map((e) => {
    const extra = e.keyword === "additionalProperties" ? ` (${String(e.params.additionalProperty)})` : "";
    return `${e.instancePath || "/"} ${e.message ?? e.keyword}${extra}`;
  });
}

/** Loads every `schemas/stage2/*.schema.json` by `$id`, plus the control plane's inline request/response schemas. */
export function createValidator(dir = STAGE2_SCHEMA_DIR): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  ajv.addFormat("email", EMAIL);
  const ids: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort()) {
    const schema = JSON.parse(readFileSync(join(dir, f), "utf8")) as { $id: string };
    ajv.addSchema(schema);
    ids.push(schema.$id);
  }
  for (const s of INLINE_SCHEMAS) {
    ajv.addSchema(s);
    ids.push(s.$id);
  }
  const cache = new Map<string, ValidateFunction>();
  return {
    ids,
    validate(ref, data) {
      let fn = cache.get(ref);
      if (!fn) {
        fn = ajv.getSchema(ref);
        if (!fn) throw new Error(`unknown schema ${ref}`);
        cache.set(ref, fn);
      }
      return fn(data) ? { ok: true } : { ok: false, errors: fmt(fn.errors) };
    },
  };
}
