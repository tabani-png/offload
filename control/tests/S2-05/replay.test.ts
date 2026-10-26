import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { addDevice, addPerson, receipt, reviewEvent, runOutcome, sendObjects, setup, type Dev, type S205 } from "./helpers.ts";

let s: S205;
let dev: Dev;
let dev2: Dev;

const count = async (table: string) => ((await s.h.db.migrator.unsafe(`select count(*)::int as n from ${table}`))[0].n as number);

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const p = await addPerson(s.h, t, { departmentId: t.departments.sales });
  const p2 = await addPerson(s.h, t, { departmentId: t.departments.finance });
  s.fc.ackAll([p, p2]);
  dev = await addDevice(s.h, t, p);
  dev2 = await addDevice(s.h, t, p2);
});
afterAll(() => s.close());

describe("REPLAY seq, sentAt and object ids", () => {
  test("REPLAY: the same seq twice is 409 replay the second time and stores nothing new", async () => {
    expect((await sendObjects(s.h, dev, [runOutcome()], { seq: 10 })).status).toBe(200);
    const before = await count("run_outcomes");
    const r = await sendObjects(s.h, dev, [runOutcome()], { seq: 10 });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("replay");
    expect(await count("run_outcomes")).toBe(before);
  });

  test("REPLAY: a lower seq than the last accepted one is a replay", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()], { seq: 9 });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("replay");
  });

  test("REPLAY: sentAt more than 10 minutes from server time (either way) is a replay", async () => {
    const now = s.h.clock.now();
    expect((await sendObjects(s.h, dev, [runOutcome()], { sentAt: now - 10 * 60_000 - 1 })).json.error.code).toBe("replay");
    expect((await sendObjects(s.h, dev, [runOutcome()], { sentAt: now + 10 * 60_000 + 1 })).json.error.code).toBe("replay");
    expect((await sendObjects(s.h, dev, [runOutcome()], { sentAt: now - 9 * 60_000 })).status).toBe(200);
  });

  test("REPLAY: a rejected envelope does not use up its seq", async () => {
    const next = dev.seq + 1;
    expect((await sendObjects(s.h, dev, [runOutcome()], { seq: next, sentAt: 0 })).status).toBe(409);
    expect((await sendObjects(s.h, dev, [runOutcome()], { seq: next })).status).toBe(200);
  });

  test("REPLAY: seq is per device", async () => {
    expect((await sendObjects(s.h, dev2, [runOutcome()], { seq: 1 })).status).toBe(200);
    expect((await sendObjects(s.h, dev2, [runOutcome()], { seq: 2 })).status).toBe(200);
  });

  test("REPLAY: the same object id in two envelopes is accepted once, then rejected as duplicate", async () => {
    const run = runOutcome();
    const rev = reviewEvent(run.runId);
    expect(receipt(await sendObjects(s.h, dev, [run, rev])).accepted).toEqual([run.id, rev.id]);
    const before = await count("review_events");
    const again = receipt(await sendObjects(s.h, dev, [run, rev]));
    expect(again.accepted).toEqual([]);
    expect(again.rejected).toEqual({ [run.id]: "duplicate", [rev.id]: "duplicate" });
    expect(await count("review_events")).toBe(before);
  });

  test("REPLAY: the same object id twice in one envelope is accepted once", async () => {
    const rev = reviewEvent(runOutcome().runId);
    const r = await sendObjects(s.h, dev, [rev, rev]);
    expect(r.json.accepted).toEqual([rev.id]);
    expect(r.json.rejected).toEqual([{ id: rev.id, code: "duplicate", retryable: false }]);
    const [n] = await s.h.db.migrator`select count(*)::int as n from review_events where object_id = ${rev.id}`;
    expect(n!.n).toBe(1);
  });

  test("REPLAY: a run outcome re-sent under its id with new state is kept once, latest seq wins (ADR 0111 §4)", async () => {
    const first = runOutcome({ outcome: "failed", sent: 0 });
    expect(receipt(await sendObjects(s.h, dev, [first])).accepted).toEqual([first.id]);
    const later = { ...first, outcome: "success", items: { ...first.items, total: 4, sent: 4 } };
    expect(receipt(await sendObjects(s.h, dev, [later])).accepted).toEqual([first.id]);
    const rows = await s.h.db.migrator`select outcome, items_sent, seq from run_outcomes where run_id = ${first.runId}`;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ outcome: "success", items_sent: 4 });
    expect(Number(rows[0].seq)).toBe(dev.seq);
  });

  test("REPLAY: an outcome for a known runId under a different object id replaces the row, not adds one", async () => {
    const first = runOutcome({ sent: 1, outcome: "success" });
    await sendObjects(s.h, dev, [first]);
    const second = runOutcome({ runId: first.runId, sent: 2, outcome: "success" });
    expect(receipt(await sendObjects(s.h, dev, [second])).accepted).toEqual([second.id]);
    const rows = await s.h.db.migrator`select object_id, items_sent from run_outcomes where run_id = ${first.runId}`;
    expect(rows.map((r: { object_id: string; items_sent: number }) => [r.object_id, r.items_sent])).toEqual([[second.id, 2]]);
  });

  test("REPLAY: an identical re-send of a run outcome is a duplicate", async () => {
    const run = runOutcome();
    await sendObjects(s.h, dev, [run]);
    expect(receipt(await sendObjects(s.h, dev, [run])).rejected).toEqual({ [run.id]: "duplicate" });
  });

  test("REPLAY: device_seq records the last accepted seq", async () => {
    const [r] = await s.h.db.migrator`select last_seq from device_seq where device_id = ${dev.deviceId}`;
    expect(Number(r!.last_seq)).toBe(dev.seq);
  });
});
