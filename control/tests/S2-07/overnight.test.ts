// S2-07 OVERNIGHT (broker): pre-approved policies mint the same one-use token a person would (approverKind policy),
// only after the dry-run nights, inside caps and the send window; breakers pause the policy and queue the rest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { client, email, items, overnightPolicy, overnightRun, propose, TPL, world, type World } from "./setup.ts";

let w: World;
const DAY = 24 * 3600_000;
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const policyRow = async (id: string) =>
  (await w.h.db.migrator`select state, tripped_reason, dry_run_nights_done from overnight_policies where tenant_id = ${w.t.id} and id = ${id}`)[0]!;
const trips = async (id: string) =>
  (await w.h.db.migrator`select reason from breaker_trips where tenant_id = ${w.t.id} and policy_id = ${id} order by at`).map((r: Record<string, unknown>) => r.reason);
const tokensOf = async (hash: string) =>
  w.h.db.migrator`select approver_kind, approved_by, policy_id, used_at, revoked_at from approval_tokens where tenant_id = ${w.t.id} and batch_hash = ${hash}`;

describe("S2-07 overnight policies in the broker", () => {
  test("OVERNIGHT: the first 3 nights are dry runs (queued); the 4th night auto-approves with a policy token and sends", async () => {
    const pid = await overnightPolicy(w, { dryRunNights: 3, recipients: { emails: [], domains: ["dry.example"], repliesToThreadsStartedByIdentity: false }, maxPerRecipientPerWeek: 7 });
    const results: string[] = [];
    for (let night = 0; night < 4; night++) {
      const r = await propose(w, [email(`n${night}@dry.example`)], overnightRun(pid));
      expect(r.ok).toBe(true);
      results.push(r.ok && r.overnightEvaluation ? `${r.overnightEvaluation.result}:${r.overnightEvaluation.reason ?? ""}` : "none");
      await w.broker.idle();
      w.h.clock.advance(DAY);
    }
    expect(results).toEqual(["queue:dry_run_night", "queue:dry_run_night", "queue:dry_run_night", "allow:"]);
    expect((await policyRow(pid)).dry_run_nights_done).toBe(3);
    expect(w.composio.args().at(-1)).toMatchObject({ recipient_email: "n3@dry.example" });
  });

  test("OVERNIGHT: a second batch the same night does not count another dry-run night", async () => {
    const pid = await overnightPolicy(w, { dryRunNights: 2, recipients: { emails: [], domains: ["same.example"], repliesToThreadsStartedByIdentity: false }, maxPerRecipientPerWeek: 7 });
    await propose(w, [email("a@same.example")], overnightRun(pid));
    w.h.clock.advance(3600_000);
    await propose(w, [email("b@same.example")], overnightRun(pid));
    expect((await policyRow(pid)).dry_run_nights_done).toBe(1);
    w.h.clock.advance(DAY);
  });

  test("OVERNIGHT: allow mints the same one-use token a person would, recorded with the policy id", async () => {
    const pid = await overnightPolicy(w);
    const r = await propose(w, [email("ana@fund.com")], overnightRun(pid));
    expect(r).toMatchObject({ ok: true, autoApproved: 1, overnightEvaluation: { policyId: pid, result: "allow", reason: null } });
    await w.broker.idle();
    const hash = r.ok ? r.batchHash : "";
    const [t] = await tokensOf(hash);
    expect(t).toMatchObject({ approver_kind: "policy", approved_by: pid, policy_id: pid });
    expect(t!.used_at).not.toBeNull();
    expect((await items(w, hash))[0]!.state).toBe("sent");
    const [e] = await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action = 'batch.approve'
      and resource_id = ${hash}`;
    expect(e!.detail).toMatchObject({ approverKind: "policy", policyId: pid, templateHash: TPL });
    // The batch DTO carries the evaluation.
    const dto = await (await client(w, "member")).get(`/v1/batches/${hash}`);
    expect(dto.json.overnightEvaluation).toEqual({ policyId: pid, result: "allow", reason: null });
  });

  test("OVERNIGHT: a recipient outside the allowlist trips the policy; nothing in the batch is auto-approved", async () => {
    const pid = await overnightPolicy(w);
    const r = await propose(w, [email("bo@fund.com"), email("stranger@else.com")], overnightRun(pid));
    expect(r).toMatchObject({ ok: true, autoApproved: 0, overnightEvaluation: { result: "trip", reason: "recipient_not_allowed" } });
    expect(await policyRow(pid)).toMatchObject({ state: "tripped", tripped_reason: "recipient_not_allowed" });
    expect(await trips(pid)).toEqual(["recipient_not_allowed"]);
    expect(await tokensOf(r.ok ? r.batchHash : "")).toHaveLength(0);
    // Later batches under the tripped policy are queued for a person.
    const next = await propose(w, [email("cy@fund.com")], overnightRun(pid));
    expect(next).toMatchObject({ ok: true, autoApproved: 0, overnightEvaluation: { result: "queue", reason: "policy_tripped" } });
  });

  test("OVERNIGHT: a proposed recipient outside the run's input set is recipient_not_allowed and trips (prompt injection)", async () => {
    const pid = await overnightPolicy(w);
    const r = await propose(w, [email("attacker@evil.example")], overnightRun(pid, { inputRecipients: ["ana@fund.com"] }));
    expect(r).toMatchObject({ ok: false, code: "recipient_not_allowed", tripped: "recipient_not_allowed" });
    expect((await policyRow(pid)).state).toBe("tripped");
    // A recipient in the input set is fine even when it is not on the overnight allowlist (it simply queues).
    const ok = await propose(w, [email("dee@partner.com")], { inputRecipients: ["dee@partner.com"] });
    expect(ok.ok).toBe(true);
  });

  test("OVERNIGHT: a template hash that differs from the pinned one trips", async () => {
    const pid = await overnightPolicy(w);
    const r = await propose(w, [email("ana@fund.com", "Other")], overnightRun(pid, { templateHash: "d".repeat(64) }));
    expect(r).toMatchObject({ ok: true, overnightEvaluation: { result: "trip", reason: "template_hash_mismatch" } });
    expect((await policyRow(pid)).tripped_reason).toBe("template_hash_mismatch");
  });

  test("OVERNIGHT: the per-night cap holds across batches; the rest queue (night_cap)", async () => {
    const pid = await overnightPolicy(w, { maxCommitsPerNight: 2, recipients: { emails: [], domains: ["cap.example"], repliesToThreadsStartedByIdentity: false }, maxPerRecipientPerWeek: 7 });
    const a = await propose(w, [email("a@cap.example")], overnightRun(pid));
    const b = await propose(w, [email("b@cap.example"), email("c@cap.example")], overnightRun(pid));
    expect(a).toMatchObject({ autoApproved: 1 });
    expect(b).toMatchObject({ autoApproved: 1, overnightEvaluation: { result: "queue", reason: "partial: night_cap" } });
    await w.broker.idle();
    expect((await items(w, b.ok ? b.batchHash : "")).map((i) => i.state)).toEqual(["sent", "pending"]);
    w.h.clock.advance(DAY);
  });

  test("OVERNIGHT: the per-recipient weekly cap holds across nights", async () => {
    const pid = await overnightPolicy(w, { maxPerRecipientPerWeek: 1, recipients: { emails: ["weekly@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false } });
    const first = await propose(w, [email("weekly@fund.com", "Week 1")], overnightRun(pid));
    expect(first).toMatchObject({ autoApproved: 1 });
    await w.broker.idle();
    w.h.clock.advance(2 * DAY);
    const second = await propose(w, [email("weekly@fund.com", "Week 1 again")], overnightRun(pid));
    expect(second).toMatchObject({ autoApproved: 0, overnightEvaluation: { result: "queue", reason: "recipient_week_cap" } });
    w.h.clock.advance(6 * DAY);
  });

  test("OVERNIGHT: items are scheduled into the send window in the recipient's timezone and not sent before it", async () => {
    const pid = await overnightPolicy(w, {
      sendWindow: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5, 6, 7], recipientTimezone: true },
      recipients: { emails: ["toronto@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false },
    });
    // Align to 09:00 UTC = 05:00 in Toronto (EDT/EST either way before 08:00).
    const t0 = w.h.clock.now();
    w.h.clock.t = Math.ceil(t0 / DAY) * DAY + 9 * 3600_000;
    const r = await propose(w, [email("toronto@fund.com")], overnightRun(pid, { recipientTimezones: { "toronto@fund.com": "America/Toronto" } }));
    await w.broker.idle();
    const hash = r.ok ? r.batchHash : "";
    const [it] = await items(w, hash);
    expect(it!.state).toBe("pending");
    const at = it!.scheduled_for!.getTime();
    expect(at).toBeGreaterThan(w.h.clock.now());
    const calls = w.composio.calls.length;
    await w.broker.runDue(w.t.id, hash);
    expect(w.composio.calls.length).toBe(calls);
    w.h.clock.t = at;
    await w.broker.runDue(w.t.id, hash);
    expect((await items(w, hash))[0]!.state).toBe("sent");
    w.h.clock.advance(DAY);
  });

  test("OVERNIGHT: drafts_only never auto-approves", async () => {
    const pid = await overnightPolicy(w, { mode: "drafts_only" });
    const r = await propose(w, [email("ana@fund.com", "Drafts")], overnightRun(pid));
    expect(r).toMatchObject({ autoApproved: 0, overnightEvaluation: { result: "queue", reason: "drafts_only" } });
  });

  test("OVERNIGHT: bounce rate over the breaker pauses the policy", async () => {
    const pid = await overnightPolicy(w);
    expect(await w.broker.reportNightSignals(w.t.id, pid, { sends: 20, bounces: 1 })).toBeNull();
    expect(await w.broker.reportNightSignals(w.t.id, pid, { bounces: 1 })).toBe("bounce_rate");
    expect(await policyRow(pid)).toMatchObject({ state: "tripped", tripped_reason: "bounce_rate" });
  });

  test("OVERNIGHT: a negative-reply spike and consecutive failed runs trip", async () => {
    const a = await overnightPolicy(w);
    expect(await w.broker.reportNightSignals(w.t.id, a, { negativeReplies: 3 })).toBe("negative_reply_spike");
    const b = await overnightPolicy(w);
    expect(await w.broker.reportRunResult(w.t.id, b, false)).toBeNull();
    expect(await w.broker.reportRunResult(w.t.id, b, false)).toBe("consecutive_failures");
    expect(await trips(b)).toEqual(["consecutive_failures"]);
  });

  test("OVERNIGHT: a changed commit connection (auth change) trips the policy", async () => {
    const pid = await overnightPolicy(w, { recipients: { emails: [], domains: ["auth.example"], repliesToThreadsStartedByIdentity: false }, maxPerRecipientPerWeek: 7 });
    expect(await propose(w, [email("a@auth.example")], overnightRun(pid))).toMatchObject({ autoApproved: 1 });
    await w.broker.idle();
    await w.h.db.migrator`update connections set external_ref = 'acct_relinked' where id = ${w.conns.memberGmail}`;
    try {
      const r = await propose(w, [email("b@auth.example")], overnightRun(pid));
      expect(r).toMatchObject({ autoApproved: 0, overnightEvaluation: { result: "trip", reason: "connection_auth_change" } });
    } finally {
      await w.h.db.migrator`update connections set external_ref = 'acct_member_gmail' where id = ${w.conns.memberGmail}`;
    }
    w.h.clock.advance(DAY);
  });

  test("OVERNIGHT: a trip revokes the policy's unspent approvals so scheduled items go back to a person", async () => {
    const pid = await overnightPolicy(w, {
      sendWindow: { startHour: 8, endHour: 9, days: [1, 2, 3, 4, 5, 6, 7], recipientTimezone: false },
      recipients: { emails: ["later@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false },
    });
    w.h.clock.t = Math.ceil(w.h.clock.now() / DAY) * DAY + 20 * 3600_000; // 20:00 UTC: outside the window
    const r = await propose(w, [email("later@fund.com")], overnightRun(pid));
    await w.broker.idle();
    const hash = r.ok ? r.batchHash : "";
    expect((await items(w, hash))[0]!.token_id).not.toBeNull();
    await w.broker.reportNightSignals(w.t.id, pid, { negativeReplies: 5 });
    const [it] = await items(w, hash);
    expect(it).toMatchObject({ state: "pending", token_id: null, scheduled_for: null });
    w.h.clock.advance(DAY);
    await w.broker.runDue(w.t.id, hash);
    expect((await items(w, hash))[0]!.state).toBe("pending");
  });

  test("OVERNIGHT: policies: preapproved needs a template hash; a member owns only their own; re-arm and template change", async () => {
    const member = await client(w, "member");
    const base = { id: crypto.randomUUID(), workflowId: "0b6c2f1e-9a3d-4c1b-8e7f-1234567890ab", version: 1, mode: "preapproved", recipients: { emails: [], domains: [], repliesToThreadsStartedByIdentity: false }, templateHash: null, maxCommitsPerNight: 1, maxPerRecipientPerWeek: 1, sendWindow: { startHour: 8, endHour: 18, days: [1], recipientTimezone: true }, attachmentsAllowed: false, budgetCentsPerNight: 1, dryRunNights: 3, dryRunNightsDone: 0, circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 2 }, state: "active", trippedReason: null, ownerPersonId: w.t.people.member.id };
    expect((await member.post("/v1/overnight-policies", base)).status).toBe(400);
    expect((await member.post("/v1/overnight-policies", { ...base, templateHash: TPL, ownerPersonId: w.t.people.member2.id })).status).toBe(404);
    expect((await member.post("/v1/overnight-policies", { ...base, templateHash: TPL, dryRunNightsDone: 3 })).status).toBe(400);
    const pid = await overnightPolicy(w, { dryRunNights: 3 });
    expect((await member.patch(`/v1/overnight-policies/${pid}`, { state: "tripped" })).status).toBe(400);
    await w.h.db.migrator`update overnight_policies set state = 'tripped', tripped_reason = 'bounce_rate', dry_run_nights_done = 3 where id = ${pid}`;
    const rearm = await member.patch(`/v1/overnight-policies/${pid}`, { state: "active" });
    expect(rearm.status).toBe(200);
    expect(rearm.json).toMatchObject({ state: "active", trippedReason: null, dryRunNightsDone: 3 });
    const newTpl = await member.patch(`/v1/overnight-policies/${pid}`, { templateHash: "e".repeat(64) });
    expect(newTpl.json).toMatchObject({ templateHash: "e".repeat(64), dryRunNightsDone: 0 });
    expect((await member.patch(`/v1/overnight-policies/${pid}`, { ownerPersonId: w.t.people.member2.id })).status).toBe(400);
    expect((await (await client(w, "member2")).patch(`/v1/overnight-policies/${pid}`, { state: "paused" })).status).toBe(404);
    const list = await (await client(w, "member2")).get("/v1/overnight-policies");
    expect(list.json.items.some((p: { id: string }) => p.id === pid)).toBe(false);
    expect((await (await client(w, "auditor")).get(`/v1/overnight-policies?workflowId=${base.workflowId}`)).json.items.length).toBeGreaterThan(0);
  });
});
