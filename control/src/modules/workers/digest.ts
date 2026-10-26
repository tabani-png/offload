/**
 * The morning digest (ADR 0106 §5, ADR 0112 §9): what the person's cloud runs did overnight, what waits for them,
 * what an overnight policy auto-approved, breaker trips and costs. Counts and hashes only: no recipients or bodies.
 * Sending it by email is out of scope; `digestText` is the plain-text template.
 */
import type { App, Deps } from "../../app.ts";
import { reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { invalid } from "../../schema/http.ts";
import { localDay, localInstant } from "./cron.ts";
import { outcomeOf } from "./orchestrator.ts";
import type { RunState } from "./repo.ts";
import { DIGEST } from "./schemas.ts";

const DAY_MS = 86_400_000;

export interface Digest {
  personId: string;
  day: string;
  ran: Array<{ runId: string; workflowId: string; outcome: string; drafts: number; costCents: number }>;
  waiting: Array<{ batchHash: string; workflowId: string; items: number }>;
  autoCommitted: Array<{ batchHash: string; policyId: string; items: number }>;
  trips: Array<{ policyId: string; reason: string }>;
  suggestions: Array<{ title: string; class: string; estimatedMinutes: number; label: "estimated" }>;
  totalCostCents: number;
}

function realDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** The window a digest day covers: from 12:00 the day before to 12:00 that day, local. */
export function windowOf(day: string, tz: string): { from: number; to: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const prev = new Date(Date.UTC(y, m - 1, d) - DAY_MS);
  return {
    from: localInstant(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 12, 0, tz),
    to: localInstant(y, m, d, 12, 0, tz),
  };
}

/** The digest that covers `t`: the local day of t + 12 h. */
export const digestDayOf = (t: number, tz: string) => localDay(t + 12 * 3600_000, tz);

export async function buildDigest(tx: Tx, _deps: Deps, personId: string, day: string, tz: string): Promise<Digest> {
  const { from, to } = windowOf(day, tz);
  const runs = await tx`select r.id, r.state, r.cost_cents, w.workflow_id,
      coalesce((select sum(b.items) from worker_run_batches b where b.tenant_id = r.tenant_id and b.run_id = r.id), 0)::int as drafts
    from worker_runs r join workers w on w.tenant_id = r.tenant_id and w.id = r.worker_id
    where r.runner_person_id = ${personId} and r.ended_at is not null and r.started_at >= ${new Date(from)} and r.started_at < ${new Date(to)}
    order by r.id limit 200`;
  const ran: Digest["ran"] = runs.flatMap((r: Record<string, unknown>) => {
    const outcome = outcomeOf(r.state as RunState);
    return outcome === null ? [] : [{ runId: r.id as string, workflowId: r.workflow_id as string, outcome, drafts: Number(r.drafts), costCents: Number(r.cost_cents) }];
  });
  // Filtered in SQL before the limit (the broker's stored batch state), so 200 is 200 pending batches.
  const waiting: Digest["waiting"] = (await tx`select distinct b.batch_hash, b.items, w.workflow_id from worker_run_batches b
      join worker_runs r on r.tenant_id = b.tenant_id and r.id = b.run_id join workers w on w.tenant_id = r.tenant_id and w.id = r.worker_id
      join batches bt on bt.tenant_id = b.tenant_id and bt.hash = b.batch_hash
      where r.runner_person_id = ${personId} and bt.state = 'pending' order by b.batch_hash limit 200`).map((b: Record<string, unknown>) => ({
    batchHash: b.batch_hash as string,
    workflowId: b.workflow_id as string,
    items: Number(b.items),
  }));
  // Every ended run of the window, not only the 200 listed.
  const [total] = await tx`select coalesce(sum(cost_cents), 0)::bigint as c from worker_runs
    where runner_person_id = ${personId} and ended_at is not null and started_at >= ${new Date(from)} and started_at < ${new Date(to)}`;
  const auto = await tx`select b.batch_hash, b.policy_id, b.auto_approved from worker_run_batches b
      join worker_runs r on r.tenant_id = b.tenant_id and r.id = b.run_id
    where r.runner_person_id = ${personId} and b.auto_approved > 0 and b.policy_id is not null
      and r.started_at >= ${new Date(from)} and r.started_at < ${new Date(to)} order by b.at limit 200`;
  const trips = await tx`select distinct t.policy_id, t.reason from worker_run_trips t join worker_runs r on r.tenant_id = t.tenant_id and r.id = t.run_id
    where r.runner_person_id = ${personId} and r.started_at >= ${new Date(from)} and r.started_at < ${new Date(to)} order by t.policy_id, t.reason limit 50`;
  return {
    personId,
    day,
    ran,
    waiting,
    autoCommitted: auto.map((a: Record<string, unknown>) => ({ batchHash: a.batch_hash as string, policyId: a.policy_id as string, items: Number(a.auto_approved) })),
    trips: trips.map((t: Record<string, unknown>) => ({ policyId: t.policy_id as string, reason: t.reason as string })),
    // Tonight's suggestions come from the person's Mac in a later sync kind (ADR 0112 §9).
    suggestions: [],
    totalCostCents: Number(total!.c),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The digest email body (template only; nothing sends it). */
export function digestText(d: Digest): string {
  const dollars = `$${(d.totalCostCents / 100).toFixed(2)}`;
  const outcomes = new Map<string, number>();
  for (const r of d.ran) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
  const lines = [
    `Your Offload morning digest for ${d.day}`,
    "",
    `Overnight: ${plural(d.ran.length, "run")}, ${dollars} in cloud costs.`,
    ...[...outcomes.entries()].sort().map(([o, n]) => `  ${o}: ${n}`),
    `${plural(d.waiting.length, "batch", "batches")} waiting for your approval (${plural(d.waiting.reduce((s, w) => s + w.items, 0), "item")}).`,
    `${plural(d.autoCommitted.reduce((s, a) => s + a.items, 0), "item")} approved by an overnight policy.`,
    d.trips.length === 0 ? "No circuit breaker tripped." : `${plural(d.trips.length, "circuit breaker trip")}: ${d.trips.map((t) => t.reason).join(", ")}. The policy is paused until you re-arm it.`,
    "",
    "Open Offload to review, approve or reject. Nothing waiting is sent until you approve it.",
  ];
  return lines.join("\n");
}

export function digestRoutes(app: App, deps: Deps): void {
  app.get("/v1/me/digest", async (c) => {
    const q = c.req.query("day");
    if (q !== undefined && !realDay(q)) throw invalid("day must be a calendar day YYYY-MM-DD");
    const out = await tenantTx(c, deps, async (tx, p) => {
      const [t] = await tx`select reporting_timezone from tenants where id = current_setting('app.tenant_id')::uuid`;
      const tz = (t?.reporting_timezone as string | undefined) ?? "UTC";
      const day = q ?? digestDayOf(deps.clock.now(), tz);
      const d = await buildDigest(tx, deps, p.personId, day, tz);
      await deps.ports.audit.write(tx, {
        actor: { type: p.kind === "device" ? "device" : "person", id: p.kind === "device" ? p.deviceId : p.personId, accessRole: p.accessRole },
        action: "digest.read",
        subjectPersonId: p.personId,
        resource: { type: "person", id: p.personId },
        detail: { day, runs: d.ran.length },
      });
      return d;
    });
    return reply(c, deps, 200, out, DIGEST);
  });
}
