import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHarness, T0, type Harness } from "../helpers/harness.ts";
import { allowsAt, deviceConsent, SYNC_KINDS } from "../../src/modules/compliance/consent.ts";
import { isEnabled } from "../../src/modules/compliance/features.ts";
import { DAY_MS, enableBody, publishNotice, signIn, sys, type Who } from "./fixtures.ts";

const HOUR = 3_600_000;
let h: Harness;
let who: Who;
let noticeId: string;
let wtEffective: number;

// State, built once with the clock at known instants:
//   T0        notice N (workflow_metrics, per_person_views, working_time; all jurisdictions) published
//   T0+1h     member (CA-ON), member2 (US-NY), lead (GB), auditor (ZZ), admin (CA-QC) acknowledge N; owner does not
//   T0+2h     working_time enabled for CA-ON + US-NY, 1-day period; per_person_views for CA-QC, no period
beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  const set = (k: keyof Who, j: string) => h.db.migrator`update people set jurisdiction = ${j} where id = ${who[k].personId}`;
  await set("member2", "US-NY");
  await set("lead", "GB");
  await set("auditor", "ZZ");
  await set("admin", "CA-QC");
  noticeId = (await publishNotice(who.owner, { features: ["workflow_metrics", "per_person_views", "working_time"] })).id;
  h.clock.advance(HOUR);
  for (const k of ["member", "member2", "lead", "auditor", "admin"] as const) {
    const r = await who[k].post(`/v1/me/notices/${noticeId}/ack`);
    if (r.status !== 201) throw new Error(`ack ${k} ${r.status}`);
  }
  h.clock.advance(HOUR);
  const wt = await who.owner.post(
    "/v1/compliance/features/working_time/enable",
    enableBody("working_time", noticeId, { jurisdictions: ["CA-ON", "US-NY"], noticePeriodDays: 1 }),
  );
  wtEffective = wt.json.effectiveAt;
  await who.owner.post(
    "/v1/compliance/features/per_person_views/enable",
    enableBody("per_person_views", noticeId, { jurisdictions: ["CA-QC"], noticePeriodDays: 0, quebecActivationAck: true }),
  );
});
afterAll(() => h.close());

type K = keyof Who;
const ACKED = T0 + HOUR;
const ENABLED = T0 + 2 * HOUR;
const EFFECTIVE = ENABLED + DAY_MS;

describe("CONSENT", () => {
  const consentTable: Array<[string, K, string, number, boolean]> = [
    ["no ack: the acknowledgement itself may always be sent", "owner", "notice_ack", EFFECTIVE, true],
    ["no ack: G1 blocks run outcomes", "owner", "run_outcome", EFFECTIVE, false],
    ["no ack: G1 blocks daily aggregates", "owner", "daily_aggregate", EFFECTIVE, false],
    ["no ack: G1 blocks proposals", "owner", "workflow_proposal", EFFECTIVE, false],
    ["forward-only: before the ack instant nothing but the ack", "member", "run_outcome", ACKED - 1, false],
    ["forward-only: from the ack instant on", "member", "run_outcome", ACKED, true],
    ["acked CA-ON: daily aggregates", "member", "daily_aggregate", ACKED, true],
    ["acked CA-ON: review events", "member", "review_event", ACKED, true],
    ["acked CA-ON: baseline samples", "member", "baseline_sample", ACKED, true],
    ["acked CA-ON: proposals (G4 is the client's preview)", "member", "workflow_proposal", ACKED, true],
    ["G2 CA-ON: working time off before enablement", "member", "working_time_aggregate", ACKED, false],
    ["G2 CA-ON: working time off during the notice period", "member", "working_time_aggregate", EFFECTIVE - 1, false],
    ["G2 CA-ON: working time on at effectiveAt", "member", "working_time_aggregate", EFFECTIVE, true],
    ["G2 US-NY: working time on at effectiveAt", "member2", "working_time_aggregate", EFFECTIVE, true],
    ["G2 GB: not enabled for GB", "lead", "working_time_aggregate", EFFECTIVE, false],
    ["G1 GB: aggregates flow after ack", "lead", "daily_aggregate", EFFECTIVE, true],
    ["unknown jurisdiction ZZ: most restrictive, no working time", "auditor", "working_time_aggregate", EFFECTIVE, false],
    ["CA-QC: per-person views do not open working time", "admin", "working_time_aggregate", EFFECTIVE, false],
    ["not a sync kind: refused", "member", "screenshot", EFFECTIVE, false],
    ["not a sync kind: raw events refused", "member", "raw_event", EFFECTIVE, false],
  ];
  test.each(consentTable)("CONSENT: %s", async (_name, k, kind, at, expected) => {
    expect(await sys(h, (tx) => allowsAt(tx, who[k].personId, kind, at))).toBe(expected);
  });

  const featureTable: Array<[string, "per_person_views" | "working_time", string, number, boolean]> = [
    ["working_time CA-ON after the period", "working_time", "CA-ON", EFFECTIVE, true],
    ["working_time CA-ON in the period", "working_time", "CA-ON", EFFECTIVE - 1, false],
    ["working_time US-NY after the period", "working_time", "US-NY", EFFECTIVE, true],
    ["working_time GB (never enabled)", "working_time", "GB", EFFECTIVE, false],
    ["working_time ZZ (unknown = off)", "working_time", "ZZ", EFFECTIVE, false],
    ["per_person_views CA-QC immediately", "per_person_views", "CA-QC", ENABLED, true],
    ["per_person_views CA-QC before the enablement", "per_person_views", "CA-QC", ENABLED - 1, false],
    ["per_person_views CA-ON (not enabled)", "per_person_views", "CA-ON", EFFECTIVE, false],
  ];
  test.each(featureTable)("CONSENT: FeaturePort %s", async (_n, f, j, at, expected) => {
    expect(await sys(h, (tx) => isEnabled(tx, f, j, at))).toBe(expected);
  });

  test("CONSENT: the ConsentPort and FeaturePort provided to the app are this module's (clock = now)", async () => {
    h.clock.t = EFFECTIVE;
    const p = h.deps.ports;
    await sys(h, async (tx) => {
      expect(await p.consent.allows(tx, who.member.personId, "working_time_aggregate")).toBe(true);
      expect(await p.consent.allows(tx, who.owner.personId, "run_outcome")).toBe(false);
      expect([...(await p.features.enabledFor(tx, "CA-ON"))]).toEqual(["working_time"]);
      expect([...(await p.features.enabledFor(tx, "CA-QC"))]).toEqual(["per_person_views"]);
    });
  });

  test("CONSENT: device consent lists the required notice, the allowed kinds and when working time starts", async () => {
    const cfg = await sys(h, (tx) => deviceConsent(tx, who.member.personId, EFFECTIVE));
    expect(cfg.requiredNotice).toMatchObject({ noticeVersionId: noticeId, features: ["workflow_metrics", "per_person_views", "working_time"] });
    expect([...cfg.allowedKinds].sort()).toEqual([...SYNC_KINDS].sort());
    expect(cfg.features).toEqual({ workflow_metrics: true, per_person_views: false, working_time: true });
    // Working time starts at the later of the ack and effectiveAt (ADR 0111 §3: forward only).
    expect(cfg.workingTimeStartsAt).toBe(wtEffective);
    const owner = await sys(h, (tx) => deviceConsent(tx, who.owner.personId, EFFECTIVE));
    expect(owner.requiredNotice?.noticeVersionId).toBe(noticeId);
    expect(owner.allowedKinds).toEqual(["notice_ack"]);
  });

  test("CONSENT: a tenant with no published notice may send nothing but the acknowledgement (fail closed)", async () => {
    const b = h.b.people.member.id;
    const cfg = await sys(h, (tx) => deviceConsent(tx, b, h.clock.now()), h.b);
    expect(cfg.requiredNotice).toBeNull();
    expect(cfg.allowedKinds).toEqual(["notice_ack"]);
    for (const kind of SYNC_KINDS) {
      expect(await sys(h, (tx) => allowsAt(tx, b, kind, h.clock.now()), h.b)).toBe(kind === "notice_ack");
    }
  });

  test("CONSENT: a frozen or departed person may send nothing but the acknowledgement", async () => {
    await h.db.migrator`update people set state = 'frozen' where id = ${who.member.personId}`;
    expect(await sys(h, (tx) => allowsAt(tx, who.member.personId, "run_outcome", EFFECTIVE))).toBe(false);
    await h.db.migrator`update people set state = 'active' where id = ${who.member.personId}`;
    expect(await sys(h, (tx) => allowsAt(tx, who.member.personId, "run_outcome", EFFECTIVE))).toBe(true);
  });

  test("CONSENT: an unknown person is refused everything but the acknowledgement", async () => {
    expect(await sys(h, (tx) => allowsAt(tx, crypto.randomUUID(), "run_outcome", EFFECTIVE))).toBe(false);
  });

  test("CONSENT: working time needs an ack of a notice that lists it, not only the feature", async () => {
    // A newer notice for US-NY without working_time; member2 acks it. G1 holds, G2 does not via that notice alone,
    // but member2 still holds the earlier ack that listed working_time.
    h.clock.t = EFFECTIVE + HOUR;
    const ny = await publishNotice(who.owner, { template: "ny-notice-and-ack", features: ["workflow_metrics"], jurisdictions: ["US-NY"] });
    const at = h.clock.now();
    expect(await sys(h, (tx) => allowsAt(tx, who.member2.personId, "working_time_aggregate", at))).toBe(true);
    expect(await sys(h, (tx) => allowsAt(tx, who.member2.personId, "run_outcome", at))).toBe(true);
    // A brand new US-NY person who only acked the thin notice: G1 yes, G2 no.
    const [p] = await h.db.migrator`insert into people (tenant_id, email, display_name, jurisdiction, source)
      values (${h.a.id}, 'ny2@acme.example.com', 'ny2', 'US-NY', 'manual') returning id`;
    const ny2 = p!.id as string;
    await sys(h, (tx) => tx`insert into notice_acks (tenant_id, id, person_id, notice_id, acknowledged_at_ms, created_at_ms, jurisdiction, features, channel)
      values (${h.a.id}, '01JAAAAAAAAAAAAAAAAAAAAAAA', ${ny2}, ${ny.id}, ${at}, ${at}, 'US-NY', '["workflow_metrics"]'::jsonb, 'web')`);
    expect(await sys(h, (tx) => allowsAt(tx, ny2, "run_outcome", at))).toBe(true);
    expect(await sys(h, (tx) => allowsAt(tx, ny2, "working_time_aggregate", at))).toBe(false);
  });

  test("CONSENT: disabling working time stops it at once, for every jurisdiction in the enablement", async () => {
    h.clock.t = EFFECTIVE + 2 * HOUR;
    await who.admin.post("/v1/compliance/features/working_time/disable");
    const now = h.clock.now();
    expect(await sys(h, (tx) => allowsAt(tx, who.member.personId, "working_time_aggregate", now))).toBe(false);
    expect(await sys(h, (tx) => allowsAt(tx, who.member2.personId, "working_time_aggregate", now))).toBe(false);
    // History stays answerable: it was on just before.
    expect(await sys(h, (tx) => allowsAt(tx, who.member.personId, "working_time_aggregate", now - 1))).toBe(true);
  });
});
