import { asPrincipal, type Client, type Harness } from "../helpers/harness.ts";
import type { PersonKey } from "../helpers/seed.ts";
import { withTenant } from "../../src/db/tenant.ts";
import type { Tx } from "../../src/db/pool.ts";
import type { SeededTenant } from "../helpers/seed.ts";
import { listMigrations } from "../../src/db/migrate.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { templateById } from "../../src/modules/compliance/templates.ts";

export const DAY_MS = 86_400_000;
export const SHA = "a".repeat(64);

export interface Who {
  owner: Person;
  admin: Person;
  lead: Person;
  member: Person;
  member2: Person;
  auditor: Person;
}

/**
 * A browser for one seeded person that signs in again for every request, so tests can move the fake clock by days
 * without tripping the 30-minute idle limit of owner and admin sessions.
 */
export type Person = Pick<Client, "get" | "post" | "send"> & { personId: string };

function person(h: Harness, key: PersonKey, tenant: SeededTenant): Person {
  const send = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await asPrincipal(h, key, tenant)).send(method, path, body, headers);
  return {
    personId: tenant.people[key].id,
    send,
    get: (p, hd) => send("GET", p, undefined, hd),
    post: (p, b = {}, hd) => send("POST", p, b, hd),
  };
}

export async function signIn(h: Harness, tenant: SeededTenant = h.a): Promise<Who> {
  const keys: PersonKey[] = ["owner", "admin", "lead", "member", "member2", "auditor"];
  return Object.fromEntries(keys.map((k) => [k, person(h, k, tenant)])) as unknown as Who;
}

export type FeatureName = "workflow_metrics" | "per_person_views" | "working_time";

export function noticeBody(over: Partial<{ template: string; title: string; markdown: string; features: FeatureName[]; jurisdictions: string[] }> = {}) {
  return {
    template: "ontario-esa-policy",
    title: "How Offload is used at Acme",
    markdown: "# Electronic monitoring policy\n\nWhat is captured, why, who sees it, how long it is kept, how to pause.",
    features: ["workflow_metrics"] as FeatureName[],
    jurisdictions: [] as string[],
    ...over,
  };
}

/** Template `id`'s text with every field filled in (a custom notice gets the default text): publishable as is. */
export function filledMarkdown(id: string): string {
  const t = templateById(id);
  return t ? t.body.replace(/\{\{([a-z_]+)\}\}/g, (_, f: string) => `Acme's ${f.replace(/_/g, " ")}`) : noticeBody().markdown;
}

/** Creates and publishes a notice as the owner; returns the published notice DTO. */
export async function publishNotice(owner: Person, over: Parameters<typeof noticeBody>[0] = {}) {
  const template = over.template ?? noticeBody().template;
  const markdown = over.markdown ?? filledMarkdown(template);
  const created = await owner.post("/v1/compliance/notices", noticeBody({ ...over, markdown }));
  if (created.status !== 201) throw new Error(`create notice ${created.status} ${JSON.stringify(created.json)}`);
  const pub = await owner.post(`/v1/compliance/notices/${created.json.id}/publish`);
  if (pub.status !== 200) throw new Error(`publish notice ${pub.status} ${JSON.stringify(pub.json)}`);
  return pub.json;
}

export function enableBody(feature: "per_person_views" | "working_time", noticeVersionId: string, over: Record<string, unknown> = {}) {
  return {
    feature,
    jurisdictions: ["CA-ON"],
    legalBasis: "legitimate_interest",
    dpiaAttestation: {
      completedOn: "2026-10-01",
      documentHash: SHA,
      documentName: "dpia-2026.pdf",
      signerName: "Pia Owner",
      signerTitle: "Chief Operating Officer",
    },
    noticeVersionId,
    noticePeriodDays: 14,
    worksAgreementRef: null,
    quebecActivationAck: false,
    purposeLock: "process_improvement",
    ...over,
  };
}

/** Runs `fn` inside a system transaction of the tenant (what ports and jobs see). */
export function sys<T>(h: Harness, fn: (tx: Tx) => Promise<T>, tenant: SeededTenant = h.a): Promise<T> {
  return withTenant(h.db.app, { tenantId: tenant.id, accessRole: "system" }, fn);
}

/**
 * Whether this tree carries S2-05's per-person tables (migration 0501). The S2-08 branch alone does not; once S2-05 is
 * merged the retention and self-view tests below run against its real tables instead of stand-ins.
 */
export const INGEST_TABLES = listMigrations().some((m) => /CREATE TABLE run_outcomes\b/.test(m.sql));

/** Whether this tree carries S2-05's run ownership claims (migration 0505). */
export const RUN_OWNERS = listMigrations().some((m) => /CREATE TABLE run_owners\b/.test(m.sql));


export interface IngestRow {
  table: string;
  objectId: string;
}

/**
 * Inserts rows into S2-05's per-person tables as the migrator (what its ingest stores, column for column), each aged by
 * the given number of days before `now`. Returns what was inserted so tests can look the rows up again.
 */
export async function seedIngest(
  h: Harness,
  tenantId: string,
  personId: string,
  deviceId: string,
  now: number,
  ages: { runs?: number[]; reviews?: number[]; baselines?: number[]; daily?: number[]; workingTime?: number[] },
): Promise<IngestRow[]> {
  const m = h.db.migrator;
  const out: IngestRow[] = [];
  const day = (n: number) => new Date(now - n * DAY_MS).toISOString().slice(0, 10);
  const wf = crypto.randomUUID();
  for (const n of ages.runs ?? []) {
    const at = now - n * DAY_MS;
    const id = ulid(at);
    const runId = ulid(at);
    await m`insert into run_outcomes (tenant_id, device_id, run_id, object_id, person_id, seq, created_at_ms, workflow_id,
        version, runtime, started_at_ms, ended_at_ms, outcome, items_total, items_sent, items_failed_before_send,
        items_unknown, items_pending, batch_hash, approver_kind, overnight_policy_id, cost_cents, error_code, overnight, received_at)
      values (${tenantId}, ${deviceId}, ${runId}, ${id}, ${personId}, 1, ${at}, ${wf}, 1, 'mac', ${at - 60_000}, ${at},
        'success', 3, 3, 0, 0, 0, ${SHA}, 'person', null, 12, null, false, now())`;
    // S2-05's store claims each run id for the first device that stored it (migration 0505); hs-1 reads owned runs only.
    if (RUN_OWNERS) {
      await m`insert into run_owners (tenant_id, run_id, device_id, person_id) values (${tenantId}, ${runId}, ${deviceId}, ${personId})
        on conflict do nothing`;
    }
    out.push({ table: "run_outcomes", objectId: id });
  }
  for (const n of ages.reviews ?? []) {
    const at = now - n * DAY_MS;
    const id = ulid(at);
    await m`insert into review_events (tenant_id, device_id, object_id, person_id, seq, created_at_ms, run_id, review_seconds,
        edit_seconds, fix_seconds, items_edited, decision, surface, received_at)
      values (${tenantId}, ${deviceId}, ${id}, ${personId}, 1, ${at}, ${ulid(at)}, 30, 0, 0, 0, 'approved', 'mac_review', now())`;
    out.push({ table: "review_events", objectId: id });
  }
  for (const n of ages.baselines ?? []) {
    const at = now - n * DAY_MS;
    const id = ulid(at);
    await m`insert into baseline_samples (tenant_id, device_id, object_id, person_id, seq, created_at_ms, workflow_id, version,
        window_start, window_end, received_at)
      values (${tenantId}, ${deviceId}, ${id}, ${personId}, 1, ${at}, ${wf}, 1, ${day(n + 7)}, ${day(n)}, now())`;
    for (const idx of [0, 1]) {
      await m`insert into baseline_sample_instances (tenant_id, device_id, object_id, idx, person_id, instance_ref, active_seconds, day)
        values (${tenantId}, ${deviceId}, ${id}, ${idx}, ${personId}, ${"b".repeat(32)}, 300, ${day(n + idx)})`;
    }
    out.push({ table: "baseline_samples", objectId: id });
  }
  for (const n of ages.daily ?? []) {
    const at = now - n * DAY_MS;
    const id = ulid(at);
    await m`insert into daily_aggregates (tenant_id, device_id, object_id, person_id, seq, created_at_ms, day, active_workflows, received_at)
      values (${tenantId}, ${deviceId}, ${id}, ${personId}, 1, ${at}, ${day(n)}, 1, now())`;
    await m`insert into daily_aggregate_workflows (tenant_id, device_id, object_id, idx, person_id, workflow_id, version, runs,
        successes, saved_seconds_device)
      values (${tenantId}, ${deviceId}, ${id}, 0, ${personId}, ${wf}, 1, 2, 2, 600)`;
    out.push({ table: "daily_aggregates", objectId: id });
  }
  for (const n of ages.workingTime ?? []) {
    const at = now - n * DAY_MS;
    const id = ulid(at);
    await m`insert into working_time_aggregates (tenant_id, device_id, object_id, person_id, seq, created_at_ms, day,
        active_minutes, first_active_quarter, last_active_quarter, notice_version_id, received_at)
      values (${tenantId}, ${deviceId}, ${id}, ${personId}, 1, ${at}, ${day(n)}, 420, 36, 70, ${crypto.randomUUID()}, now())`;
    out.push({ table: "working_time_aggregates", objectId: id });
  }
  return out;
}
