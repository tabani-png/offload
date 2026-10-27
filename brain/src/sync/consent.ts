// Consent gates on the Mac (ADR 0103 §2), from GET /v1/sync/config; the server re-checks G1-G2 on its own records.
//   G1  nothing but notice_ack until the person acknowledged the tenant's current notice version;
//   G2  working_time_aggregate only if working_time is enabled for the person, an acknowledged notice lists it, and
//       now >= workingTimeStartsAt (enabledAt + noticePeriodDays); disabled -> queued ones are DROPPED;
//   G3  daily_aggregate is always sent once G1 passed (server-side use is gated by per_person_views);
//   G4  workflow_proposal only after an explicit confirm on a preview of the exact JSON (POST /workflows/:id/share);
//   G5  paused -> everything is held in the encrypted outbox (30-day purge).
// Unknown config (never fetched, or unreadable) = send nothing but notice_ack. A kill switch holds everything else too.
// ADR 0111 §3: consent is forward-only. Nothing observed before the person acknowledged the required notice leaves this
// Mac (consentStartsAt is the acknowledgement time, not its day), and a config with no required notice lets nothing but
// notice_ack leave (fail closed).
import type { DeviceConfig, Feature, SyncKind } from "./types.ts";

export type Decision = "send" | "hold" | "drop";

export interface LocalAck {
  noticeVersionId: string;
  acknowledgedAt: number;
  features: Feature[];
}

export interface ConsentState {
  config: DeviceConfig | null;
  acks: readonly LocalAck[];
  paused: boolean;
  now: number;
}

/** The acknowledged notice version that lists working_time, if any (the newest). */
export function workingTimeNotice(acks: readonly LocalAck[]): LocalAck | null {
  return [...acks].filter((a) => a.features.includes("working_time")).sort((a, b) => b.acknowledgedAt - a.acknowledgedAt)[0] ?? null;
}

/** G1: the config names a required notice and this Mac acknowledged that version. No required notice = not satisfied. */
export function noticeSatisfied(s: ConsentState): boolean {
  return consentStartsAt(s) !== null;
}

/** When consent began: the acknowledgement time of the required notice version on this Mac, or null (none required,
 * or not acknowledged). Only what was observed at or after this moment may be projected. */
export function consentStartsAt(s: ConsentState): number | null {
  const required = s.config?.requiredNotice ?? null;
  if (required === null) return null;
  const at = s.acks.filter((a) => a.noticeVersionId === required.noticeVersionId).map((a) => a.acknowledgedAt);
  return at.length === 0 ? null : Math.min(...at);
}

/** G2 without the pause: may a working-time aggregate exist and be sent now? */
export function workingTimeAllowed(s: ConsentState): boolean {
  const c = s.config;
  if (c === null || !noticeSatisfied(s) || c.killSwitch) return false;
  if (!c.features.working_time || !c.allowedKinds.includes("working_time_aggregate")) return false;
  if (workingTimeNotice(s.acks) === null) return false;
  return c.workingTimeStartsAt !== null && s.now >= c.workingTimeStartsAt;
}

/**
 * What to do with one queued object of `kind` now. `confirmed`: the user confirmed this proposal on its preview (G4).
 * `forQueue`: deciding whether to build/queue it at all (pause does not stop building, it only holds sending).
 */
export function decide(kind: SyncKind, s: ConsentState, opts: { confirmed?: boolean; forQueue?: boolean } = {}): Decision {
  if (kind === "notice_ack") return s.paused && opts.forQueue !== true ? "hold" : "send";
  const c = s.config;
  if (kind === "working_time_aggregate" && c !== null && !c.features.working_time) return "drop";
  if (kind === "workflow_proposal" && opts.confirmed !== true) return "drop";
  if (c === null || !noticeSatisfied(s) || c.killSwitch) return "hold";
  if (!c.allowedKinds.includes(kind)) return "hold";
  if (kind === "working_time_aggregate" && !workingTimeAllowed(s)) return "hold";
  if (s.paused && opts.forQueue !== true) return "hold";
  return "send";
}
