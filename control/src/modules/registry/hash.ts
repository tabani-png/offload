import { jcs, sha256Hex } from "../../schema/encoding.ts";

/** Object metadata that is not part of the definition, and so not part of its hash (SPEC S2-06). */
export const HASH_EXCLUDED = ["id", "kind", "createdAt", "workflowId", "version", "definitionHash"] as const;

/** definitionHash = sha256(JCS(definition minus id, kind, createdAt, workflowId, version, definitionHash)). */
export function definitionHash(obj: object): string {
  const rest: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of HASH_EXCLUDED) delete rest[k];
  return sha256Hex(jcs(rest));
}
