/**
 * ADR 0106 §3: `evaluateOvernight(policy, item, counters) → allow | queue | trip(reason)`, pure and deterministic.
 * The broker calls it per item of an overnight batch; `allow` mints the same one-use token a person's approval would
 * (approverKind "policy"). Checks, in order (trips before queues, so a dry-run night still catches a bad recipient):
 *   policy not active                         → queue (policy_<state>)
 *   kill switch in scope                      → queue (kill_switch)
 *   mode drafts_only                          → queue (drafts_only)
 *   template hash missing or different        → trip  (template_hash_mismatch)
 *   recipient outside the allowlist           → trip  (recipient_not_allowed)
 *   dry-run night (first K nights)            → queue (dry_run_night)
 *   attachments while not allowed             → queue (attachments_not_allowed)
 *   per-night commit cap reached              → queue (night_cap)
 *   per-recipient weekly cap reached          → queue (recipient_week_cap)
 *   per-night budget spent                    → queue (night_budget)
 *   otherwise                                 → allow, scheduled into the send window
 */

export interface SendWindow {
  startHour: number;
  endHour: number;
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** true: the hours are the recipient's local hours; false: the owner's (tenant reporting timezone). */
  recipientTimezone: boolean;
}

export interface OvernightPolicy {
  id: string;
  workflowId: string;
  version: number;
  mode: "drafts_only" | "preapproved";
  recipients: { emails: string[]; domains: string[]; repliesToThreadsStartedByIdentity: boolean };
  templateHash: string | null;
  maxCommitsPerNight: number;
  maxPerRecipientPerWeek: number;
  sendWindow: SendWindow;
  attachmentsAllowed: boolean;
  budgetCentsPerNight: number;
  dryRunNights: number;
  dryRunNightsDone: number;
  circuitBreakers: { bounceRatePct: number; negativeReplySpike: number; consecutiveFailures: number };
  state: "active" | "tripped" | "paused";
  trippedReason: string | null;
  ownerPersonId: string;
}

export interface OvernightItem {
  /** Normalised recipient address. */
  recipient: string;
  /** IANA timezone of the recipient (falls back to the owner's when unknown). */
  recipientTimezone: string | null;
  hasAttachments: boolean;
  /** Template hash the run drafted with (sha256 of SKILL.md + facts.md + tone card). */
  templateHash: string | null;
  /** The item replies to a thread the sending identity started. */
  replyToIdentityThread: boolean;
}

export interface OvernightCounters {
  /** This night is one of the policy's first `dryRunNights` nights. */
  dryRunNight: boolean;
  /** Items already auto-approved by this policy tonight (this batch's earlier items included). */
  commitsTonight: number;
  /** Items to this recipient auto-approved by this policy in the last 7 days (this batch's earlier items included). */
  recipientThisWeek: number;
  budgetCentsTonight: number;
  killSwitch: boolean;
}

export interface EvalContext {
  now: number;
  /** IANA timezone of the owner (tenant reporting timezone). */
  ownerTimezone: string;
}

export type OvernightDecision =
  | { result: "allow"; reason: null; scheduledFor: number }
  | { result: "queue"; reason: string }
  | { result: "trip"; reason: string };

/** Lowercased domain of an address, or null. */
const domainOf = (addr: string) => {
  const at = addr.lastIndexOf("@");
  return at < 0 ? null : addr.slice(at + 1).toLowerCase();
};

export function recipientAllowed(policy: Pick<OvernightPolicy, "recipients">, item: Pick<OvernightItem, "recipient" | "replyToIdentityThread">): boolean {
  const r = item.recipient.toLowerCase();
  if (policy.recipients.emails.some((e) => e.trim().toLowerCase() === r)) return true;
  const d = domainOf(r);
  // Exact domain only: a subdomain is a different organisation as far as an allowlist is concerned.
  if (d !== null && policy.recipients.domains.some((x) => x.trim().toLowerCase().replace(/^@/, "") === d)) return true;
  return policy.recipients.repliesToThreadsStartedByIdentity && item.replyToIdentityThread;
}

/**
 * What an edit does to the trust a policy grants (ADR 0112 §1-2). `narrowed`: something it allowed before is no
 * longer allowed, so what it already approved and has not sent loses that approval. `widened`: it allows something it
 * did not, so its dry-run nights start again. A new template or a switched timezone basis is both. Breakers that get
 * stricter are neither (they act on signals, not on what was approved); state is handled by the caller (re-arm keeps
 * the nights, anything but active narrows).
 */
export function trustChange(a: OvernightPolicy, b: OvernightPolicy): { narrowed: boolean; widened: boolean } {
  const set = (xs: readonly string[]) => new Set(xs.map((x) => x.trim().toLowerCase().replace(/^@/, "")));
  const lost = (x: Set<string>, y: Set<string>) => [...x].some((v) => !y.has(v));
  const [ea, eb, da, db] = [set(a.recipients.emails), set(b.recipients.emails), set(a.recipients.domains), set(b.recipients.domains)];
  const [wa, wb] = [a.sendWindow, b.sendWindow];
  const [daysA, daysB] = [new Set(wa.days.map(String)), new Set(wb.days.map(String))];
  let narrowed = b.state !== "active";
  let widened = false;
  const both = a.templateHash !== b.templateHash || wa.recipientTimezone !== wb.recipientTimezone;
  narrowed ||=
    both ||
    lost(ea, eb) ||
    lost(da, db) ||
    (a.recipients.repliesToThreadsStartedByIdentity && !b.recipients.repliesToThreadsStartedByIdentity) ||
    (a.mode === "preapproved" && b.mode === "drafts_only") ||
    lost(daysA, daysB) ||
    wb.startHour > wa.startHour ||
    wb.endHour < wa.endHour ||
    b.maxCommitsPerNight < a.maxCommitsPerNight ||
    b.maxPerRecipientPerWeek < a.maxPerRecipientPerWeek ||
    b.budgetCentsPerNight < a.budgetCentsPerNight ||
    (a.attachmentsAllowed && !b.attachmentsAllowed);
  widened ||=
    both ||
    lost(eb, ea) ||
    lost(db, da) ||
    (!a.recipients.repliesToThreadsStartedByIdentity && b.recipients.repliesToThreadsStartedByIdentity) ||
    (a.mode === "drafts_only" && b.mode === "preapproved") ||
    lost(daysB, daysA) ||
    wb.startHour < wa.startHour ||
    wb.endHour > wa.endHour ||
    b.maxCommitsPerNight > a.maxCommitsPerNight ||
    b.maxPerRecipientPerWeek > a.maxPerRecipientPerWeek ||
    b.budgetCentsPerNight > a.budgetCentsPerNight ||
    (!a.attachmentsAllowed && b.attachmentsAllowed) ||
    b.circuitBreakers.bounceRatePct > a.circuitBreakers.bounceRatePct ||
    b.circuitBreakers.negativeReplySpike > a.circuitBreakers.negativeReplySpike ||
    b.circuitBreakers.consecutiveFailures > a.circuitBreakers.consecutiveFailures;
  return { narrowed, widened };
}

export function evaluateOvernight(
  policy: OvernightPolicy,
  item: OvernightItem,
  counters: OvernightCounters,
  ctx: EvalContext,
): OvernightDecision {
  if (policy.state !== "active") return { result: "queue", reason: `policy_${policy.state}` };
  if (counters.killSwitch) return { result: "queue", reason: "kill_switch" };
  if (policy.mode === "drafts_only") return { result: "queue", reason: "drafts_only" };
  if (policy.templateHash === null || item.templateHash === null || policy.templateHash !== item.templateHash) {
    return { result: "trip", reason: "template_hash_mismatch" };
  }
  if (!recipientAllowed(policy, item)) return { result: "trip", reason: "recipient_not_allowed" };
  if (counters.dryRunNight) return { result: "queue", reason: "dry_run_night" };
  if (item.hasAttachments && !policy.attachmentsAllowed) return { result: "queue", reason: "attachments_not_allowed" };
  if (counters.commitsTonight >= policy.maxCommitsPerNight) return { result: "queue", reason: "night_cap" };
  if (counters.recipientThisWeek >= policy.maxPerRecipientPerWeek) return { result: "queue", reason: "recipient_week_cap" };
  if (counters.budgetCentsTonight >= policy.budgetCentsPerNight) return { result: "queue", reason: "night_budget" };
  const tz = windowTimezone(policy.sendWindow, item.recipientTimezone, ctx.ownerTimezone);
  return { result: "allow", reason: null, scheduledFor: nextWindowStart(policy.sendWindow, tz, ctx.now) };
}

// ---------- send window (local hours in an IANA timezone, DST-safe) ----------

export function windowTimezone(w: SendWindow, recipientTz: string | null, ownerTz: string): string {
  return w.recipientTimezone && recipientTz !== null && isTimezone(recipientTz) ? recipientTz : ownerTz;
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local calendar parts of an instant in `tz`. */
export function localParts(t: number, tz: string): { day: string; weekday: number; hour: number; minute: number } {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY[parts.weekday!] ?? 0,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function inWindow(w: SendWindow, tz: string, t: number): boolean {
  const p = localParts(t, tz);
  return w.days.includes(p.weekday) && p.hour >= w.startHour && p.hour < w.endHour;
}

const QUARTER = 15 * 60_000;

/**
 * The first instant ≥ now inside the window. Every real UTC offset is a multiple of 15 minutes, so local hour starts
 * fall on UTC quarter hours; stepping quarter by quarter is exact across DST changes. Searches 8 days (a window has
 * at least one day per week); an empty window (start ≥ end) has no instant and yields +∞.
 */
export function nextWindowStart(w: SendWindow, tz: string, now: number): number {
  if (w.startHour >= w.endHour || w.days.length === 0) return Number.POSITIVE_INFINITY;
  if (inWindow(w, tz, now)) return now;
  let t = Math.ceil(now / QUARTER) * QUARTER;
  const limit = now + 8 * 24 * 3600_000;
  for (; t <= limit; t += QUARTER) if (inWindow(w, tz, t)) return t;
  return Number.POSITIVE_INFINITY;
}

/**
 * Nights. A night is named by a local calendar date D and runs from local noon of D to local noon of D + 1 in `tz` (a
 * night spanning midnight is one night). `nightOf` and `nightStart` are the only definition of that boundary: every
 * night id and every "since tonight began" cutoff comes from them, so they agree on DST days too (a night is 23 or 25
 * hours long then; subtracting a fixed 12 h is not the same boundary).
 */
export const NIGHT_START_HOUR = 12;

const nextDate = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 24 * 3600_000).toISOString().slice(0, 10);

/** The night an instant belongs to: its local date, or the day before when it is before local noon. */
export function nightOf(t: number, tz: string): string {
  const p = localParts(t, tz);
  return p.hour >= NIGHT_START_HOUR ? p.day : nextDate(p.day, -1);
}

/** The instant night `night` starts: the first instant of local noon on that date. Every real UTC offset is a multiple
 * of 15 minutes (-12:00 .. +14:00), so local noon falls on a UTC quarter hour in that range. */
export function nightStart(night: string, tz: string): number {
  const utcNoon = Date.parse(`${night}T${String(NIGHT_START_HOUR).padStart(2, "0")}:00:00Z`);
  for (let t = utcNoon - 14 * 3600_000; t <= utcNoon + 12 * 3600_000; t += QUARTER) {
    const p = localParts(t, tz);
    if (p.day === night && p.hour >= NIGHT_START_HOUR) return t;
    if (p.day > night) break;
  }
  throw new Error(`nightStart: no local noon on ${night} in ${tz}`);
}
