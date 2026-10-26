// Review wave B, PR #9 items 5-7: working time is one value per person-day whatever the devices, a run id reused by
// another device cannot replace the run, and the sync handler lookup recovers after a failed load.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { median, nearestRank } from "../../../packages/hours-saved/src/index.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { siblingHandlers } from "../../src/modules/sync/ingest.ts";
import { asPrincipal, type Client } from "../helpers/harness.ts";
import { addDevice, at, populate, receipt, runOutcome, sendObjects, setup, workingTime, type S205 } from "./helpers.ts";

const OCT = "from=2026-10-01&to=2026-11-01";
const MINUTES = [300, 360, 420, 480, 540];
let s: S205;
let owner: Client;
let people: Awaited<ReturnType<typeof populate>>;

beforeAll(async () => {
  s = await setup();
  s.fc.features.set("CA-ON", ["working_time"]);
  people = await populate(s, s.h.a, { departmentId: s.h.a.departments.sales, size: 5 });
  for (const [i, p] of people.entries()) {
    s.fc.workingTime.add(p.personId);
    receipt(await sendObjects(s.h, p.dev, [workingTime("2026-10-20", MINUTES[i]!)]));
  }
  owner = await asPrincipal(s.h, "owner");
});
afterAll(() => s.close());

describe("PERSON one value per person-day, one run per run id", () => {
  test("PERSON: a person's second device reporting the same day counts once in working time (the later report)", async () => {
    const second = await addDevice(s.h, s.h.a, people[0]!.personId);
    const later = { ...workingTime("2026-10-20", 1000), id: ulid(at("2026-10-21", 1)), createdAt: at("2026-10-21", 1) };
    receipt(await sendObjects(s.h, second, [later]));
    const r = await owner.get(`/v1/metrics/working-time?scope=company&${OCT}`);
    const kept = [1000, ...MINUTES.slice(1)].sort((a, b) => a - b);
    expect(r.json.value).toEqual({ people: 5, medianActiveMinutesPerDay: median(kept), p25: nearestRank(kept, 1, 4), p75: nearestRank(kept, 3, 4) });
  });

  test("PERSON: one device re-reporting a day under a new object id counts once (the higher seq)", async () => {
    const again = { ...workingTime("2026-10-20", 900), id: ulid(at("2026-10-20", 23) + 1) };
    receipt(await sendObjects(s.h, people[1]!.dev, [again]));
    const r = await owner.get(`/v1/metrics/working-time?scope=company&${OCT}`);
    const kept = [1000, 900, 420, 480, 540].sort((a, b) => a - b);
    expect(r.json.value).toEqual({ people: 5, medianActiveMinutesPerDay: median(kept), p25: nearestRank(kept, 1, 4), p75: nearestRank(kept, 3, 4) });
  });

  test("PERSON: another device reusing a run id cannot replace that run (the first device to report it keeps it)", async () => {
    // hs-1 takes one run per run id; the copy kept is the first one received, not the latest.
    const before = (await owner.get(`/v1/metrics/hours-saved?scope=company&${OCT}`)).json.total.runs as Record<string, number>;
    const first = people[0]!.objects.find((o) => o.kind === "run_outcome")!;
    const dev = await addDevice(s.h, s.h.a, people[1]!.personId);
    receipt(await sendObjects(s.h, dev, [runOutcome({ runId: first.runId as string, outcome: "failed", endedAt: first.endedAt as number })]));
    const r = await owner.get(`/v1/metrics/hours-saved?scope=company&${OCT}`);
    expect(r.status).toBe(200);
    expect(r.json.total.runs).toEqual(before);
    // The original device's own update of its run still applies (latest seq per device, ADR 0111 §4).
    receipt(await sendObjects(s.h, people[0]!.dev, [{ ...first, id: ulid(at("2026-10-24")), outcome: "cancelled" }]));
    const after = (await owner.get(`/v1/metrics/hours-saved?scope=company&${OCT}`)).json.total.runs as Record<string, number>;
    expect(after).toEqual({ ...before, success: before.success! - 1, cancelled: before.cancelled! + 1 });
  });
});

describe("VERIFY sync handler lookup", () => {
  test("VERIFY: a failed handler load is not cached; the next lookup loads again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "offload-s205-handlers-"));
    try {
      const mod = (name: string) => {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "index.ts"), `export default { name: "${name}", routes() {}, syncHandlers: { run_outcome: async () => {} } };\n`);
      };
      mod("one");
      mod("two");
      await expect(siblingHandlers(dir)).rejects.toThrow("handled by both");
      rmSync(join(dir, "two"), { recursive: true, force: true });
      const h = await siblingHandlers(dir);
      expect([...h.keys()]).toEqual(["run_outcome"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
