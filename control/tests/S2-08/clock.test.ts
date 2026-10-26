import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, resolvePorts, type Deps } from "../../src/app.ts";
import { generateEs256SigningKey } from "../../src/auth/jwt.ts";
import { createHarness, T0, TestClock, testConfig, type Harness } from "../helpers/harness.ts";
import { FakeWorkOS } from "../helpers/fake-workos.ts";
import { DAY_MS, enableBody, publishNotice, signIn, sys, type Who } from "./fixtures.ts";

/**
 * The ports this module provides are bound to the clock of the app they were mounted in. Two apps in one process (tests,
 * embedded use) each decide notice periods and consent by their own time, whatever order they were created in.
 */
const HOUR = 3_600_000;
let h: Harness;
let who: Who;
let effective: number;

async function otherApp(clock: TestClock): Promise<Deps> {
  const { deps } = await createApp({
    db: h.db.app,
    config: testConfig(h.db.appUrl, h.db.schema),
    workos: await FakeWorkOS.create(clock.now),
    deviceKey: await generateEs256SigningKey(),
    clock,
  });
  return deps;
}

const decide = (deps: Deps, personId: string) =>
  sys(h, async (tx) => ({
    consent: await deps.ports.consent.allows(tx, personId, "working_time_aggregate"),
    features: [...(await deps.ports.features.enabledFor(tx, "CA-ON"))],
  }));

// T0 notice listing working_time published; T0+1h member (CA-ON) acks; T0+2h working_time enabled, 3-day period.
beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  const notice = (await publishNotice(who.owner, { features: ["workflow_metrics", "working_time"] })).id;
  h.clock.advance(HOUR);
  if ((await who.member.post(`/v1/me/notices/${notice}/ack`)).status !== 201) throw new Error("ack");
  h.clock.advance(HOUR);
  const r = await who.owner.post("/v1/compliance/features/working_time/enable", enableBody("working_time", notice, { noticePeriodDays: 3 }));
  if (r.status !== 201) throw new Error(`enable ${r.status}`);
  effective = r.json.effectiveAt;
  expect(effective).toBe(T0 + 2 * HOUR + 3 * DAY_MS);
});
afterAll(() => h.close());

describe("CONSENT", () => {
  test("CONSENT: a second app with a later clock does not open the notice period early in the first app", async () => {
    h.clock.t = effective - 1;
    const later = await otherApp(new TestClock(effective + DAY_MS));
    expect(await decide(h.deps, who.member.personId)).toEqual({ consent: false, features: [] });
    expect(await decide(later, who.member.personId)).toEqual({ consent: true, features: ["working_time"] });
  });

  test("CONSENT: a second app with an earlier clock does not deny consent in the first app", async () => {
    h.clock.t = effective;
    const earlier = await otherApp(new TestClock(T0));
    expect(await decide(h.deps, who.member.personId)).toEqual({ consent: true, features: ["working_time"] });
    expect(await decide(earlier, who.member.personId)).toEqual({ consent: false, features: [] });
  });

  test("CONSENT: each app keeps following its own clock after another app is mounted", async () => {
    const otherClock = new TestClock(effective - 1);
    const other = await otherApp(otherClock);
    h.clock.t = effective - 1;
    expect((await decide(h.deps, who.member.personId)).features).toEqual([]);
    h.clock.t = effective;
    expect((await decide(h.deps, who.member.personId)).features).toEqual(["working_time"]);
    expect((await decide(other, who.member.personId)).features).toEqual([]);
    otherClock.t = effective;
    expect((await decide(other, who.member.personId)).features).toEqual(["working_time"]);
  });

  test("CONSENT: the request gate of the first app answers by its own clock after a second app is mounted", async () => {
    h.clock.t = effective - 1;
    await otherApp(new TestClock(effective + DAY_MS));
    // Self-scope working time is S+F:working_time: hidden until effectiveAt by this app's clock, not the other's.
    const self = `/v1/metrics/working-time?scope=person:${who.member.personId}`;
    const r = await who.member.get(self);
    expect({ status: r.status, code: r.json?.error?.code }).toEqual({ status: 403, code: "feature_disabled" });
    h.clock.t = effective;
    expect((await who.member.get(self)).json?.error?.code).not.toBe("feature_disabled");
  });
});

describe("CONSENT", () => {
  test("CONSENT: ports resolved without mounting the module refuse to answer instead of guessing a clock", async () => {
    const compliance = (await import("../../src/modules/compliance/index.ts")).default;
    const ports = resolvePorts({ now: () => T0 }, [compliance]);
    await sys(h, async (tx) => {
      await expect(ports.consent.allows(tx, who.member.personId, "run_outcome")).rejects.toThrow(/mounted/);
      await expect(ports.features.enabledFor(tx, "CA-ON")).rejects.toThrow(/mounted/);
    });
  });

  test("CONSENT: a port the app overrides (a test spy) is left alone when the module mounts", async () => {
    const spy = { allows: async () => true };
    const clock = new TestClock(T0);
    const { deps } = await createApp({
      db: h.db.app,
      config: testConfig(h.db.appUrl, h.db.schema),
      workos: await FakeWorkOS.create(clock.now),
      deviceKey: await generateEs256SigningKey(),
      clock,
      ports: { consent: spy },
    });
    expect(deps.ports.consent).toBe(spy);
    expect((await decide(deps, who.owner.personId)).features).toEqual([]);
  });
});
