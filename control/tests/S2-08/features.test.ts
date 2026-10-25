import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "../helpers/harness.ts";
import { enabledFor, isEnabled } from "../../src/modules/compliance/features.ts";
import { deviceConsent } from "../../src/modules/compliance/consent.ts";
import { DAY_MS, enableBody, publishNotice, signIn, sys, type Who } from "./fixtures.ts";

let h: Harness;
let who: Who;
let ppvNotice: string; // lists workflow_metrics + per_person_views + working_time, all jurisdictions

beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  // member2 works in GB; everyone else in CA-ON (seed).
  await h.db.migrator`update people set jurisdiction = 'GB' where id = ${h.a.people.member2.id}`;
  ppvNotice = (await publishNotice(who.owner, { features: ["workflow_metrics", "per_person_views", "working_time"] })).id;
});
afterAll(() => h.close());

async function disableAll() {
  for (const f of ["per_person_views", "working_time"]) await who.owner.post(`/v1/compliance/features/${f}/disable`);
}
afterEach(disableAll);

const enable = (body: Record<string, unknown>, feature = (body.feature as string) ?? "per_person_views") =>
  who.owner.post(`/v1/compliance/features/${feature}/enable`, body);

describe("FEATURE", () => {
  test("FEATURE: the owner enables a sensitive feature with a full attestation (201, schema-valid, audited)", async () => {
    const r = await enable(enableBody("per_person_views", ppvNotice));
    expect(r.status).toBe(201);
    expect(h.deps.validator.validate("offload/stage2/feature-enablement.schema.json", r.json)).toEqual({ ok: true });
    expect(r.json.enabledBy).toBe(h.a.people.owner.id);
    expect(r.json.enabledAt).toBe(h.clock.now());
    expect(r.json.effectiveAt).toBe(h.clock.now() + 14 * DAY_MS);
    expect(r.json.disabledAt).toBeNull();
    const log = await who.owner.get("/v1/audit-log?action=feature.enable");
    expect(log.json.items.at(-1).detail).toMatchObject({ feature: "per_person_views", jurisdictions: ["CA-ON"], noticePeriodDays: 14 });
  });

  test.each(["admin", "lead", "member", "auditor"] as const)("FEATURE: %s may not enable (owner only, 403)", async (k) => {
    const r = await who[k].post("/v1/compliance/features/per_person_views/enable", enableBody("per_person_views", ppvNotice));
    expect(r.status).toBe(403);
    expect((await sys(h, (tx) => isEnabled(tx, "per_person_views", "CA-ON", h.clock.now() + 365 * DAY_MS)))).toBe(false);
  });

  test.each(["completedOn", "documentHash", "documentName", "signerName", "signerTitle"])(
    "FEATURE: a DPIA attestation without %s is 400",
    async (field) => {
      const body = enableBody("per_person_views", ppvNotice);
      const att = { ...body.dpiaAttestation } as Record<string, unknown>;
      delete att[field];
      const r = await enable({ ...body, dpiaAttestation: att });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("validation_failed");
    },
  );

  test.each(["legalBasis", "dpiaAttestation", "jurisdictions", "noticeVersionId", "noticePeriodDays", "quebecActivationAck", "purposeLock", "worksAgreementRef"])(
    "FEATURE: an enablement without %s is 400",
    async (field) => {
      const body = enableBody("per_person_views", ppvNotice) as Record<string, unknown>;
      delete body[field];
      expect((await enable(body, "per_person_views")).status).toBe(400);
    },
  );

  test("FEATURE: an empty jurisdiction list, the unknown jurisdiction ZZ or a duplicate is 400", async () => {
    expect((await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: [] }))).status).toBe(400);
    expect((await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: ["ZZ"] }))).status).toBe(400);
    expect((await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: ["GB", "GB"] }))).status).toBe(400);
  });

  test("FEATURE: DE without a works agreement is 400", async () => {
    const r = await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: ["DE"], legalBasis: "works_agreement" }));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("works agreement");
  });

  test("FEATURE: DE needs the works agreement to allow the view; with it the enablement is accepted", async () => {
    const ref = (allowedViews: string[]) => ({ documentHash: "b".repeat(64), documentName: "betriebsvereinbarung.pdf", allowedViews });
    const de = (views: string[]) =>
      enableBody("per_person_views", ppvNotice, { jurisdictions: ["DE"], legalBasis: "works_agreement", worksAgreementRef: ref(views) });
    expect((await enable(de(["workflow_metrics"]))).status).toBe(400);
    const ok = await enable(de(["workflow_metrics", "per_person_views"]));
    expect(ok.status).toBe(201);
    expect(ok.json.worksAgreementRef.allowedViews).toContain("per_person_views");
  });

  test("FEATURE: CA-QC without the s.8.1 activation acknowledgement is 400; with it, 201", async () => {
    const r = await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: ["CA-QC"] }));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("quebecActivationAck");
    expect((await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: ["CA-QC"], quebecActivationAck: true }))).status).toBe(201);
  });

  test.each(["US-NY", "US-DE", "US-CT"])("FEATURE: %s needs a notice period of at least 1 day", async (j) => {
    const zero = await enable(enableBody("working_time", ppvNotice, { jurisdictions: [j], noticePeriodDays: 0 }));
    expect(zero.status).toBe(400);
    expect(zero.json.error.message).toContain("noticePeriodDays");
    expect((await enable(enableBody("working_time", ppvNotice, { jurisdictions: [j], noticePeriodDays: 1 }))).status).toBe(201);
  });

  test("FEATURE: the notice must be published, current and list the feature", async () => {
    const thin = (await publishNotice(who.owner, { features: ["workflow_metrics"], jurisdictions: ["US-CA"] })).id;
    const r = await enable(enableBody("per_person_views", thin, { jurisdictions: ["US-CA"] }));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("does not list per_person_views");
    const draft = await who.owner.post("/v1/compliance/notices", {
      template: "ca-notice-at-collection", title: "Draft", markdown: "draft", features: ["per_person_views"], jurisdictions: [],
    });
    expect((await enable(enableBody("per_person_views", draft.json.id))).status).toBe(400);
    expect((await enable(enableBody("per_person_views", crypto.randomUUID()))).status).toBe(400);
  });

  test("FEATURE: a notice limited to other jurisdictions cannot cover the enablement", async () => {
    const gbOnly = (await publishNotice(who.owner, { features: ["per_person_views"], jurisdictions: ["GB"] })).id;
    expect((await enable(enableBody("per_person_views", gbOnly, { jurisdictions: ["CA-BC"] }))).status).toBe(400);
    expect((await enable(enableBody("per_person_views", gbOnly, { jurisdictions: ["GB"] }))).status).toBe(201);
  });

  test("FEATURE: workflow_metrics is always on and cannot be enabled; an unknown feature is 404", async () => {
    expect((await who.owner.post("/v1/compliance/features/workflow_metrics/enable", { feature: "workflow_metrics" })).status).toBe(400);
    expect((await who.owner.post("/v1/compliance/features/keystrokes/enable", {})).status).toBe(404);
  });

  test("FEATURE: the body feature must match the path; purposeLock is fixed; server fields are refused", async () => {
    expect((await enable(enableBody("working_time", ppvNotice), "per_person_views")).status).toBe(400);
    expect((await enable(enableBody("per_person_views", ppvNotice, { purposeLock: "performance_review" }))).status).toBe(400);
    expect((await enable(enableBody("per_person_views", ppvNotice, { enabledBy: h.a.people.member.id }))).status).toBe(400);
  });

  test("FEATURE: a DPIA dated in the future is 400", async () => {
    const body = enableBody("per_person_views", ppvNotice);
    const r = await enable({ ...body, dpiaAttestation: { ...body.dpiaAttestation, completedOn: "2099-01-01" } });
    expect(r.status).toBe(400);
  });

  test("FEATURE: legal basis works_agreement without a works agreement is 400", async () => {
    expect((await enable(enableBody("per_person_views", ppvNotice, { legalBasis: "works_agreement" }))).status).toBe(400);
  });

  test("FEATURE: a second active enablement for the same feature and jurisdiction is 409", async () => {
    expect((await enable(enableBody("per_person_views", ppvNotice))).status).toBe(201);
    const again = await enable(enableBody("per_person_views", ppvNotice, { jurisdictions: ["GB", "CA-ON"] }));
    expect(again.status).toBe(409);
  });

  test("FEATURE: every role can list enablements (history included); tenants are isolated", async () => {
    await enable(enableBody("per_person_views", ppvNotice));
    for (const k of ["owner", "admin", "lead", "member", "auditor"] as const) {
      const r = await who[k].get("/v1/compliance/features");
      expect(r.status).toBe(200);
      expect(r.json.items.length).toBeGreaterThan(0);
    }
    const ownerB = (await signIn(h, h.b)).owner;
    expect((await ownerB.get("/v1/compliance/features")).json.items).toEqual([]);
  });
});

describe("PERIOD", () => {
  test("PERIOD: a feature is not visible in the device config until effectiveAt", async () => {
    const r = await enable(enableBody("working_time", ppvNotice, { noticePeriodDays: 3 }));
    const memberId = h.a.people.member.id;
    const cfg = () => sys(h, (tx) => deviceConsent(tx, memberId, h.clock.now()));
    expect((await cfg()).features.working_time).toBe(false);
    expect([...(await sys(h, (tx) => h.deps.ports.features.enabledFor(tx, "CA-ON")))]).toEqual([]);
    h.clock.advance(3 * DAY_MS - 1);
    expect((await cfg()).features.working_time).toBe(false);
    h.clock.advance(1);
    expect(h.clock.now()).toBe(r.json.effectiveAt);
    expect((await cfg()).features.working_time).toBe(true);
    expect([...(await sys(h, (tx) => h.deps.ports.features.enabledFor(tx, "CA-ON")))]).toEqual(["working_time"]);
  });

  test("PERIOD: isEnabled answers for any instant: before, at and after effectiveAt", async () => {
    const r = await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 7 }));
    const at = (t: number) => sys(h, (tx) => isEnabled(tx, "per_person_views", "CA-ON", t));
    expect(await at(r.json.enabledAt)).toBe(false);
    expect(await at(r.json.effectiveAt - 1)).toBe(false);
    expect(await at(r.json.effectiveAt)).toBe(true);
    expect(await at(r.json.effectiveAt + 30 * DAY_MS)).toBe(true);
  });

  test("PERIOD: a zero-day period (no rule requires notice) is effective at once", async () => {
    const r = await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 0 }));
    expect(r.json.effectiveAt).toBe(r.json.enabledAt);
    expect(await sys(h, (tx) => isEnabled(tx, "per_person_views", "CA-ON", h.clock.now()))).toBe(true);
  });

  test("PERIOD: disable (owner or admin) is immediate, audited and final", async () => {
    await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 0 }));
    const off = await who.admin.post("/v1/compliance/features/per_person_views/disable");
    expect(off.status).toBe(200);
    expect(off.json.disabledAt).toBe(h.clock.now());
    expect(h.deps.validator.validate("offload/stage2/feature-enablement.schema.json", off.json)).toEqual({ ok: true });
    expect(await sys(h, (tx) => isEnabled(tx, "per_person_views", "CA-ON", h.clock.now()))).toBe(false);
    expect((await who.owner.get("/v1/audit-log?action=feature.disable")).json.items.length).toBeGreaterThan(0);
    // Nothing left to disable.
    expect((await who.admin.post("/v1/compliance/features/per_person_views/disable")).status).toBe(404);
  });

  test("PERIOD: disabling during the notice period cancels the pending enablement", async () => {
    await enable(enableBody("working_time", ppvNotice, { noticePeriodDays: 14 }));
    await who.owner.post("/v1/compliance/features/working_time/disable");
    h.clock.advance(15 * DAY_MS);
    expect(await sys(h, (tx) => isEnabled(tx, "working_time", "CA-ON", h.clock.now()))).toBe(false);
  });

  test.each(["lead", "member", "auditor"] as const)("PERIOD: %s may not disable (403)", async (k) => {
    expect((await who[k].post("/v1/compliance/features/per_person_views/disable")).status).toBe(403);
  });

  test("PERIOD: enablement history cannot be rewritten or deleted by the app role", async () => {
    expect((await enable(enableBody("per_person_views", ppvNotice))).status).toBe(201);
    const [row] = await h.db.migrator`select id from feature_enablements where tenant_id = ${h.a.id} and disabled_at_ms is null`;
    const id = row!.id as string;
    await expect(sys(h, (tx) => tx`update feature_enablements set notice_period_days = 0, effective_at_ms = enabled_at_ms where id = ${id}`)).rejects.toThrow();
    await expect(sys(h, (tx) => tx`update feature_enablements set jurisdictions = '["GB"]'::jsonb where id = ${id}`)).rejects.toThrow();
    await expect(sys(h, (tx) => tx`delete from feature_enablements where id = ${id}`)).rejects.toThrow();
    // Re-enabling a disabled row is refused too: a disable is final.
    await who.owner.post("/v1/compliance/features/per_person_views/disable");
    await expect(sys(h, (tx) => tx`update feature_enablements set disabled_at_ms = null, disabled_by = null where id = ${id}`)).rejects.toThrow();
  });

  test("PERIOD: jurisdictions match exactly: CA-ON on does not turn on CA-QC, GB or the unknown ZZ", async () => {
    await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 0 }));
    const now = h.clock.now();
    const got = await sys(h, async (tx) => ({
      on: await isEnabled(tx, "per_person_views", "CA-ON", now),
      qc: await isEnabled(tx, "per_person_views", "CA-QC", now),
      gb: await isEnabled(tx, "per_person_views", "GB", now),
      zz: await isEnabled(tx, "per_person_views", "ZZ", now),
      ca: await isEnabled(tx, "per_person_views", "CA", now),
    }));
    expect(got).toEqual({ on: true, qc: false, gb: false, zz: false, ca: false });
    expect([...(await sys(h, (tx) => enabledFor(tx, "CA-ON", now)))]).toEqual(["per_person_views"]);
  });
});

describe("HIDDEN", () => {
  const person = (id: string) => `scope=person:${id}`;

  test("HIDDEN: with the feature off, per-person endpoints are 403 feature_disabled for every role", async () => {
    const m = h.a.people.member.id;
    for (const k of ["owner", "admin", "lead"] as const) {
      const r = await who[k].get(`/v1/metrics/hours-saved?${person(m)}`);
      expect({ k, status: r.status, code: r.json.error.code }).toEqual({ k, status: 403, code: "feature_disabled" });
      expect((await who[k].get(`/v1/metrics/working-time?${person(m)}`)).json.error.code).toBe("feature_disabled");
    }
    // Self-scope working time is gated too (S+F:working_time).
    expect((await who.member.get(`/v1/metrics/working-time?${person(m)}`)).json.error.code).toBe("feature_disabled");
    expect((await who.owner.get("/v1/metrics/working-time?scope=company")).json.error.code).toBe("feature_disabled");
  });

  test("HIDDEN: with the feature off the device config says false and working time may not be sent", async () => {
    const cfg = await sys(h, (tx) => deviceConsent(tx, h.a.people.member.id, h.clock.now()));
    expect(cfg.features).toEqual({ workflow_metrics: true, per_person_views: false, working_time: false });
    expect(cfg.allowedKinds).not.toContain("working_time_aggregate");
    expect(cfg.workingTimeStartsAt).toBeNull();
  });

  test("HIDDEN: once effective, the gate stops hiding the per-person endpoint for that jurisdiction only", async () => {
    await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 0 }));
    const r = await who.owner.get(`/v1/metrics/hours-saved?${person(h.a.people.member.id)}`);
    expect(r.status).not.toBe(403);
    // member2 is in GB, not enabled: still hidden.
    expect((await who.owner.get(`/v1/metrics/hours-saved?${person(h.a.people.member2.id)}`)).json.error.code).toBe("feature_disabled");
  });

  test("HIDDEN: the self-view says which features are on for me, by my jurisdiction", async () => {
    await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 0 }));
    expect((await who.member.get("/v1/me/data")).json.features).toEqual({ workflow_metrics: true, per_person_views: true, working_time: false });
    expect((await who.member2.get("/v1/me/data")).json.features).toEqual({ workflow_metrics: true, per_person_views: false, working_time: false });
  });

  test("HIDDEN: a disabled feature hides the endpoint again at once", async () => {
    await enable(enableBody("per_person_views", ppvNotice, { noticePeriodDays: 0 }));
    await who.owner.post("/v1/compliance/features/per_person_views/disable");
    expect((await who.owner.get(`/v1/metrics/hours-saved?${person(h.a.people.member.id)}`)).json.error.code).toBe("feature_disabled");
  });
});
