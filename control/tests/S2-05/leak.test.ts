import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { jcs } from "../../src/schema/encoding.ts";
import {
  S205_TABLES, addDevice, addPerson, baselineSample, dailyAggregate, receipt, reviewEvent, runOutcome, sendObjects, setup, workingTime,
  type Dev, type S205,
} from "./helpers.ts";

/** The only text columns allowed: ids, enums and codes (each also constrained by a CHECK). */
const TEXT_ALLOWED: Record<string, "id" | "enum" | "code"> = {
  object_id: "id", run_id: "id", scope_key: "id", instance_ref: "id",
  kind: "enum", runtime: "enum", outcome: "enum", approver_kind: "enum", decision: "enum", surface: "enum", scope_type: "enum",
  code: "enum", error_code: "code", batch_hash: "code", digest: "code", inputs_digest: "code", scope_digest: "code", stored_digest: "code",
  fresh_digest: "code", month: "code",
};

let s: S205;
let dev: Dev;
let person: string;

const totalRows = async () => {
  let n = 0;
  for (const t of S205_TABLES.filter((t) => t !== "device_seq")) n += (await s.h.db.migrator.unsafe(`select count(*)::int as n from ${t}`))[0].n;
  return n;
};

beforeAll(async () => {
  s = await setup();
  person = await addPerson(s.h, s.h.a, { departmentId: s.h.a.departments.sales });
  s.fc.acked.add(person);
  s.fc.workingTime.add(person);
  s.fc.features.set("CA-ON", ["working_time"]);
  dev = await addDevice(s.h, s.h.a, person);
});
afterAll(() => s.close());

describe("LEAK only the closed set of fields is ever stored", () => {
  test("LEAK: a run outcome with a recipient field is validation_failed and nothing is stored", async () => {
    const run = runOutcome({ extra: { recipient: "ceo@rival.example.com" } });
    expect(receipt(await sendObjects(s.h, dev, [run])).rejected).toEqual({ [run.id]: "validation_failed" });
    expect(await totalRows()).toBe(0);
  });

  test("LEAK: extra fields on every metric kind are rejected (body, title, subject, url, appName)", async () => {
    const run = runOutcome();
    const objs = [
      { ...reviewEvent(run.runId), body: "Hi Sam, as discussed" },
      { ...baselineSample([60]), title: "Invoice 4411 - Acme" },
      { ...dailyAggregate(), url: "https://crm.example.com/deal/9" },
      { ...workingTime(), appName: "Slack" },
      { ...run, subject: "Q4 pricing" },
    ];
    const r = receipt(await sendObjects(s.h, dev, objs));
    expect(r.accepted).toEqual([]);
    expect(Object.values(r.rejected)).toEqual(objs.map(() => "validation_failed"));
    expect(await totalRows()).toBe(0);
  });

  test("LEAK: an extra field nested inside a baseline instance or a daily workflow entry is rejected", async () => {
    const b = baselineSample([60, 70]);
    (b.instances[0] as Record<string, unknown>).windowTitle = "Payroll.xlsx";
    const d = dailyAggregate();
    (d.workflows[0] as Record<string, unknown>).host = "mail.google.com";
    expect(Object.values(receipt(await sendObjects(s.h, dev, [b, d])).rejected)).toEqual(["validation_failed", "validation_failed"]);
    expect(await totalRows()).toBe(0);
  });

  test("LEAK: a kind outside the closed set is validation_failed", async () => {
    const odd = { ...dailyAggregate(), kind: "screenshot" };
    expect(Object.values(receipt(await sendObjects(s.h, dev, [odd])).rejected)).toEqual(["validation_failed"]);
  });

  test("LEAK: an extra field on the envelope itself is 400 and nothing is stored", async () => {
    const r = await sendObjects(s.h, dev, [runOutcome()], { body: (e) => jcs({ ...e, note: "hello" }) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation_failed");
    expect(await totalRows()).toBe(0);
  });

  test("LEAK: valid objects next to a leaking one are stored; the leaking one is not", async () => {
    const good = runOutcome();
    const bad = runOutcome({ extra: { recipients: ["a@b.example.com"] } });
    const r = receipt(await sendObjects(s.h, dev, [good, bad]));
    expect(r.accepted).toEqual([good.id]);
    expect(r.rejected).toEqual({ [bad.id]: "validation_failed" });
    const stored = await s.h.db.migrator`select object_id from sync_objects`;
    expect(stored.map((x: { object_id: string }) => x.object_id)).toEqual([good.id]);
  });

  test("LEAK: column scan: this slice's tables hold no text column except ids, enums and codes", async () => {
    const cols = await s.h.db.migrator`select table_name, column_name, data_type from information_schema.columns
      where table_schema = ${s.h.db.schema} and table_name in ${s.h.db.migrator(S205_TABLES)}
      order by table_name, ordinal_position`;
    expect(new Set(cols.map((c: { table_name: string }) => c.table_name))).toEqual(new Set(S205_TABLES));
    const texty = cols.filter((c: { data_type: string }) => /char|text/.test(c.data_type));
    expect(texty.length).toBeGreaterThan(0);
    for (const c of texty) expect({ column: `${c.table_name}.${c.column_name}`, ok: c.column_name in TEXT_ALLOWED }).toEqual({ column: `${c.table_name}.${c.column_name}`, ok: true });
  });

  test("LEAK: every text column is pinned by a CHECK pattern or enum (or derived from ones that are)", async () => {
    const checks = await s.h.db.migrator`select rel.relname as t, pg_get_constraintdef(con.oid) as def
      from pg_constraint con join pg_class rel on rel.oid = con.conrelid join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = ${s.h.db.schema} and con.contype = 'c'`;
    const cols = await s.h.db.migrator`select table_name, column_name, is_generated from information_schema.columns
      where table_schema = ${s.h.db.schema} and table_name in ${s.h.db.migrator(S205_TABLES)} and data_type = 'text'`;
    for (const c of cols) {
      // Child tables reference their parent row by object_id (FK), which carries the CHECK.
      if (c.is_generated === "ALWAYS" || (c.column_name === "object_id" && /_instances|_workflows/.test(c.table_name))) continue;
      const pinned = checks.some((k: { t: string; def: string }) => k.t === c.table_name && k.def.includes(c.column_name));
      expect({ col: `${c.table_name}.${c.column_name}`, pinned }).toEqual({ col: `${c.table_name}.${c.column_name}`, pinned: true });
    }
  });

  test("LEAK: what is stored for a run outcome is exactly its schema fields (round trip, nothing added)", async () => {
    const run = runOutcome({ outcome: "success", sent: 2 });
    await sendObjects(s.h, dev, [run]);
    const [row] = await s.h.db.migrator`select * from run_outcomes where run_id = ${run.runId}`;
    const keys = Object.keys(row!).sort();
    expect(keys).toEqual([
      "approver_kind", "batch_hash", "cost_cents", "created_at_ms", "device_id", "ended_at_ms", "error_code",
      "items_failed_before_send", "items_pending", "items_sent", "items_total", "items_unknown", "object_id", "outcome", "overnight", "overnight_policy_id",
      "person_id", "received_at", "run_id", "runtime", "seq", "started_at_ms", "tenant_id", "version", "workflow_id",
    ]);
  });
});
