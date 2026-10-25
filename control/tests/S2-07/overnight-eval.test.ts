// S2-07 OVERNIGHT (pure): evaluateOvernight is table-driven over ADR 0106 §3, and the send window is computed in the
// recipient's timezone, DST included.
import { describe, expect, test } from "bun:test";
import {
  evaluateOvernight,
  inWindow,
  nextWindowStart,
  nightOf,
  recipientAllowed,
  type OvernightCounters,
  type OvernightItem,
  type OvernightPolicy,
} from "../../src/modules/policies/evaluate.ts";

const TPL = "a".repeat(64);
// Monday 2026-10-26 09:00 UTC (T0 of the harness).
const MON_9_UTC = Date.UTC(2026, 9, 26, 9, 0, 0);

const policy = (over: Partial<OvernightPolicy> = {}): OvernightPolicy => ({
  id: "11111111-1111-4111-8111-111111111111",
  workflowId: "22222222-2222-4222-8222-222222222222",
  version: 1,
  mode: "preapproved",
  recipients: { emails: ["ana@fund.com"], domains: ["northzone.com"], repliesToThreadsStartedByIdentity: false },
  templateHash: TPL,
  maxCommitsPerNight: 10,
  maxPerRecipientPerWeek: 1,
  sendWindow: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5], recipientTimezone: true },
  attachmentsAllowed: false,
  budgetCentsPerNight: 500,
  dryRunNights: 3,
  dryRunNightsDone: 3,
  circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 2 },
  state: "active",
  trippedReason: null,
  ownerPersonId: "33333333-3333-4333-8333-333333333333",
  ...over,
});

const item = (over: Partial<OvernightItem> = {}): OvernightItem => ({
  recipient: "ana@fund.com",
  recipientTimezone: "UTC",
  hasAttachments: false,
  templateHash: TPL,
  replyToIdentityThread: false,
  ...over,
});

const counters = (over: Partial<OvernightCounters> = {}): OvernightCounters => ({
  dryRunNight: false,
  commitsTonight: 0,
  recipientThisWeek: 0,
  budgetCentsTonight: 0,
  killSwitch: false,
  ...over,
});

const ctx = { now: MON_9_UTC, ownerTimezone: "UTC" };

type Row = [name: string, p: Partial<OvernightPolicy>, i: Partial<OvernightItem>, c: Partial<OvernightCounters>, want: string];

const TABLE: Row[] = [
  ["allowlist hit (email)", {}, {}, {}, "allow"],
  ["allowlist hit (domain)", {}, { recipient: "tom@northzone.com" }, {}, "allow"],
  ["allowlist miss", {}, { recipient: "x@evil.example" }, {}, "trip:recipient_not_allowed"],
  ["subdomain is not the domain", {}, { recipient: "tom@mail.northzone.com" }, {}, "trip:recipient_not_allowed"],
  ["reply to identity thread allowed when the policy says so", { recipients: { emails: [], domains: [], repliesToThreadsStartedByIdentity: true } }, { recipient: "z@other.com", replyToIdentityThread: true }, {}, "allow"],
  ["reply rule without an identity thread", { recipients: { emails: [], domains: [], repliesToThreadsStartedByIdentity: true } }, { recipient: "z@other.com" }, {}, "trip:recipient_not_allowed"],
  ["template hash mismatch", {}, { templateHash: "b".repeat(64) }, {}, "trip:template_hash_mismatch"],
  ["run without a template hash", {}, { templateHash: null }, {}, "trip:template_hash_mismatch"],
  ["policy without a template hash", { templateHash: null }, {}, {}, "trip:template_hash_mismatch"],
  ["drafts_only mode", { mode: "drafts_only" }, {}, {}, "queue:drafts_only"],
  ["tripped policy", { state: "tripped", trippedReason: "bounce_rate" }, {}, {}, "queue:policy_tripped"],
  ["paused policy", { state: "paused" }, {}, {}, "queue:policy_paused"],
  ["kill switch", {}, {}, { killSwitch: true }, "queue:kill_switch"],
  ["dry-run night", {}, {}, { dryRunNight: true }, "queue:dry_run_night"],
  ["dry-run night still trips on a bad recipient", {}, { recipient: "x@evil.example" }, { dryRunNight: true }, "trip:recipient_not_allowed"],
  ["attachments not allowed", {}, { hasAttachments: true }, {}, "queue:attachments_not_allowed"],
  ["attachments allowed", { attachmentsAllowed: true }, { hasAttachments: true }, {}, "allow"],
  ["night cap reached", { maxCommitsPerNight: 2 }, {}, { commitsTonight: 2 }, "queue:night_cap"],
  ["night cap not reached", { maxCommitsPerNight: 2 }, {}, { commitsTonight: 1 }, "allow"],
  ["zero night cap", { maxCommitsPerNight: 0 }, {}, {}, "queue:night_cap"],
  ["recipient week cap reached", { maxPerRecipientPerWeek: 1 }, {}, { recipientThisWeek: 1 }, "queue:recipient_week_cap"],
  ["recipient week cap not reached", { maxPerRecipientPerWeek: 2 }, {}, { recipientThisWeek: 1 }, "allow"],
  ["night budget spent", { budgetCentsPerNight: 100 }, {}, { budgetCentsTonight: 100 }, "queue:night_budget"],
];

describe("S2-07 evaluateOvernight table", () => {
  for (const [name, p, i, c, want] of TABLE) {
    test(`OVERNIGHT: ${name} → ${want}`, () => {
      const d = evaluateOvernight(policy(p), item(i), counters(c), ctx);
      expect(d.result === "allow" ? "allow" : `${d.result}:${d.reason}`).toBe(want);
    });
  }

  test("OVERNIGHT: pure: the same inputs give the same decision", () => {
    const a = evaluateOvernight(policy(), item(), counters(), ctx);
    const b = evaluateOvernight(policy(), item(), counters(), ctx);
    expect(a).toEqual(b);
  });

  test("OVERNIGHT: allowlist matching is case-insensitive and ignores a leading @ on domains", () => {
    expect(recipientAllowed(policy({ recipients: { emails: ["Ana@Fund.com"], domains: [], repliesToThreadsStartedByIdentity: false } }), { recipient: "ana@fund.com", replyToIdentityThread: false })).toBe(true);
    expect(recipientAllowed(policy({ recipients: { emails: [], domains: ["@Fund.com"], repliesToThreadsStartedByIdentity: false } }), { recipient: "bo@fund.com", replyToIdentityThread: false })).toBe(true);
  });
});

describe("S2-07 send window in the recipient's timezone", () => {
  const w = { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5], recipientTimezone: true };

  test("OVERNIGHT: allowed inside the window → scheduled now", () => {
    const d = evaluateOvernight(policy(), item({ recipientTimezone: "Europe/London" }), counters(), ctx);
    expect(d).toEqual({ result: "allow", reason: null, scheduledFor: MON_9_UTC });
  });

  test("OVERNIGHT: a recipient in Toronto at 05:00 local is scheduled to 08:00 local (12:00 UTC)", () => {
    const d = evaluateOvernight(policy(), item({ recipientTimezone: "America/Toronto" }), counters(), ctx);
    expect(d.result).toBe("allow");
    expect(d.result === "allow" && d.scheduledFor).toBe(Date.UTC(2026, 9, 26, 12, 0, 0));
  });

  test("OVERNIGHT: recipientTimezone false uses the owner's timezone", () => {
    const d = evaluateOvernight(policy({ sendWindow: { ...w, recipientTimezone: false } }), item({ recipientTimezone: "America/Toronto" }), counters(), { now: MON_9_UTC, ownerTimezone: "Europe/Berlin" });
    // 10:00 in Berlin: inside the owner's window.
    expect(d.result === "allow" && d.scheduledFor).toBe(MON_9_UTC);
  });

  test("OVERNIGHT: an unknown recipient timezone falls back to the owner's", () => {
    const d = evaluateOvernight(policy(), item({ recipientTimezone: "Not/AZone" }), counters(), { now: MON_9_UTC, ownerTimezone: "UTC" });
    expect(d.result === "allow" && d.scheduledFor).toBe(MON_9_UTC);
  });

  test("OVERNIGHT: Friday evening is scheduled to Monday morning (weekend skipped)", () => {
    const fri19 = Date.UTC(2026, 9, 30, 19, 0, 0);
    expect(nextWindowStart(w, "UTC", fri19)).toBe(Date.UTC(2026, 10, 2, 8, 0, 0));
  });

  test("OVERNIGHT: half-hour offset zones land on the local hour (Asia/Kolkata 08:00 = 02:30 UTC)", () => {
    const t = Date.UTC(2026, 9, 26, 0, 0, 0);
    expect(nextWindowStart(w, "Asia/Kolkata", t)).toBe(Date.UTC(2026, 9, 26, 2, 30, 0));
  });

  test("OVERNIGHT: DST change in New York (1 Nov 2026) keeps 08:00 local", () => {
    // Monday 2 Nov 2026, after the fall back: 08:00 EST = 13:00 UTC.
    const sun = Date.UTC(2026, 10, 1, 20, 0, 0);
    expect(nextWindowStart(w, "America/New_York", sun)).toBe(Date.UTC(2026, 10, 2, 13, 0, 0));
  });

  test("OVERNIGHT: never inside the window outside its hours", () => {
    expect(inWindow(w, "UTC", Date.UTC(2026, 9, 26, 7, 59, 0))).toBe(false);
    expect(inWindow(w, "UTC", Date.UTC(2026, 9, 26, 8, 0, 0))).toBe(true);
    expect(inWindow(w, "UTC", Date.UTC(2026, 9, 26, 18, 0, 0))).toBe(false);
    expect(inWindow(w, "UTC", Date.UTC(2026, 9, 31, 10, 0, 0))).toBe(false); // Saturday
  });

  test("OVERNIGHT: an empty window has no instant", () => {
    expect(nextWindowStart({ ...w, startHour: 18, endHour: 8 }, "UTC", MON_9_UTC)).toBe(Number.POSITIVE_INFINITY);
  });

  test("OVERNIGHT: a night spanning midnight is one night", () => {
    expect(nightOf(Date.UTC(2026, 9, 26, 23, 0, 0), "UTC")).toBe("2026-10-26");
    expect(nightOf(Date.UTC(2026, 9, 27, 4, 0, 0), "UTC")).toBe("2026-10-26");
    expect(nightOf(Date.UTC(2026, 9, 27, 13, 0, 0), "UTC")).toBe("2026-10-27");
  });
});
