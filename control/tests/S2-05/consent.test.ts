import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "../helpers/harness.ts";
import {
  FAKE_NOTICE_MODULE, addDevice, addPerson, baselineSample, dailyAggregate, noticeAck, receipt, reviewEvent, runOutcome,
  sendObjects, setup, workingTime, type Dev, type S205,
} from "./helpers.ts";

let s: S205;
let plain: Harness;
let dev: Dev;
let person: string;

const rows = async (table: string, personId: string) =>
  ((await s.h.db.migrator.unsafe(`select count(*)::int as n from ${table} where person_id = $1`, [personId]))[0].n as number);

beforeAll(async () => {
  // A compliance stand-in beside the real modules: it registers the notice_ack handler, as S2-08 will.
  s = await setup({ "fake-notices": FAKE_NOTICE_MODULE });
  plain = await createHarness();
  person = await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.sales, jurisdiction: "CA-ON" });
  dev = await addDevice(s.h, s.h.a, person);
});
afterAll(async () => {
  await s.close();
  await plain.close();
});

describe("CONSENT server-side re-check (ADR 0103 §2)", () => {
  test("CONSENT: before the acknowledgement only notice_ack is accepted; everything else is consent_missing", async () => {
    const run = runOutcome();
    const objs = [noticeAck(), run, reviewEvent(run.runId), baselineSample([100, 200]), dailyAggregate()];
    const r = receipt(await sendObjects(s.h, dev, objs));
    expect(r.accepted).toEqual([objs[0]!.id]);
    expect(r.rejected).toEqual(Object.fromEntries(objs.slice(1).map((o) => [o.id, "consent_missing"])));
    for (const t of ["run_outcomes", "review_events", "baseline_samples", "daily_aggregates"]) expect(await rows(t, person)).toBe(0);
  });

  test("CONSENT: consent_missing is not retryable (the receipt says so)", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()]);
    expect(r.json.rejected[0]).toMatchObject({ code: "consent_missing", retryable: false });
  });

  test("CONSENT: once ConsentPort allows the person, the same kinds are accepted and stored", async () => {
    s.fc.acked.add(person);
    const run = runOutcome();
    const objs = [run, reviewEvent(run.runId), baselineSample([100, 200]), dailyAggregate()];
    const r = receipt(await sendObjects(s.h, dev, objs));
    expect(r.accepted).toEqual(objs.map((o) => o.id));
    for (const t of ["run_outcomes", "review_events", "baseline_samples", "daily_aggregates"]) expect(await rows(t, person)).toBe(1);
  });

  test("CONSENT: working time with the feature off for the person's jurisdiction is feature_disabled", async () => {
    s.fc.workingTime.add(person);
    s.fc.features.set("GB", ["working_time"]);
    const wt = workingTime("2026-10-21");
    expect(receipt(await sendObjects(s.h, dev, [wt])).rejected).toEqual({ [wt.id]: "feature_disabled" });
    expect(await rows("working_time_aggregates", person)).toBe(0);
  });

  test("CONSENT: working time with the feature on but no acknowledged notice period is consent_missing", async () => {
    s.fc.workingTime.delete(person);
    s.fc.features.set("CA-ON", ["working_time"]);
    const wt = workingTime("2026-10-22");
    expect(receipt(await sendObjects(s.h, dev, [wt])).rejected).toEqual({ [wt.id]: "consent_missing" });
  });

  test("CONSENT: working time enabled, acknowledged and past its notice period is accepted", async () => {
    s.fc.workingTime.add(person);
    const wt = workingTime("2026-10-23");
    expect(receipt(await sendObjects(s.h, dev, [wt])).accepted).toEqual([wt.id]);
    expect(await rows("working_time_aggregates", person)).toBe(1);
  });

  test("CONSENT: a stale client sending after consent was withdrawn is rejected again", async () => {
    s.fc.acked.delete(person);
    const run = runOutcome();
    expect(receipt(await sendObjects(s.h, dev, [run])).rejected).toEqual({ [run.id]: "consent_missing" });
    s.fc.acked.add(person);
  });

  test("CONSENT: disabling working_time stops ingest of it immediately", async () => {
    s.fc.features.delete("CA-ON");
    const wt = workingTime("2026-10-24");
    expect(receipt(await sendObjects(s.h, dev, [wt])).rejected).toEqual({ [wt.id]: "feature_disabled" });
  });

  test("CONSENT: with the default ports nothing but notice_ack passes the gate; an ack of an unpublished notice is invalid", async () => {
    const p = await addPerson(plain, plain.a, { departmentId: plain.a.departments.sales });
    const d = await addDevice(plain, plain.a, p);
    const run = runOutcome();
    const ack = noticeAck();
    const r = await sendObjects(plain, d, [ack, run]);
    expect(r.status).toBe(200);
    expect(r.json.accepted).toEqual([]);
    // S2-08 now handles notice_ack. This ack names a notice that was never published: the object is invalid, not a
    // server fault, so it is rejected for good (it used to come back as a retryable server_error, retried forever).
    expect(r.json.rejected).toEqual([
      { id: ack.id, code: "validation_failed", retryable: false },
      { id: run.id, code: "consent_missing", retryable: false },
    ]);
  });
});
