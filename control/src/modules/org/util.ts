import type { Context } from "hono";
import type { AppEnv, Principal } from "../../app.ts";
import { authzPrincipal } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { authorize, type AuthzResource } from "../../rbac/permissions.ts";
import { HttpError, invalid, notFound } from "../../schema/http.ts";

/** Resource-level check for the matched matrix row; out of scope is 404 (existence is not revealed). */
export function allow(c: Context<AppEnv>, p: Principal, resource: AuthzResource): void {
  const d = authorize(authzPrincipal(p), c.get("perm")!, resource, c.get("features"));
  if (!d.allow) throw new HttpError(d.status, d.code, d.code === "not_found" ? "not found" : "not allowed");
}

export function idParam(c: Context<AppEnv>): string {
  const id = c.req.param("id");
  if (!id || !isUuid(id)) throw notFound();
  return id;
}

export async function ensureDepartments(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of new Set(ids)) {
    const [d] = await tx`select 1 from departments where id = ${id}`;
    if (!d) throw invalid(`unknown department ${id}`);
  }
}

export function afterCursor(cursor: Record<string, unknown> | null): string | null {
  return typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
}
