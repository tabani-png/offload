import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { notFound } from "../../schema/http.ts";

export type Feature = "workflow_metrics" | "per_person_views" | "working_time";
export type Sensitive = "per_person_views" | "working_time";
export const SENSITIVE: readonly Sensitive[] = ["per_person_views", "working_time"];
export const DAY_MS = 86_400_000;

export interface NoticeRow {
  id: string;
  version: number;
  template: string;
  title: string;
  markdown: string;
  features: Feature[];
  jurisdictions: string[];
  published_at_ms: string | null;
  replaced_at_ms: string | null;
  acks?: number;
}

export const ms = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** A notice applies to everyone when it names no jurisdictions, otherwise to the ones it names. */
export function applies(n: Pick<NoticeRow, "jurisdictions">, jurisdiction: string): boolean {
  return n.jurisdictions.length === 0 || n.jurisdictions.includes(jurisdiction);
}

export function noticeDto(n: NoticeRow) {
  return {
    id: n.id,
    version: n.version,
    title: n.title,
    markdown: n.markdown,
    features: n.features,
    jurisdictions: n.jurisdictions,
    publishedAt: ms(n.published_at_ms),
    replacedAt: ms(n.replaced_at_ms),
    template: n.template,
    acks: n.acks ?? 0,
  };
}

const NOTICE_COLS = (tx: Tx) => tx`n.id, n.version, n.template, n.title, n.markdown, n.features, n.jurisdictions,
  n.published_at_ms, n.replaced_at_ms, (select count(*)::int from notice_acks a where a.notice_id = n.id) as acks`;

export async function noticeById(tx: Tx, id: string): Promise<NoticeRow | null> {
  const [n] = await tx`select ${NOTICE_COLS(tx)} from notices n where n.id = ${id}`;
  return (n as NoticeRow | undefined) ?? null;
}

export async function listNotices(tx: Tx, publishedOnly: boolean, offset: number, limit: number): Promise<NoticeRow[]> {
  return (await tx`select ${NOTICE_COLS(tx)} from notices n
    where (${!publishedOnly} or n.published_at_ms is not null)
    order by n.version desc offset ${offset} limit ${limit}`) as NoticeRow[];
}

/** Whether notice `n` is live at `at`: published by then and not yet replaced. The one rule every endpoint uses. */
export function liveAt(n: Pick<NoticeRow, "published_at_ms" | "replaced_at_ms">, at: number): boolean {
  return n.published_at_ms !== null && Number(n.published_at_ms) <= at && (n.replaced_at_ms === null || Number(n.replaced_at_ms) > at);
}

/**
 * The notice a person in `jurisdiction` must have acknowledged at `at`: of the notices live then that apply to them,
 * the one published last. Publish order is `publish_seq` (stamped under the publish lock): publish times can tie and
 * versions follow creation, so neither may pick it. Same rule as `liveAt`, in SQL.
 */
export async function currentNotice(tx: Tx, jurisdiction: string, at: number): Promise<NoticeRow | null> {
  const [n] = await tx`select ${NOTICE_COLS(tx)} from notices n
    where n.published_at_ms is not null and n.published_at_ms <= ${at}
      and (n.replaced_at_ms is null or n.replaced_at_ms > ${at})
      and (jsonb_array_length(n.jurisdictions) = 0 or n.jurisdictions @> ${[jurisdiction]}::jsonb)
    order by n.publish_seq desc limit 1`;
  return (n as NoticeRow | undefined) ?? null;
}

export async function personRow(tx: Tx, id: string): Promise<{ jurisdiction: string; state: string; department_id: string | null } | null> {
  if (!isUuid(id)) return null;
  const [p] = await tx`select jurisdiction, state, department_id from people where id = ${id}`;
  return (p as { jurisdiction: string; state: string; department_id: string | null } | undefined) ?? null;
}

/** YYYY-MM-DD of an instant in an IANA timezone. */
export function dayIn(timezone: string, at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Shifts a YYYY-MM-DD day by whole days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function uuidParam(c: Context<AppEnv>, name = "id"): string {
  const v = c.req.param(name);
  if (!v || !isUuid(v)) throw notFound();
  return v;
}

/** `?cursor=` for offset-paged lists (cursor body `{ n }`). */
export function offsetOf(cursor: Record<string, unknown> | null): number {
  return typeof cursor?.n === "number" && Number.isInteger(cursor.n) && cursor.n >= 0 ? cursor.n : 0;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
