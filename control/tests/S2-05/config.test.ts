import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { addDevice, addPerson, getConfig, setup, type Dev, type S205 } from "./helpers.ts";

let s: S205;
let plain: Harness;
let dev: Dev;
let person: string;

beforeAll(async () => {
  s = await setup();
  plain = await createHarness();
  person = await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.sales, jurisdiction: "US-NY" });
  dev = await addDevice(s.h, s.h.a, person);
});
afterAll(async () => {
  await s.close();
  await plain.close();
});

describe("CONFIG GET /v1/sync/config", () => {
  test("CONFIG: with the default ports (no compliance yet) the device may send nothing but notice_ack", async () => {
    const p = await addPerson(plain, plain.a, { departmentId: plain.a.departments.sales });
    const d = await addDevice(plain, plain.a, p);
    const r = await getConfig(plain, d);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      personId: p,
      tenantId: plain.a.id,
      jurisdiction: "CA-ON",
      requiredNotice: null,
      allowedKinds: ["notice_ack"],
      features: { workflow_metrics: true, per_person_views: false, working_time: false },
      workingTimeStartsAt: null,
      // The S2-07 broker is now wired in: no kill switch is set, so none is reported.
      killSwitch: false,
      minAppVersion: "2.0.0",
      flushSeconds: 900,
    });
    // And the flag follows the broker: a kill switch on this person turns it on.
    await plain.db.migrator`insert into kill_switches (tenant_id, scope, target_id, set_by, set_by_role, set_at, reason)
      values (${plain.a.id}, 'person', ${p}, ${plain.a.people.owner.id}, 'owner', now(), 'test')`;
    expect((await getConfig(plain, d)).json.killSwitch).toBe(true);
  });

  test("CONFIG: allowedKinds follow ConsentPort; working time also needs the feature for the person's jurisdiction", async () => {
    s.fc.acked.add(person);
    expect((await getConfig(s.h, dev)).json.allowedKinds).toEqual([
      "notice_ack", "run_outcome", "review_event", "baseline_sample", "daily_aggregate", "workflow_proposal",
    ]);
    s.fc.workingTime.add(person);
    expect((await getConfig(s.h, dev)).json.allowedKinds).not.toContain("working_time_aggregate");
    s.fc.features.set("US-NY", ["working_time"]);
    expect((await getConfig(s.h, dev)).json.allowedKinds).toContain("working_time_aggregate");
  });

  test("CONFIG: features come from FeaturePort for the person's own jurisdiction", async () => {
    s.fc.features.set("US-NY", ["per_person_views"]);
    s.fc.features.set("CA-ON", ["working_time"]);
    expect((await getConfig(s.h, dev)).json.features).toEqual({ workflow_metrics: true, per_person_views: true, working_time: false });
  });

  test("CONFIG: the response validates against device-config.schema.json", async () => {
    const r = await getConfig(s.h, dev);
    expect(s.h.deps.validator.validate("offload/stage2/device-config.schema.json", r.json)).toEqual({ ok: true });
    expect(r.json.personId).toBe(person);
  });

  test("CONFIG: a web session cannot read a device config", async () => {
    const member = await asPrincipal(s.h, "member");
    expect((await member.get("/v1/sync/config")).status).toBe(403);
    expect((await s.h.request("GET", "/v1/sync/config")).status).toBe(401);
  });
});
