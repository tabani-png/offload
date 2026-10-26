// PR #9 Codex review of 9c2c93b: an object kind that names an inherited property of a plain object ("constructor",
// "__proto__", "toString") found it in the kind table, reached the validator with a non-schema and threw outside the
// object's savepoint: 500 and the whole envelope rolled back. It must be that object's validation_failed, nothing more.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { addDevice, addPerson, receipt, runOutcome, sendObjects, setup, type Dev, type S205 } from "./helpers.ts";
import { ulid } from "../../src/schema/encoding.ts";

let s: S205;
let dev: Dev;

beforeAll(async () => {
  s = await setup();
  const p = await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.sales });
  s.fc.acked.add(p);
  dev = await addDevice(s.h, s.h.a, p);
});
afterAll(() => s.close());

describe("LEAK kinds are looked up as own entries only", () => {
  test("LEAK: kinds named after inherited properties are validation_failed per object; the rest of the envelope is stored", async () => {
    const odd = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].map((kind) => ({ id: ulid(), kind }));
    const run = runOutcome();
    const r = await sendObjects(s.h, dev, [...odd, run]);
    expect(r.status).toBe(200);
    const rc = receipt(r);
    expect(rc.accepted).toEqual([run.id]);
    for (const o of odd) expect(rc.rejected[o.id]).toBe("validation_failed");
  });
});
