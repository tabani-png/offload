/**
 * Consent gates G1 and G2 of ADR 0103 §2, decided from this module's records (ADR 0111 §3: forward only, fail closed).
 * - G1: nothing but `notice_ack` until the person acknowledged the current notice for their jurisdiction (or an
 *   earlier one listing every feature it lists). No published notice means nothing but the acknowledgement.
 * - G2: `working_time_aggregate` only while `working_time` is effective for the person's jurisdiction and they
 *   acknowledged a notice that lists it.
 * Every answer is "at instant `at`": an ack or enablement later than `at` does not count, so history stays answerable.
 */
import type { Tx } from "../../db/pool.ts";
import { currentNotice, personRow, type NoticeRow } from "./common.ts";
import { effectiveSince, isEnabled } from "./features.ts";

export const SYNC_KINDS = [
  "notice_ack",
  "run_outcome",
  "review_event",
  "baseline_sample",
  "daily_aggregate",
  "working_time_aggregate",
  "workflow_proposal",
] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

const STOPPED = new Set(["frozen", "departed"]);

/** Earliest ack time (≤ at) of a notice that applies to `jurisdiction` and lists every feature in `features`. */
async function ackCovering(tx: Tx, personId: string, jurisdiction: string, features: readonly string[], at: number): Promise<number | null> {
  const [r] = await tx`select min(a.acknowledged_at_ms) as at from notice_acks a join notices n on n.id = a.notice_id
    where a.person_id = ${personId} and a.acknowledged_at_ms <= ${at}
      and n.features @> ${features}::jsonb
      and (jsonb_array_length(n.jurisdictions) = 0 or n.jurisdictions @> ${[jurisdiction]}::jsonb)`;
  return r?.at === null || r?.at === undefined ? null : Number(r.at);
}

interface State {
  notice: NoticeRow | null;
  g1: boolean;
  workingTimeSince: number | null;
  jurisdiction: string | null;
}

async function state(tx: Tx, personId: string, at: number): Promise<State> {
  const p = await personRow(tx, personId);
  if (!p) return { notice: null, g1: false, workingTimeSince: null, jurisdiction: null };
  const notice = await currentNotice(tx, p.jurisdiction, at);
  const g1 = !STOPPED.has(p.state) && notice !== null && (await ackCovering(tx, personId, p.jurisdiction, notice.features, at)) !== null;
  let workingTimeSince: number | null = null;
  if (g1) {
    const effective = await effectiveSince(tx, "working_time", p.jurisdiction, at);
    const acked = effective === null ? null : await ackCovering(tx, personId, p.jurisdiction, ["working_time"], at);
    if (effective !== null && acked !== null) workingTimeSince = Math.max(effective, acked);
  }
  return { notice, g1, workingTimeSince, jurisdiction: p.jurisdiction };
}

function allowedBy(s: State, kind: string): boolean {
  if (kind === "notice_ack") return true;
  if (!(SYNC_KINDS as readonly string[]).includes(kind) || !s.g1) return false;
  return kind === "working_time_aggregate" ? s.workingTimeSince !== null : true;
}

/** ConsentPort.allows at a given instant. */
export async function allowsAt(tx: Tx, personId: string, kind: string, at: number): Promise<boolean> {
  if (kind === "notice_ack") return true;
  return allowedBy(await state(tx, personId, at), kind);
}

/**
 * The consent part of `GET /v1/sync/config` (device-config schema), for the sync slice to serve: the notice to show,
 * what may be sent now, the features on for this person and when working time may start.
 */
export async function deviceConsent(tx: Tx, personId: string, at: number) {
  const s = await state(tx, personId, at);
  const j = s.jurisdiction;
  return {
    requiredNotice: s.notice
      ? { noticeVersionId: s.notice.id, title: s.notice.title, markdown: s.notice.markdown, features: s.notice.features }
      : null,
    allowedKinds: SYNC_KINDS.filter((k) => allowedBy(s, k)),
    features: {
      workflow_metrics: true,
      per_person_views: j !== null && (await isEnabled(tx, "per_person_views", j, at)),
      working_time: j !== null && (await isEnabled(tx, "working_time", j, at)),
    },
    workingTimeStartsAt: s.workingTimeSince,
  };
}

/** When this person's consent (G1) started: data observed before it never leaves the Mac. Null without consent. */
export async function consentSince(tx: Tx, personId: string, at: number): Promise<number | null> {
  const p = await personRow(tx, personId);
  if (!p || STOPPED.has(p.state)) return null;
  const notice = await currentNotice(tx, p.jurisdiction, at);
  return notice ? ackCovering(tx, personId, p.jurisdiction, notice.features, at) : null;
}
