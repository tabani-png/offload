// CONSENT: before the ack only notice_ack leaves; working_time only when enabled + acked + past the notice period;
// working_time turned off -> queued working_time objects are dropped; sharing a workflow needs a confirm.
import { afterEach, describe, expect, test } from "bun:test";
import { decide, noticeSatisfied, workingTimeAllowed, type ConsentState } from "../../src/sync/consent.ts";
import { Outbox } from "../../src/sync/outbox.ts";
import { SYNC_KINDS, type SyncKind } from "../../src/sync/types.ts";
import { defaultConfig, NOTICE_1, NOTICE_WT } from "./fake-control.ts";
import { connect, fixtureSyncWorld, NOW, type FixtureSyncWorld } from "./setup.ts";

const DAY_MS = 86_400_000;
const acked = [{ noticeVersionId: NOTICE_1, acknowledgedAt: NOW - DAY_MS, features: ["workflow_metrics" as const] }];
const wtAck = { noticeVersionId: NOTICE_WT, acknowledgedAt: NOW - 20 * DAY_MS, features: ["workflow_metrics" as const, "working_time" as const] };
const state = (over: Partial<ConsentState> = {}): ConsentState => ({ config: defaultConfig(), acks: acked, paused: false, now: NOW, ...over });
const wtConfig = (over = {}) => defaultConfig({ requiredNotice: null, features: { workflow_metrics: true, per_person_views: false, working_time: true }, workingTimeStartsAt: NOW - DAY_MS, ...over });

describe("the gate", () => {
  test("CONSENT: unknown config sends nothing but notice_ack", () => {
    const s = state({ config: null });
    for (const k of SYNC_KINDS) expect(decide(k, s, { confirmed: true })).toBe(k === "notice_ack" ? "send" : "hold");
  });

  test("CONSENT: before the required notice is acknowledged, only notice_ack may leave (G1)", () => {
    const s = state({ acks: [] });
    expect(noticeSatisfied(s)).toBe(false);
    for (const k of SYNC_KINDS) expect(decide(k, s, { confirmed: true })).toBe(k === "notice_ack" ? "send" : k === "working_time_aggregate" ? "drop" : "hold");
    expect(noticeSatisfied(state())).toBe(true);
    expect(decide("run_outcome", state())).toBe("send");
    expect(decide("daily_aggregate", state())).toBe("send");
  });

  test("CONSENT: working_time needs the feature on, an acked notice listing it, and now >= workingTimeStartsAt (G2)", () => {
    const ok = state({ config: wtConfig(), acks: [wtAck] });
    expect(workingTimeAllowed(ok)).toBe(true);
    expect(decide("working_time_aggregate", ok)).toBe("send");
    // Acked a notice that does not list working_time.
    expect(decide("working_time_aggregate", state({ config: wtConfig(), acks: acked }))).toBe("hold");
    // Still inside the notice period.
    expect(decide("working_time_aggregate", state({ config: wtConfig({ workingTimeStartsAt: NOW + 1 }), acks: [wtAck] }))).toBe("hold");
    expect(decide("working_time_aggregate", state({ config: wtConfig({ workingTimeStartsAt: null }), acks: [wtAck] }))).toBe("hold");
    // Not in allowedKinds for this person.
    expect(decide("working_time_aggregate", state({ config: wtConfig({ allowedKinds: ["notice_ack", "run_outcome"] }), acks: [wtAck] }))).toBe("hold");
  });

  test("CONSENT: working_time turned off in the config drops queued working-time objects", () => {
    expect(decide("working_time_aggregate", state({ config: wtConfig({ features: { workflow_metrics: true, per_person_views: false, working_time: false } }), acks: [wtAck] }))).toBe("drop");
  });

  test("CONSENT: a proposal without the user's confirm on its preview never leaves (G4)", () => {
    expect(decide("workflow_proposal", state())).toBe("drop");
    expect(decide("workflow_proposal", state(), { confirmed: true })).toBe("send");
  });

  test("CONSENT: pause holds everything, including the ack; queueing still works while paused (G5)", () => {
    const s = state({ paused: true });
    for (const k of SYNC_KINDS) expect(decide(k, s, { confirmed: true })).toBe(k === "working_time_aggregate" ? "drop" : "hold");
    expect(decide("run_outcome", s, { forQueue: true })).toBe("send");
  });

  test("CONSENT: a kill switch or a kind outside allowedKinds holds everything but the ack", () => {
    const kill = state({ config: defaultConfig({ killSwitch: true }) });
    for (const k of SYNC_KINDS) if (k !== "working_time_aggregate") expect(decide(k, kill, { confirmed: true })).toBe(k === "notice_ack" ? "send" : "hold");
    const narrow = state({ config: defaultConfig({ allowedKinds: ["notice_ack", "daily_aggregate"] }) });
    const sends = SYNC_KINDS.filter((k: SyncKind) => decide(k, narrow, { confirmed: true }) === "send");
    expect(sends).toEqual(["notice_ack", "daily_aggregate"]);
  });
});

describe("end to end against the fake control plane", () => {
  let w: FixtureSyncWorld;
  afterEach(() => w.cleanup());

  test("CONSENT: before the ack nothing but notice_ack leaves the Mac, even with runs waiting", async () => {
    w = await fixtureSyncWorld();
    await connect(w);
    const r0 = await w.client.flush({ force: true });
    expect(r0.envelopes).toBe(0);
    expect(new Outbox(w.home).list(NOW)).toEqual([]); // nothing was even projected
    await w.client.acknowledgeNotice(NOTICE_1);
    // The ack is queued; a restart before the next flush must not change what goes first.
    w.restart({ analysis: async () => w.fixture.analysis });
    const r1 = await w.client.flush({ force: true });
    const kinds = w.control.received.flatMap((r) => r.envelope.objects.map((o) => o.kind));
    expect(kinds[0]).toBe("notice_ack");
    expect(r1.rejected).toBe(0);
    // Everything after the ack was accepted by the server's own G1 re-check too.
    expect(w.control.acceptedObjects().map((o) => o.kind)).toEqual(kinds);
    expect(new Set(kinds)).toEqual(new Set(["notice_ack", "run_outcome", "baseline_sample", "daily_aggregate"]));
  });

  test("CONSENT: working-time aggregates go only when enabled, acked and past the notice period, and never for earlier days", async () => {
    w = await fixtureSyncWorld();
    w.control.config = wtConfig({ requiredNotice: { noticeVersionId: NOTICE_WT, title: "Working time", markdown: "m", features: ["workflow_metrics", "working_time"] }, workingTimeStartsAt: new Date(2026, 9, 15).getTime() });
    await connect(w);
    await w.client.flush({ force: true });
    expect(w.control.received).toHaveLength(0);
    await w.client.refreshConfig();
    await w.client.acknowledgeNotice(NOTICE_WT);
    await w.client.flush({ force: true });
    const wt = w.control.acceptedObjects().filter((o) => o.kind === "working_time_aggregate");
    expect(wt.length).toBeGreaterThan(0);
    for (const o of wt) {
      expect(o.kind === "working_time_aggregate" && o.day >= "2026-10-15" && o.day < "2026-10-19" && o.noticeVersionId === NOTICE_WT).toBe(true);
    }
  });

  test("CONSENT: working time inside the notice period is not sent", async () => {
    w = await fixtureSyncWorld();
    w.control.config = wtConfig({ requiredNotice: { noticeVersionId: NOTICE_WT, title: "Working time", markdown: "m", features: ["working_time"] }, workingTimeStartsAt: NOW + 14 * DAY_MS });
    await connect(w);
    await w.client.refreshConfig();
    await w.client.acknowledgeNotice(NOTICE_WT);
    await w.client.flush({ force: true });
    expect(w.control.acceptedObjects().some((o) => o.kind === "working_time_aggregate")).toBe(false);
    expect(w.control.acceptedObjects().some((o) => o.kind === "daily_aggregate")).toBe(true);
  });

  test("CONSENT: working_time turned off while objects are queued: they are dropped, not sent", async () => {
    w = await fixtureSyncWorld();
    w.control.config = wtConfig({ requiredNotice: { noticeVersionId: NOTICE_WT, title: "Working time", markdown: "m", features: ["working_time"] }, workingTimeStartsAt: new Date(2026, 9, 12).getTime() });
    await connect(w);
    await w.client.refreshConfig();
    await w.client.acknowledgeNotice(NOTICE_WT);
    w.client.setPaused(true);
    await w.client.flush({ force: true });
    const queued = new Outbox(w.home).list(NOW).filter((e) => e.kind === "working_time_aggregate").length;
    expect(queued).toBeGreaterThan(0);
    w.control.config = { ...w.control.config, features: { ...w.control.config.features, working_time: false } };
    w.client.setPaused(false);
    const r = await w.client.flush({ force: true });
    expect(r.dropped).toBe(queued);
    expect(w.control.received.flatMap((x) => x.envelope.objects).some((o) => o.kind === "working_time_aggregate")).toBe(false);
    expect(new Outbox(w.home).list(NOW).some((e) => e.kind === "working_time_aggregate")).toBe(false);
  });

  test("CONSENT: share previews without queueing; only the confirm queues the exact previewed proposal", async () => {
    w = await fixtureSyncWorld();
    await connect(w);
    await w.client.refreshConfig();
    await w.client.acknowledgeNotice(NOTICE_1);
    await w.client.flush({ force: true });
    const preview = w.client.proposal(w.fixture.outreach.id);
    await w.client.flush({ force: true });
    expect(w.control.received.flatMap((r) => r.envelope.objects).some((o) => o.kind === "workflow_proposal")).toBe(false);
    expect(() => w.client.share(w.fixture.outreach.id, "0".repeat(64))).toThrow();
    w.client.share(w.fixture.outreach.id, preview.definitionHash);
    await w.client.flush({ force: true });
    const sent = w.control.acceptedObjects().filter((o) => o.kind === "workflow_proposal");
    expect(sent).toEqual([preview]);
  });
});
