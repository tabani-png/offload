/**
 * Employee self-view (ADR 0108 §4): `GET /v1/me/data` and `/v1/me/export` (everything held about me), `/v1/me/access-log`
 * ("who looked"), correction requests. `PERSON_COLUMNS` names every column in the control plane that holds a person
 * id and where it shows up here; a test scans the catalog and fails when a table is not covered.
 */
import type { Context } from "hono";
import type { App, AppEnv, Deps } from "../../app.ts";
import { actorOf, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { msNN, ms as pgMs } from "../../db/pool.ts";
import { personById } from "../../db/people.ts";
import { auditDto, type AuditEvent } from "../../audit/audit.ts";
import { HttpError, invalid, page, pageParams } from "../../schema/http.ts";
import { DAY_MS, addDays, dayIn, personRow } from "./common.ts";
import { isEnabled } from "./features.ts";
import { myHoursSaved, runOutcomeOf } from "./hours.ts";
import { ackDto } from "./notices.ts";
import { P, bodyOf, replyLocal } from "./schemas.ts";

const SELF_VIEW = "offload/stage2/self-view.schema.json";
const EXPORTS_PER_DAY = 5;

type Section = "person" | "acks" | "devices" | "accessLog" | "runs" | "dailyAggregates" | "workingTime";

export interface PersonColumn {
  table: string;
  column: string;
  /** The self-view field that shows these rows, or null with the reason they are not part of it. */
  shownIn: Section | null;
  reason?: string;
  /** Set for another wave-B slice's table, which a tree without that slice does not have yet. */
  slice?: "S2-05" | "S2-06" | "S2-07";
}

export const PERSON_COLUMNS: readonly PersonColumn[] = [
  { table: "people", column: "id", shownIn: "person" },
  { table: "job_role_holders", column: "person_id", shownIn: "person" },
  { table: "devices", column: "person_id", shownIn: "devices" },
  { table: "audit_events", column: "subject_person_id", shownIn: "accessLog" },
  { table: "notice_acks", column: "person_id", shownIn: "acks" },
  {
    table: "sessions", column: "person_id", shownIn: null,
    reason: "sign-in sessions hold only token hashes and times; they are revoked on freeze and never shown or exported",
  },
  {
    table: "enrollment_codes", column: "person_id", shownIn: null,
    reason: "one-time device enrollment codes (hashed, 10-minute life); the enrolled device itself is listed under devices",
  },
  {
    table: "connections", column: "owner_person_id", shownIn: null,
    reason: "my connections are listed by GET /v1/connections (self scope) and hold references, never secrets",
  },
  {
    table: "support_grants", column: "granted_by", shownIn: null,
    reason: "an owner's act, not data about the owner as an employee; every grant is in the audit log",
  },
  {
    table: "notices", column: "created_by", shownIn: null,
    reason: "an editor's act on a notice version, not data about them; the creation is in the audit log",
  },
  {
    table: "feature_enablements", column: "enabled_by", shownIn: null,
    reason: "the owner's attributable enablement act, shown to everyone in GET /v1/compliance/features",
  },
  {
    table: "feature_enablements", column: "disabled_by", shownIn: null,
    reason: "the act of turning a feature off, recorded in the audit log as feature.disable",
  },
  {
    table: "correction_requests", column: "person_id", shownIn: null,
    reason: "my own requests; each one is in my access log as correction.request (the self-view schema has no field for them)",
  },
  // S2-05 ingest (migration 0501): what my devices synced.
  { table: "run_outcomes", column: "person_id", shownIn: "runs", slice: "S2-05" },
  {
    table: "run_owners", column: "person_id", shownIn: null, slice: "S2-05",
    reason: "which device's copy of a run counts (migration 0505); the run itself is listed under runs",
  },
  { table: "daily_aggregates", column: "person_id", shownIn: "dailyAggregates", slice: "S2-05" },
  { table: "daily_aggregate_workflows", column: "person_id", shownIn: "dailyAggregates", slice: "S2-05" },
  { table: "working_time_aggregates", column: "person_id", shownIn: "workingTime", slice: "S2-05" },
  {
    table: "review_events", column: "person_id", shownIn: null, slice: "S2-05",
    reason: "review and edit seconds per run, an input of the hs-1 metric (S2-05); the self-view schema has no field for them",
  },
  {
    table: "baseline_samples", column: "person_id", shownIn: null, slice: "S2-05",
    reason: "the manual-time baseline windows my device measured, an input of the hs-1 metric; the self-view schema has no field for them",
  },
  {
    table: "baseline_sample_instances", column: "person_id", shownIn: null, slice: "S2-05",
    reason: "the per-instance seconds inside a baseline sample (hashed instance refs only), part of the baseline sample above",
  },
  // S2-06 registry (migration 0600): acts on shared workflows, not data about the person as an employee.
  {
    table: "workflows", column: "proposed_by", shownIn: null, slice: "S2-06",
    reason: "my own proposals are listed to me by GET /v1/workflows (self scope); the self-view schema has no field for them",
  },
  {
    table: "workflows", column: "promoted_by", shownIn: null, slice: "S2-06",
    reason: "a reviewer's act of promoting a workflow, recorded in the audit log as workflow.promote",
  },
  {
    table: "workflow_versions", column: "created_by", shownIn: null, slice: "S2-06",
    reason: "who saved a workflow version, an editor's act on shared content; the save is in the audit log",
  },
  {
    table: "proposals_declined", column: "declined_by", shownIn: null, slice: "S2-06",
    reason: "a reviewer's act of declining a proposal, recorded in the audit log as workflow.decline",
  },
  // S2-07 policies and broker (migration 0700).
  {
    table: "batches", column: "runner_person_id", shownIn: null, slice: "S2-07",
    reason: "send batches I ran are listed to me by GET /v1/batches; their outcomes are in runs above",
  },
  {
    table: "overnight_policies", column: "owner_person_id", shownIn: null, slice: "S2-07",
    reason: "overnight policies I own are listed to me by GET /v1/overnight-policies and every change is audited",
  },
  {
    table: "kill_switches", column: "set_by", shownIn: null, slice: "S2-07",
    reason: "an admin's act of setting a kill switch, recorded in the audit log",
  },
  {
    table: "role_policies", column: "updated_by", shownIn: null, slice: "S2-07",
    reason: "an editor's act on a job role's policy, recorded in the audit log",
  },
];

/** Columns of this schema named `person_id` / `*_person_id`, or with a foreign key to `people`, plus `people.id`. */
export async function personColumnsInCatalog(tx: Tx): Promise<Array<{ table: string; column: string }>> {
  const rows = (await tx`
    select c.relname as "table", a.attname as "column"
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = current_schema() and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
       and (a.attname = 'person_id' or a.attname like '%\\_person\\_id' or (c.relname = 'people' and a.attname = 'id'))
    union
    select c.relname, a.attname
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class r on r.oid = k.confrelid
      join lateral unnest(k.conkey, k.confkey) as u(col, refcol) on true
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.col
      join pg_attribute ra on ra.attrelid = k.confrelid and ra.attnum = u.refcol
     where k.contype = 'f' and n.nspname = current_schema() and r.relname = 'people' and ra.attname = 'id'
    order by 1, 2`) as Array<{ table: string; column: string }>;
  return rows;
}

export function uncovered(found: ReadonlyArray<{ table: string; column: string }>): Array<{ table: string; column: string }> {
  const known = new Set(PERSON_COLUMNS.map((c) => `${c.table}.${c.column}`));
  return found.filter((f) => !known.has(`${f.table}.${f.column}`));
}

/**
 * "Who looked": events about me, and list reads that included me. A list read writes one event whose `detail.ids`
 * names every person read in that call; I see it with `ids` cut down to my own id, never the others'.
 */
async function accessLog(
  tx: Tx,
  personId: string,
  q: { action?: string; from?: number; to?: number; afterSeq?: number; limit: number; newestFirst?: boolean },
): Promise<{ events: AuditEvent[]; seqs: number[] }> {
  const rows = (await tx`select * from audit_events
    where (subject_person_id = ${personId}
        or detail -> 'ids' @> ${[personId]}::jsonb)
      and (${q.action ?? null}::text is null or action = ${q.action ?? null})
      and (${q.from ?? null}::bigint is null or at_ms >= ${q.from ?? null}::bigint)
      and (${q.to ?? null}::bigint is null or at_ms < ${q.to ?? null}::bigint)
      and seq > ${q.afterSeq ?? 0}
    order by seq ${q.newestFirst ? tx`desc` : tx`asc`} limit ${q.limit}`) as Array<Parameters<typeof auditDto>[0] & { seq: string }>;
  return { events: rows.map((r) => onlyMe(auditDto(r), personId)), seqs: rows.map((r) => Number(r.seq)) };
}

function onlyMe(e: AuditEvent, personId: string): AuditEvent {
  const ids = e.detail.ids;
  if (!Array.isArray(ids)) return e;
  return { ...e, detail: { ...e.detail, ids: ids.filter((id) => id === personId) } };
}

/** Whether this tree has `table` (S2-05's tables come with that slice; without them there is nothing to show). */
async function hasTable(tx: Tx, table: string): Promise<boolean> {
  const [r] = await tx`select to_regclass(quote_ident(${table})) is not null as ok`;
  return Boolean(r!.ok);
}

/** My run outcomes, newest first (run-outcome.schema.json). */
async function myRuns(tx: Tx, personId: string) {
  if (!(await hasTable(tx, "run_outcomes"))) return [];
  const rows = (await tx`select * from run_outcomes where person_id = ${personId}
    order by ended_at_ms desc, object_id limit 1000`) as Array<Record<string, unknown>>;
  return rows.map(runOutcomeOf);
}

/** My daily aggregates with their per-workflow rows, newest day first (daily-aggregate.schema.json). */
async function myDailyAggregates(tx: Tx, personId: string) {
  if (!(await hasTable(tx, "daily_aggregates"))) return [];
  const rows = (await tx`select d.object_id, d.created_at_ms, to_char(d.day, 'YYYY-MM-DD') as day, d.active_workflows,
      coalesce((select jsonb_agg(jsonb_build_object('workflowId', w.workflow_id, 'version', w.version, 'runs', w.runs,
          'successes', w.successes, 'savedSecondsDevice', w.saved_seconds_device) order by w.idx)
        from daily_aggregate_workflows w
        where w.tenant_id = d.tenant_id and w.device_id = d.device_id and w.object_id = d.object_id), '[]'::jsonb) as workflows
    from daily_aggregates d where d.person_id = ${personId}
    order by d.day desc, d.object_id limit 400`) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.object_id as string,
    kind: "daily_aggregate" as const,
    createdAt: Number(r.created_at_ms),
    day: r.day as string,
    activeWorkflows: Number(r.active_workflows),
    workflows: r.workflows as unknown[],
  }));
}

/** My working-time days, newest first (working-time-aggregate.schema.json). */
async function myWorkingTime(tx: Tx, personId: string) {
  if (!(await hasTable(tx, "working_time_aggregates"))) return [];
  const rows = (await tx`select object_id, created_at_ms, to_char(day, 'YYYY-MM-DD') as day, active_minutes,
      first_active_quarter, last_active_quarter, notice_version_id
    from working_time_aggregates where person_id = ${personId}
    order by day desc, object_id limit 400`) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.object_id as string,
    kind: "working_time_aggregate" as const,
    createdAt: Number(r.created_at_ms),
    day: r.day as string,
    activeMinutes: Number(r.active_minutes),
    firstActiveQuarter: Number(r.first_active_quarter),
    lastActiveQuarter: Number(r.last_active_quarter),
    noticeVersionId: r.notice_version_id as string,
  }));
}

/** The days my per-person rows are kept for, ending today (local days in the tenant timezone, `toExclusive` tomorrow). */
function retentionWindow(timezone: string, perPersonDays: number, now: number) {
  const today = dayIn(timezone, now);
  return { from: addDays(today, -perPersonDays + 1), toExclusive: addDays(today, 1) };
}

/** Everything the control plane holds about `personId` (self-view schema). */
export async function assembleSelfView(tx: Tx, personId: string, now: number) {
  const person = await personById(tx, personId);
  if (!person) throw new HttpError(404, "not_found", "not found");
  const [t] = await tx`select reporting_timezone, retention_per_person_days, retention_working_time_days from tenants`;
  const tz = t!.reporting_timezone as string;
  const perPersonDays = Number(t!.retention_per_person_days);
  const acks = (await tx`select * from notice_acks where person_id = ${personId}
    order by acknowledged_at_ms desc, id limit 100`) as Parameters<typeof ackDto>[0][];
  const devices = (await tx`select id, person_id, name, app_version, enrolled_at, last_sync_at, state from devices
    where person_id = ${personId} order by enrolled_at desc limit 20`) as Array<{
    id: string; person_id: string; name: string; app_version: string; enrolled_at: Date; last_sync_at: Date | null; state: "active" | "revoked";
  }>;
  const log = await accessLog(tx, personId, { limit: 1000, newestFirst: true });
  return {
    person,
    features: {
      workflow_metrics: true,
      per_person_views: await isEnabled(tx, "per_person_views", person.jurisdiction, now),
      working_time: await isEnabled(tx, "working_time", person.jurisdiction, now),
    },
    acks: acks.map(ackDto),
    devices: devices.map((d) => ({
      id: d.id,
      personId: d.person_id,
      name: d.name,
      appVersion: d.app_version,
      enrolledAt: msNN(d.enrolled_at),
      lastSyncAt: pgMs(d.last_sync_at),
      state: d.state,
    })),
    hoursSaved: await myHoursSaved(tx, personId, retentionWindow(tz, perPersonDays, now), tz),
    dailyAggregates: await myDailyAggregates(tx, personId),
    workingTime: await myWorkingTime(tx, personId),
    runs: await myRuns(tx, personId),
    accessLog: log.events.reverse(),
    retention: { perPersonDays, workingTimeDays: Number(t!.retention_working_time_days) },
  };
}

function tsParam(c: Context<AppEnv>, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw invalid(`${name} must be epoch ms`);
  return n;
}

export function selfRoutes(app: App, deps: Deps): void {
  app.get("/v1/me/data", async (c) => {
    const out = await tenantTx(c, deps, (tx, p) => assembleSelfView(tx, p.personId, deps.clock.now()));
    return reply(c, deps, 200, out, SELF_VIEW);
  });

  app.get("/v1/me/export", async (c) => {
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      // Count and record under one per-person lock, so concurrent exports cannot all pass the check.
      await tx`select pg_advisory_xact_lock(hashtextextended('self.export:' || current_setting('app.tenant_id') || ':' || ${p.personId}, 0))`;
      const recent = (await tx`select at_ms from audit_events where action = 'self.export' and actor_id = ${p.personId}
        and at_ms > ${now - DAY_MS} order by at_ms`) as Array<{ at_ms: string }>;
      if (recent.length >= EXPORTS_PER_DAY) {
        const retry = Math.max(1, Math.ceil((Number(recent[0]!.at_ms) + DAY_MS - now) / 1000));
        throw new HttpError(429, "rate_limited", `at most ${EXPORTS_PER_DAY} exports a day`, { retryAfterSeconds: retry });
      }
      // Assembled before its own audit event, so the export equals what /v1/me/data showed a moment earlier.
      const view = await assembleSelfView(tx, p.personId, now);
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "self.export",
        subjectPersonId: p.personId,
        resource: { type: "person", id: p.personId },
        detail: { format: "json" },
      });
      return view;
    }).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 429) c.header("Retry-After", String(e.details?.retryAfterSeconds ?? 3600));
      throw e;
    });
    c.header("Content-Disposition", `attachment; filename="offload-my-data-${dayIn("UTC", now)}.json"`);
    return reply(c, deps, 200, out, SELF_VIEW);
  });

  app.get("/v1/me/access-log", async (c) => {
    const { limit, cursor } = pageParams(c);
    const action = c.req.query("action");
    if (action !== undefined && !/^[a-z_]+\.[a-z_]+$/.test(action)) throw invalid("bad action");
    // About me only: there is no subject filter to choose.
    if (c.req.query("subjectPersonId") !== undefined) throw invalid("subjectPersonId is not a parameter here");
    const from = tsParam(c, "from");
    const to = tsParam(c, "to");
    const afterSeq = typeof cursor?.seq === "number" ? cursor.seq : 0;
    const out = await tenantTx(c, deps, async (tx, p) => {
      const r = await accessLog(tx, p.personId, {
        ...(action ? { action } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        afterSeq,
        limit: limit + 1,
      });
      return page(r.events, limit, () => ({ seq: r.seqs[limit - 1] ?? 0 }));
    });
    return reply(c, deps, 200, out, "offload/control/audit-event-list.json");
  });

  app.post("/v1/me/correction-requests", async (c) => {
    const req = await bodyOf<{ field: string; message: string }>(c, `${P}/correction-request.json`);
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      if (!(await personRow(tx, p.personId))) throw new HttpError(404, "not_found", "not found");
      const [row] = await tx`insert into correction_requests (tenant_id, person_id, field, message, created_at_ms)
        values (current_setting('app.tenant_id')::uuid, ${p.personId}, ${req.field}, ${req.message}, ${now}) returning id`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "correction.request",
        subjectPersonId: p.personId,
        resource: { type: "correction_request", id: row!.id as string },
        detail: { field: req.field },
      });
      return { id: row!.id as string };
    });
    return replyLocal(c, deps, 201, out, `${P}/correction-response.json`);
  });
}
