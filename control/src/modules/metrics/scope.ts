// Query parsing and access for the metrics endpoints: ?scope=, ?from=&to= (local days, `to` exclusive), the group
// scope check for T / Dp cells, and the per-person read path (authorize + audit + app.person_read, one transaction).
import type { Context } from "hono";
import { actorOf, authzPrincipal, type AppEnv, type Deps, type Principal } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { authorize } from "../../rbac/permissions.ts";
import { HttpError, invalid, notFound } from "../../schema/http.ts";
import { localDay, periodBoundsUtc, type Period, type Scope } from "../../../../packages/hours-saved/src/index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
/** Longest period one request may cover. */
export const MAX_PERIOD_DAYS = 366;

export type ScopeType = Scope["type"];

/** `company` | `department:<id>` | `job_role:<id>` | `person:<id>`; missing = company. */
export function parseScope(raw: string | undefined, allowed: readonly ScopeType[]): Scope {
  const v = raw ?? "company";
  if (v === "company" && allowed.includes("company")) return { type: "company", id: null };
  const i = v.indexOf(":");
  const type = v.slice(0, i) as ScopeType;
  const id = v.slice(i + 1);
  if (i < 0 || !allowed.includes(type) || type === "company" || !UUID.test(id)) {
    throw invalid(`scope must be one of ${allowed.map((t) => (t === "company" ? "company" : `${t}:<uuid>`)).join(", ")}`);
  }
  return { type, id };
}

function realDay(d: string): boolean {
  if (!DAY.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

/** The first day of the month after `day`'s month. */
export function nextMonthStart(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function prevMonthStart(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/** Whole calendar month [YYYY-MM-01, next month) → "YYYY-MM", else null. */
export function monthOf(p: Period): string | null {
  return p.from.endsWith("-01") && p.toExclusive === nextMonthStart(p.from) ? p.from.slice(0, 7) : null;
}

/** ?from=&to= as local days in the tenant timezone; default the current month. */
export function parsePeriod(c: Context<AppEnv>, tz: string, now: number): Period {
  const from = c.req.query("from") ?? `${localDay(now, tz).slice(0, 7)}-01`;
  const to = c.req.query("to") ?? nextMonthStart(from);
  if (!realDay(from) || !realDay(to)) throw invalid("from and to must be days YYYY-MM-DD");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 1) throw invalid("to must be after from (to is exclusive)");
  if (days > MAX_PERIOD_DAYS) throw invalid(`a period covers at most ${MAX_PERIOD_DAYS} days`);
  return { from, toExclusive: to };
}

export function periodDays(p: Period): number {
  return (Date.parse(`${p.toExclusive}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000;
}

export function bounds(p: Period, tz: string): { startMs: number; endMsExclusive: number } {
  return periodBoundsUtc(p, tz);
}

export interface TenantMetricsSettings {
  timezone: string;
  floor: number;
}

export async function tenantSettings(tx: Tx): Promise<TenantMetricsSettings> {
  const [t] = await tx`select reporting_timezone, group_floor from tenants where id = current_setting('app.tenant_id')::uuid`;
  return { timezone: t!.reporting_timezone as string, floor: t!.group_floor as number };
}

/**
 * Group scopes for a T or Dp cell. Unknown ids and scopes outside a dept lead's departments are 404; a dept lead has no
 * company scope (Dp is never tenant-wide).
 */
export async function checkGroupScope(c: Context<AppEnv>, tx: Tx, p: Principal, scope: Scope): Promise<{ label: string | null }> {
  if (scope.type === "company") {
    if (c.get("scope") === "Dp") throw notFound();
    return { label: null };
  }
  const [row] =
    scope.type === "department"
      ? await tx`select id as department_id, name from departments where id = ${scope.id}`
      : await tx`select department_id, name from job_roles where id = ${scope.id}`;
  if (!row) throw notFound();
  const d = authorize(authzPrincipal(p), c.get("perm")!, { departmentId: row.department_id as string }, c.get("features"));
  if (!d.allow) throw notFound();
  return { label: row.name as string };
}

/**
 * A per-person read (ADR 0101 §5, ADR 0108 §5). The gate already applied the F:x cell by the subject's jurisdiction;
 * here the subject must be in the caller's scope (S: self, Dp: own departments; otherwise 404). Reading someone else
 * writes `person.read` and then turns on app.person_read, both in this transaction, so the read and its audit event
 * commit or roll back together. Self reads are neither audited nor widened: RLS shows a person their own rows.
 */
export async function personRead(
  c: Context<AppEnv>,
  deps: Deps,
  tx: Tx,
  p: Principal,
  subjectId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const [row] = await tx`select department_id from people where id = ${subjectId}`;
  if (!row) throw notFound();
  const d = authorize(authzPrincipal(p), c.get("perm")!, { personId: subjectId, departmentId: row.department_id as string | null }, c.get("features"));
  if (!d.allow) throw new HttpError(d.status, d.code, d.code === "not_found" ? "not found" : "not allowed");
  if (subjectId === p.personId) return;
  await deps.ports.audit.write(tx, {
    actor: actorOf(p),
    action: "person.read",
    subjectPersonId: subjectId,
    resource: { type: "metrics", id: subjectId },
    detail,
  });
  await tx`select set_config('app.person_read', 'on', true)`;
}

/** Children of a group scope: a company's departments, a department's job roles (by name, then id). */
export async function childrenOf(tx: Tx, scope: Scope): Promise<Array<{ scope: Scope; label: string }>> {
  if (scope.type === "company") {
    const rows = await tx`select id, name from departments order by name, id limit 500`;
    return rows.map((r: { id: string; name: string }) => ({ scope: { type: "department" as const, id: r.id }, label: r.name }));
  }
  if (scope.type === "department") {
    const rows = await tx`select id, name from job_roles where department_id = ${scope.id} order by name, id limit 500`;
    return rows.map((r: { id: string; name: string }) => ({ scope: { type: "job_role" as const, id: r.id }, label: r.name }));
  }
  return [];
}
