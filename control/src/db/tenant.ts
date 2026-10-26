import type { Db, Tx } from "./pool.ts";
import type { AccessRole } from "../rbac/permissions.ts";

/** The request-scoped database context (ADR 0101 §4). tenantId comes only from a verified credential. */
export interface TenantCtx {
  tenantId: string;
  principalId?: string | null;
  principalPersonId?: string | null;
  accessRole?: AccessRole | "system" | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** One transaction with `SET LOCAL app.*`; everything a request does to tenant data runs inside it. */
export async function withTenant<T>(db: Db, ctx: TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(ctx.tenantId)) throw new Error("withTenant: tenantId must be a uuid");
  return (await db.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${ctx.tenantId}, true),
                    set_config('app.principal_id', ${ctx.principalId ?? ""}, true),
                    set_config('app.principal_person_id', ${ctx.principalPersonId ?? ""}, true),
                    set_config('app.access_role', ${ctx.accessRole ?? ""}, true)`;
    return fn(tx);
  })) as T;
}

/** Pre-authentication lookup: a read-only transaction with one `app.lookup_*` setting and no tenant. */
export async function withLookup<T>(
  db: Db,
  key: "lookup_workos_org" | "lookup_workos_directory" | "lookup_device_id",
  value: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return (await db.begin("read only", async (tx) => {
    await tx`select set_config(${"app." + key}, ${value}, true)`;
    return fn(tx);
  })) as T;
}
