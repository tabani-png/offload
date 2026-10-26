// Review wave C, PR #9 item 1: the copy of a run id that counts is chosen across every copy before any period,
// person or workflow filter.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { WF2, addDevice, asPerson, at, populate, receipt, runOutcome, sendObjects, setup, type S205 } from "./helpers.ts";

const OCT = "from=2026-10-01&to=2026-11-01";
const SEP = "from=2026-09-01&to=2026-10-01";
let s: S205;
let owner: Client;
let people: Awaited<ReturnType<typeof populate>>;

type Run = Record<string, unknown> & { runId: string; endedAt: number };
const runsOf = (i: number) => people[i]!.objects.filter((o) => o.kind === "run_outcome") as Run[];
const hsPerson = (id: string, period = OCT) => `/v1/metrics/hours-saved?scope=person:${id}&${period}`;

beforeAll(async () => {
  s = await setup();
  s.fc.features.set("CA-ON", ["per_person_views"]);
  people = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("PERSON one run per run id, whatever the filters", () => {
  test("PERSON: a copy of another person's run id from a second person's device never counts in that person's scope", async () => {
    const me = await asPerson(s.h, s.h.a, people[1]!.personId);
    const before = (await me.get(hsPerson(people[1]!.personId))).json.total;
    const run = runsOf(0)[0]!;
    const dev = await addDevice(s.h, s.h.a, people[1]!.personId);
    receipt(await sendObjects(s.h, dev, [runOutcome({ runId: run.runId, endedAt: run.endedAt, sent: 9 })]));
    const r = await me.get(hsPerson(people[1]!.personId));
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual(before);
  });

  test("PERSON: a copy of a run id ending in another period does not count in that period", async () => {
    // Every person copies someone else's run into September, so the company scope is over the floor there.
    for (let i = 0; i < 5; i++) {
      const run = runsOf((i + 1) % 5)[1]!;
      receipt(await sendObjects(s.h, people[i]!.dev, [runOutcome({ runId: run.runId, endedAt: at("2026-09-20", 9 + i) })]));
    }
    const r = await owner.get(`/v1/metrics/hours-saved?scope=company&${SEP}`);
    expect(r.status).toBe(200);
    // No run of September counts, so no one has data there: the company total is under the floor.
    expect(r.json.total).toEqual({ suppressed: true, reason: "group_floor" });
    const self = await asPerson(s.h, s.h.a, people[0]!.personId);
    const mine = await self.get(hsPerson(people[0]!.personId, SEP));
    expect(mine.status).toBe(200);
    expect(mine.json.total.runs).toEqual({ success: 0, failed: 0, cancelled: 0, rejected: 0, capped: 0 });
  });

  test("PERSON: a copy of a run id under another workflow does not show in that workflow's evidence", async () => {
    const run = runsOf(0)[1]!;
    receipt(await sendObjects(s.h, people[2]!.dev, [runOutcome({ runId: run.runId, endedAt: run.endedAt, workflowId: WF2 })]));
    const me = await asPerson(s.h, s.h.a, people[2]!.personId);
    const r = await me.get(`/v1/metrics/hours-saved/evidence?workflowId=${WF2}&version=1&${OCT}`);
    expect(r.status).toBe(200);
    expect(r.json.runs).toEqual([]);
  });
});
