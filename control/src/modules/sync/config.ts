// GET /v1/sync/config (device-config.schema.json): what this device may send now, from the server's own records.
import type { Deps, Principal } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import type { ConsentPort } from "../../ports.ts";

/** In device-config order. */
const KINDS = [
  "notice_ack", "run_outcome", "review_event", "baseline_sample", "daily_aggregate", "working_time_aggregate", "workflow_proposal",
] as const;

export const MIN_APP_VERSION = "2.0.0";
/** Outbox flush cadence (ADR 0103 §4). */
export const FLUSH_SECONDS = 900;

interface RequiredNotice {
  noticeVersionId: string;
  title: string;
  markdown: string;
  features: Array<"workflow_metrics" | "per_person_views" | "working_time">;
}

/**
 * Optional ConsentPort extras the compliance slice can provide alongside `allows` (ports.ts names only `allows`):
 * the notice the person must acknowledge and when working time may start for them. Without them the config has no
 * required notice and no working-time start, which the Mac reads as "nothing but notice_ack" (ADR 0111 §3).
 */
interface ConsentExtras {
  requiredNotice?(tx: Tx, personId: string): Promise<RequiredNotice | null>;
  workingTimeStartsAt?(tx: Tx, personId: string): Promise<number | null>;
}

export async function deviceConfig(tx: Tx, deps: Deps, p: Extract<Principal, { kind: "device" }>) {
  const consent = deps.ports.consent as ConsentPort & ConsentExtras;
  const enabled = await deps.ports.features.enabledFor(tx, p.jurisdiction);
  const allowedKinds: string[] = [];
  for (const k of KINDS) {
    if (k === "working_time_aggregate" && !enabled.has("working_time")) continue;
    if (await consent.allows(tx, p.personId, k)) allowedKinds.push(k);
  }
  return {
    personId: p.personId,
    tenantId: p.tenantId,
    jurisdiction: p.jurisdiction,
    requiredNotice: consent.requiredNotice ? await consent.requiredNotice(tx, p.personId) : null,
    allowedKinds,
    features: { workflow_metrics: true, per_person_views: enabled.has("per_person_views"), working_time: enabled.has("working_time") },
    workingTimeStartsAt: enabled.has("working_time") && consent.workingTimeStartsAt ? await consent.workingTimeStartsAt(tx, p.personId) : null,
    killSwitch: await deps.ports.broker.killSwitchActive(tx, { personId: p.personId }),
    minAppVersion: MIN_APP_VERSION,
    flushSeconds: FLUSH_SECONDS,
  };
}
