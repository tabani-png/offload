// Test-only: Ajv 2020-12 loaded with every schemas/stage2 file, as the control plane validates (ADR 0110).
import Ajv2020 from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResponseShape } from "../../src/api/mock/server.ts";

export const SCHEMA_DIR = join(import.meta.dir, "../../../schemas/stage2");
const PREFIX = "offload/stage2/";

export function loadAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  // person.email uses format "email"; the schemas carry no formats package, so check the shape plainly.
  ajv.addFormat("email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")));
  }
  return ajv;
}

const ajv = loadAjv();
let inlineN = 0;

/** Validate `data` against a route's declared shape; returns Ajv's error text or null. */
export function check(shape: ResponseShape, data: unknown): string | null {
  let validate;
  if (shape.kind === "schema") validate = ajv.getSchema(PREFIX + shape.ref);
  else if (shape.kind === "array") {
    const id = `${PREFIX}test-array-${shape.ref.replace(/[#/$]/g, "_")}`;
    validate = ajv.getSchema(id) ?? (ajv.addSchema({ $id: id, type: "array", items: { $ref: shape.ref } }), ajv.getSchema(id));
  } else if (shape.kind === "inline") {
    const id = `${PREFIX}test-inline-${inlineN++}.json`;
    ajv.addSchema({ ...shape.schema, $id: id });
    validate = ajv.getSchema(id);
  } else if (shape.kind === "text") return typeof data === "string" && data.length > 0 ? null : "expected text";
  else return typeof (data as { redirect?: unknown }).redirect === "string" ? null : "expected redirect";
  if (!validate) return `no schema for ${JSON.stringify(shape)}`;
  return validate(data) ? null : ajv.errorsText(validate.errors);
}
