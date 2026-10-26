// PR #9 Codex review of 015c487: hs-1's report() cuts top workflows to 10 before S2-05 floors them, so workflows the
// floor drops pushed out lower-ranked ones that were allowed, and the list could come back empty. Here the company's
// ten biggest workflows each leave one Ops person unaccounted for (dropped), and an eleventh, smaller one is run by
// Sales alone: it must be listed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { at, baselineSample, populate, receipt, reviewEvent, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

const Q = "from=2026-10-01&to=2026-11-01";
const wf = (n: number) => `0b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BIG = Array.from({ length: 10 }, (_, i) => wf(i + 1));
const SMALL = wf(11);

let s: S205;
let owner: Client;

beforeAll(async () => {
  s = await setup();
  const t = s.h.a;
  const db = s.h.db.migrator;
  const ops = (await db`insert into departments (tenant_id, name) values (${t.id}, 'Ops') returning id`)[0]!.id as string;
  const sales = await populate(s, t, { departmentId: t.departments.sales, size: 5 });
  const opsPeople = await populate(s, t, { departmentId: ops, size: 5 });
  await populate(s, t, { departmentId: t.departments.finance, size: 5 });
  receipt(await sendObjects(s.h, sales[0]!.dev, [...BIG, SMALL].map((w) => baselineSample([600, 620, 640, 660, 680], { workflowId: w }))));
  const runs = (w: string, sent: number, k: number) => {
    const run = runOutcome({ workflowId: w, endedAt: at("2026-10-22", 8 + (k % 12)), sent });
    return [run, reviewEvent(run.runId, { review: 10, at: at("2026-10-22", 21) })];
  };
  for (const p of sales) receipt(await sendObjects(s.h, p.dev, [...BIG.flatMap((w, k) => runs(w, 20, k)), ...runs(SMALL, 1, 11)]));
  receipt(await sendObjects(s.h, opsPeople[0]!.dev, BIG.flatMap((w, k) => runs(w, 20, k))));
  owner = await asPrincipal(s.h, "owner");
}, 60_000);
afterAll(() => s.close());

describe("FLOOR top workflows are floored over the whole ranking, then cut to 10", () => {
  test("FLOOR: the ten bigger workflows the floor drops do not push out a smaller allowed one", async () => {
    const r = await owner.get(`/v1/metrics/hours-saved?scope=company&${Q}`);
    expect(r.status).toBe(200);
    const ids = (r.json.topWorkflows as Array<{ workflowId: string }>).map((w) => w.workflowId);
    for (const w of BIG) expect(ids).not.toContain(w);
    expect(ids).toContain(SMALL);
  });
});
