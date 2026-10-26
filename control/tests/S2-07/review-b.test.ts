// S2-07 wave-B review fixes (slices/S2-review/REVIEW-wave-B.md, PR #12): every test here failed before its fix.
// Real broker, real policies module, real Postgres; only the Composio runner is in-memory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTenant } from "../../src/db/tenant.ts";
import brokerModule from "../../src/modules/broker/index.ts";
import { ComposioCliExecutor, type ComposioRunner } from "../../src/modules/broker/executors.ts";
import { itemRef } from "../../src/modules/broker/stage1.ts";
import {
  approveToken,
  client,
  email,
  items,
  overnightPolicy,
  overnightRun,
  propose,
  proposeOk,
  setRolePolicy,
  WF,
  world,
  type World,
} from "./setup.ts";

let w: World;
const DAY = 24 * 3600_000;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
beforeAll(async () => {
  w = await world();
});
afterAll(async () => {
  await w.close();
});

const policyRow = async (id: string) =>
  (await w.h.db.migrator`select state, dry_run_nights_done from overnight_policies where tenant_id = ${w.t.id} and id = ${id}`)[0]!;
/** 20:00 UTC of a day after every night used so far: outside an 08-09 window, on a fresh night. */
const freshEvening = () => {
  w.h.clock.t = Math.ceil((w.h.clock.now() + DAY) / DAY) * DAY + 20 * 3600_000;
};
const narrowWindow = { startHour: 8, endHour: 9, days: ALL_DAYS, recipientTimezone: false };
const only = (addr: string) => ({ emails: [addr], domains: [], repliesToThreadsStartedByIdentity: false });

/** A policy-approved item scheduled into tomorrow's 08:00 window; returns the batch and when the window opens. */
async function scheduledByPolicy(addr: string, over: Record<string, unknown> = {}) {
  freshEvening();
  const pid = await overnightPolicy(w, { sendWindow: narrowWindow, recipients: only(addr), ...over });
  const r = await propose(w, [email(addr)], overnightRun(pid));
  if (!r.ok || r.autoApproved !== 1) throw new Error(`not auto-approved: ${JSON.stringify(r)}`);
  await w.broker.idle();
  const [it] = await items(w, r.batchHash);
  expect(it!.token_id).not.toBeNull();
  return { pid, hash: r.batchHash, at: it!.scheduled_for!.getTime() };
}

describe("S2-07 review B: changing a policy stops what it approved (fix 1)", () => {
  const narrowing: Array<[string, (addr: string) => Record<string, unknown>]> = [
    ["pause", () => ({ state: "paused" })],
    ["allowlist narrowed", () => ({ recipients: only("someone.else@fund.com") })],
    ["window narrowed", () => ({ sendWindow: { ...narrowWindow, days: [1, 2, 3] } })],
    ["night cap lowered", () => ({ maxCommitsPerNight: 1 })],
    ["new template", () => ({ templateHash: "f".repeat(64) })],
    ["drafts only", () => ({ mode: "drafts_only" })],
  ];
  let n = 0;
  for (const [name, patch] of narrowing) {
    test(`OVERNIGHT: ${name}: approved, scheduled items lose their policy approval and the open window sends nothing`, async () => {
      const addr = `narrow${++n}@fund.com`;
      const { pid, hash, at } = await scheduledByPolicy(addr);
      const res = await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, patch(addr));
      expect(res.status).toBe(200);
      expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null, scheduled_for: null });
      const calls = w.composio.calls.length;
      w.h.clock.t = at;
      await w.broker.runDue(w.t.id, hash);
      expect(w.composio.calls.length).toBe(calls);
      expect((await items(w, hash))[0]!.state).toBe("pending");
    });
  }

  test("OVERNIGHT: a widening edit keeps what the policy already approved (it was approved under stricter rules)", async () => {
    const { pid, hash, at } = await scheduledByPolicy("widen.keep@fund.com");
    const res = await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, { maxCommitsPerNight: 20 });
    expect(res.status).toBe(200);
    expect((await items(w, hash))[0]!.token_id).not.toBeNull();
    w.h.clock.t = at;
    await w.broker.runDue(w.t.id, hash);
    expect((await items(w, hash))[0]!.state).toBe("sent");
  });

  test("OVERNIGHT: execute fails closed when the token's policy is not active (paused behind the API's back)", async () => {
    const { pid, hash, at } = await scheduledByPolicy("paused.db@fund.com");
    await w.h.db.migrator`update overnight_policies set state = 'paused' where tenant_id = ${w.t.id} and id = ${pid}`;
    const calls = w.composio.calls.length;
    w.h.clock.t = at;
    await w.broker.runDue(w.t.id, hash);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, hash))[0]).toMatchObject({ state: "pending", token_id: null });
  });
});

describe("S2-07 review B: no address in audit detail or item errors (fix 2)", () => {
  test("AUDIT: a refused recipient's address and domain are in neither the audit row nor the reason; the item ref is", async () => {
    const addr = "lead.person@hidden-domain.example";
    const r = await propose(w, [{ key: addr, capability: "outreach.add_lead", fields: [["to", addr], ["subject", ""], ["body", ""], ["verb", "add_to_campaign"]] }], { connectionId: w.conns.org });
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    const rows = await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action = 'batch.propose_rejected'`;
    const text = JSON.stringify(rows);
    expect(text).not.toContain(addr);
    expect(text).not.toContain("hidden-domain");
    expect(rows.some((e: { detail: Record<string, unknown> }) => e.detail.item === itemRef(WF, addr))).toBe(true);
  });

  test("AUDIT: a held recipient's conflict names no address", async () => {
    const addr = "held@secret-fund.example";
    const a = await proposeOk(w, [email(addr, "First")]);
    const { token } = await approveToken(w, "member", a);
    w.composio.mode = "throw";
    try {
      await w.broker.commitApproved(w.t.id, a, token);
    } finally {
      w.composio.mode = "ok";
    }
    const r = await propose(w, [email(addr, "Second")]);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.ok ? "" : r.message).not.toContain(addr);
    const text = JSON.stringify(await w.h.db.migrator`select detail from audit_events where tenant_id = ${w.t.id} and action = 'batch.propose_rejected'`);
    expect(text).not.toContain("secret-fund");
  });

  test("ITEM: a provider error that quotes the recipient is stored without the address or its domain", async () => {
    const addr = "bounce.me@private-co.example";
    const runner: ComposioRunner = {
      async run() {
        throw new Error(`550 5.1.1 <${addr}>: Recipient address rejected at private-co.example`);
      },
    };
    w.useComposio(new ComposioCliExecutor(runner));
    try {
      const hash = await proposeOk(w, [email(addr)]);
      const { token } = await approveToken(w, "member", hash);
      await w.broker.commitApproved(w.t.id, hash, token);
      const [it] = await items(w, hash);
      expect(it!.state).toBe("unknown");
      expect(it!.error).not.toBeNull();
      expect(it!.error).not.toContain(addr);
      expect(it!.error).not.toContain("private-co");
    } finally {
      w.restore();
    }
  });
});

describe("S2-07 review B: the night's dry-run decision (fix 3, fix 6)", () => {
  test("OVERNIGHT: a signal reported before the night's first batch does not make a dry-run night live", async () => {
    freshEvening();
    const pid = await overnightPolicy(w, { dryRunNights: 3, recipients: only("early@fund.com") });
    expect(await w.broker.reportNightSignals(w.t.id, pid, { costCents: 1 })).toBeNull();
    const r = await propose(w, [email("early@fund.com")], overnightRun(pid));
    expect(r).toMatchObject({ ok: true, autoApproved: 0, overnightEvaluation: { result: "queue", reason: "dry_run_night" } });
    expect((await policyRow(pid)).dry_run_nights_done).toBe(1);
  });

  test("OVERNIGHT: a member sets at least 3 dry-run nights; an owner or admin may set fewer", async () => {
    const id = crypto.randomUUID();
    const body = {
      id, workflowId: WF, version: 1, mode: "preapproved", recipients: only("min@fund.com"), templateHash: "c".repeat(64),
      maxCommitsPerNight: 1, maxPerRecipientPerWeek: 1, sendWindow: narrowWindow, attachmentsAllowed: false,
      budgetCentsPerNight: 1, dryRunNights: 0, dryRunNightsDone: 0,
      circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 2 }, state: "active",
      trippedReason: null, ownerPersonId: w.t.people.member.id,
    };
    const member = await client(w, "member");
    expect((await member.post("/v1/overnight-policies", body)).status).toBe(403);
    expect((await member.post("/v1/overnight-policies", { ...body, dryRunNights: 2 })).status).toBe(403);
    expect((await (await client(w, "lead")).post("/v1/overnight-policies", body)).status).toBe(403);
    expect((await (await client(w, "admin")).post("/v1/overnight-policies", body)).status).toBe(201);
    const mine = await overnightPolicy(w, { dryRunNights: 3 });
    expect((await member.patch(`/v1/overnight-policies/${mine}`, { dryRunNights: 1 })).status).toBe(403);
    expect((await (await client(w, "owner")).patch(`/v1/overnight-policies/${mine}`, { dryRunNights: 1 })).status).toBe(200);
  });

  const widening: Array<[string, Record<string, unknown>]> = [
    ["recipients added", { recipients: { emails: ["w1@fund.com", "w2@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false } }],
    ["domain added", { recipients: { emails: ["w1@fund.com"], domains: ["wide.example"], repliesToThreadsStartedByIdentity: false } }],
    ["thread replies allowed", { recipients: { emails: ["w1@fund.com"], domains: [], repliesToThreadsStartedByIdentity: true } }],
    ["window widened", { sendWindow: { startHour: 7, endHour: 18, days: [1, 2, 3, 4, 5], recipientTimezone: true } }],
    ["window days added", { sendWindow: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5, 6], recipientTimezone: true } }],
    ["night cap raised", { maxCommitsPerNight: 50 }],
    ["weekly cap raised", { maxPerRecipientPerWeek: 3 }],
    ["budget raised", { budgetCentsPerNight: 1500 }],
    ["attachments allowed", { attachmentsAllowed: true }],
    ["mode drafts_only → preapproved", { mode: "preapproved" }],
  ];
  for (const [name, patch] of widening) {
    test(`OVERNIGHT: a trust-widening edit (${name}) starts the dry-run nights again`, async () => {
      const startMode = name.startsWith("mode") ? "drafts_only" : "preapproved";
      const pid = await overnightPolicy(w, {
        dryRunNights: 3, mode: startMode, recipients: only("w1@fund.com"), maxCommitsPerNight: 10, maxPerRecipientPerWeek: 1,
        budgetCentsPerNight: 500, sendWindow: { startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5], recipientTimezone: true },
      });
      await w.h.db.migrator`update overnight_policies set dry_run_nights_done = 3 where tenant_id = ${w.t.id} and id = ${pid}`;
      const res = await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, patch);
      expect(res.status).toBe(200);
      expect(res.json.dryRunNightsDone).toBe(0);
    });
  }

  test("OVERNIGHT: a narrowing-only edit keeps the dry-run nights done", async () => {
    const pid = await overnightPolicy(w, { dryRunNights: 3 });
    await w.h.db.migrator`update overnight_policies set dry_run_nights_done = 3 where tenant_id = ${w.t.id} and id = ${pid}`;
    const res = await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, { maxCommitsPerNight: 2, budgetCentsPerNight: 100 });
    expect(res.json.dryRunNightsDone).toBe(3);
  });

  test("OVERNIGHT: a widening edit mid-night makes the rest of that night a dry run", async () => {
    freshEvening();
    const pid = await overnightPolicy(w, { dryRunNights: 3, recipients: only("mid1@fund.com"), sendWindow: { startHour: 0, endHour: 24, days: ALL_DAYS, recipientTimezone: true } });
    await w.h.db.migrator`update overnight_policies set dry_run_nights_done = 3 where tenant_id = ${w.t.id} and id = ${pid}`;
    expect(await propose(w, [email("mid1@fund.com")], overnightRun(pid))).toMatchObject({ autoApproved: 1 });
    await w.broker.idle();
    const res = await (await client(w, "member")).patch(`/v1/overnight-policies/${pid}`, { recipients: { emails: ["mid1@fund.com", "mid2@fund.com"], domains: [], repliesToThreadsStartedByIdentity: false } });
    expect(res.json.dryRunNightsDone).toBe(0);
    const r = await propose(w, [email("mid2@fund.com")], overnightRun(pid));
    expect(r).toMatchObject({ ok: true, autoApproved: 0, overnightEvaluation: { result: "queue", reason: "dry_run_night" } });
  });

  test("OVERNIGHT: a dry-run night that trips does not count", async () => {
    freshEvening();
    const pid = await overnightPolicy(w, { dryRunNights: 3, recipients: only("trip.night@fund.com") });
    expect(await propose(w, [email("trip.night@fund.com")], overnightRun(pid))).toMatchObject({ overnightEvaluation: { reason: "dry_run_night" } });
    expect((await policyRow(pid)).dry_run_nights_done).toBe(1);
    expect(await w.broker.reportNightSignals(w.t.id, pid, { negativeReplies: 5 })).toBe("negative_reply_spike");
    expect(await policyRow(pid)).toMatchObject({ state: "tripped", dry_run_nights_done: 0 });
  });
});

describe("S2-07 review B: one recipient, one send (fix 4, fix 5)", () => {
  test("ITEM: an unknown item in another batch holds an already-approved item to the same recipient until release", async () => {
    const addr = "twice@fund.com";
    const a = await proposeOk(w, [email(addr, "A")]);
    const b = await proposeOk(w, [email(addr, "B")]);
    const ta = await approveToken(w, "member", a);
    const tb = await approveToken(w, "member", b);
    w.composio.mode = "throw";
    try {
      await w.broker.commitApproved(w.t.id, a, ta.token);
    } finally {
      w.composio.mode = "ok";
    }
    expect((await items(w, a))[0]!.state).toBe("unknown");
    const calls = w.composio.calls.length;
    await w.broker.commitApproved(w.t.id, b, tb.token);
    expect(w.composio.calls.length).toBe(calls);
    expect((await items(w, b))[0]).toMatchObject({ state: "pending" });
    expect((await items(w, b))[0]!.token_id).not.toBeNull();
    // A person releases A: B may go now.
    const res = await (await client(w, "member")).post(`/v1/batches/${a}/release`, { keys: [addr] });
    expect(res.status).toBe(200);
    await w.broker.runDue(w.t.id, b);
    expect((await items(w, b))[0]!.state).toBe("sent");
    expect(w.composio.calls.length).toBe(calls + 1);
  });

  test("ITEM: two items whose recipients normalise to the same address are refused", async () => {
    for (const pair of [["dup@fund.com", " dup@fund.com"], ["josé@fund.com", "josé@fund.com"], ["Dup2@Fund.com", "dup2@fund.com "]]) {
      const r = await propose(w, pair.map((x) => email(x)));
      expect(r).toMatchObject({ ok: false, code: "validation_failed" });
    }
  });
});

describe("S2-07 review B: scheduler job (fix 7)", () => {
  test("ITEM: the broker module's job reconciles stale sends and runs due items for the tenant it is given", async () => {
    const job = brokerModule.jobs?.find((j) => j.name === "broker.commit_due");
    expect(job).toBeDefined();
    const { hash, at } = await scheduledByPolicy("job.due@fund.com");
    w.h.clock.t = at;
    await (job!.run as (d: typeof w.h.deps, t?: string) => Promise<void>)(w.h.deps, w.t.id);
    expect((await items(w, hash))[0]!.state).toBe("sent");
    // A send that never answered becomes unknown.
    w.composio.mode = "hang";
    const h2 = await proposeOk(w, [email("job.hang@fund.com")]);
    const { token } = await approveToken(w, "member", h2);
    void w.broker.commitApproved(w.t.id, h2, token).catch(() => undefined);
    for (let i = 0; i < 50 && (await items(w, h2))[0]!.state !== "sending"; i++) await Bun.sleep(10);
    w.composio.mode = "ok";
    w.h.clock.advance(11 * 60_000);
    await (job!.run as (d: typeof w.h.deps, t?: string) => Promise<void>)(w.h.deps, w.t.id);
    expect((await items(w, h2))[0]!.state).toBe("unknown");
    await expect(job!.run(w.h.deps)).rejects.toThrow(/tenant/);
  });
});

describe("S2-07 review B: who sees recipients (ranked 29)", () => {
  test("RBAC: under approvers = dept_lead the runner sees the batch without fields, as the list does", async () => {
    await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, { approvers: "dept_lead" });
    try {
      const addr = "lead.only@fund.com";
      const hash = await proposeOk(w, [email(addr)]);
      const g = await (await client(w, "member")).get(`/v1/batches/${hash}`);
      expect(g.status).toBe(200);
      expect(g.json.items[0].fields).toEqual([]);
      expect(g.json.items[0].key).toBe(itemRef(WF, addr));
      const list = await (await client(w, "member")).get("/v1/batches?limit=200");
      expect((list.json.items as Array<{ batchHash: string }>).some((b) => b.batchHash === hash)).toBe(false);
      const lead = await (await client(w, "lead")).get(`/v1/batches/${hash}`);
      expect(lead.json.items[0].fields.length).toBeGreaterThan(0);
    } finally {
      await setRolePolicy(w.h, w.t, w.t.jobRoles.sdr, {});
    }
  });

  test("RBAC: allowlist emails are shown to the policy's owner only; others get content-free refs", async () => {
    const pid = await overnightPolicy(w, { dryRunNights: 3, recipients: { emails: ["private.allow@fund.com"], domains: ["fund.com"], repliesToThreadsStartedByIdentity: false } });
    const find = async (who: Parameters<typeof client>[1]) =>
      ((await (await client(w, who)).get("/v1/overnight-policies?limit=200")).json.items as Array<{ id: string; recipients: { emails: string[] } }>).find((p) => p.id === pid);
    expect((await find("member"))!.recipients.emails).toEqual(["private.allow@fund.com"]);
    for (const who of ["admin", "auditor", "lead", "owner"] as const) {
      const p = await find(who);
      expect(p).toBeDefined();
      expect(JSON.stringify(p)).not.toContain("private.allow");
      expect(p!.recipients.emails).toHaveLength(1);
    }
    const patched = await (await client(w, "lead")).patch(`/v1/overnight-policies/${pid}`, { maxCommitsPerNight: 2 });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.json)).not.toContain("private.allow");
    // The lead's edit of something else leaves the owner's allowlist as it was.
    expect((await find("member"))!.recipients.emails).toEqual(["private.allow@fund.com"]);
  });
});

describe("S2-07 review B: database immutability (ranked 30)", () => {
  const asApp = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(w.h.db.app, { tenantId: w.t.id, accessRole: "system" }, fn);

  test("ITEM: offload_app cannot change an item's fields, hash or recipient, nor move a finished item", async () => {
    const hash = await proposeOk(w, [email("immut@fund.com")]);
    await expect(asApp((tx) => tx`update batch_items set fields = ${[["to", "evil@x.com"], ["subject", "s"], ["body", "b"]]}::jsonb where batch_hash = ${hash}`)).rejects.toThrow(/immutable/);
    await expect(asApp((tx) => tx`update batch_items set item_hash = ${"0".repeat(64)} where batch_hash = ${hash}`)).rejects.toThrow(/immutable/);
    await expect(asApp((tx) => tx`update batch_items set recipient = 'evil@x.com' where batch_hash = ${hash}`)).rejects.toThrow(/immutable/);
    const { token } = await approveToken(w, "member", hash);
    await w.broker.commitApproved(w.t.id, hash, token);
    expect((await items(w, hash))[0]!.state).toBe("sent");
    await expect(asApp((tx) => tx`update batch_items set state = 'pending' where batch_hash = ${hash}`)).rejects.toThrow(/immutable/);
  });

  test("TOKEN: offload_app cannot un-use, un-revoke or re-target a token", async () => {
    const hash = await proposeOk(w, [email("immut.tok@fund.com")]);
    const { token } = await approveToken(w, "member", hash);
    await w.broker.commitApproved(w.t.id, hash, token);
    await expect(asApp((tx) => tx`update approval_tokens set used_at = null where batch_hash = ${hash}`)).rejects.toThrow(/immutable/);
    await expect(asApp((tx) => tx`update approval_tokens set item_keys = '[]'::jsonb where batch_hash = ${hash}`)).rejects.toThrow(/immutable/);
    const h2 = await proposeOk(w, [email("immut.rev@fund.com")]);
    await approveToken(w, "member", h2);
    await (await client(w, "member")).post(`/v1/batches/${h2}/reject`, { reason: "no" });
    await expect(asApp((tx) => tx`update approval_tokens set revoked_at = null where batch_hash = ${h2}`)).rejects.toThrow(/immutable/);
  });
});
