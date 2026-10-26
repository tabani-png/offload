import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asPrincipal, createHarness, enrollDevice, type Harness } from "../helpers/harness.ts";
import { reportInputsDigest, type BaselineSample, type RunInput } from "../../../packages/hours-saved/src/index.ts";
import { ulid } from "../../src/schema/encoding.ts";
import { INGEST_TABLES, seedIngest, signIn, type Who } from "./fixtures.ts";

// hoursSaved in GET /v1/me/data and /v1/me/export: hs-1 over the person's own retained inputs (Codex re-review P2 on
// PR #10). With S2-05's tables the report must match S2-05's own person-scope read and its digest must be rebuildable
// from the runs the self-view lists. Without those tables the report fails closed: a suppressed total, never a 0.

const SELF_VIEW = "offload/stage2/self-view.schema.json";

let h: Harness;
let who: Who;
let memberDevice: string;
let member2Device: string;

beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
  memberDevice = (await enrollDevice(h, await asPrincipal(h, "member"))).deviceId;
  member2Device = (await enrollDevice(h, await asPrincipal(h, "member2"))).deviceId;
});
afterAll(() => h.close());

/** Baseline samples as the device sent them, read back as the migrator (what hs-1 is given). */
async function samplesOf(workflowId: string): Promise<BaselineSample[]> {
  const rows = await h.db.migrator`select s.object_id, s.created_at_ms, s.workflow_id, s.version,
      to_char(s.window_start, 'YYYY-MM-DD') as window_start, to_char(s.window_end, 'YYYY-MM-DD') as window_end,
      (select jsonb_agg(jsonb_build_object('instanceRef', i.instance_ref, 'activeSeconds', i.active_seconds,
          'day', to_char(i.day, 'YYYY-MM-DD')) order by i.idx)
        from baseline_sample_instances i where i.tenant_id = s.tenant_id and i.device_id = s.device_id and i.object_id = s.object_id) as instances
    from baseline_samples s where s.tenant_id = ${h.a.id} and s.workflow_id = ${workflowId}`;
  return rows.map((r: Record<string, unknown>) => ({
    id: r.object_id as string,
    kind: "baseline_sample" as const,
    createdAt: Number(r.created_at_ms),
    workflowId: r.workflow_id as string,
    version: r.version as number,
    windowStart: r.window_start as string,
    windowEnd: r.window_end as string,
    instances: r.instances as BaselineSample["instances"],
  }));
}

describe("SELFVIEW hours saved", () => {
  test.skipIf(!INGEST_TABLES)("SELFVIEW: hoursSaved is hs-1 over my retained runs and baselines, the same report S2-05 serves me", async () => {
    const now = h.clock.now();
    await seedIngest(h, h.a.id, who.member.personId, memberDevice, now, { runs: [3, 2, 1], baselines: [10] });
    await seedIngest(h, h.a.id, who.member2.personId, member2Device, now, { runs: [2, 1], baselines: [10] });
    // hs-1 credits a successful run once it is reviewed: one 30-second review on each of my runs.
    const myRunIds = await h.db.migrator`select run_id, created_at_ms from run_outcomes
      where tenant_id = ${h.a.id} and person_id = ${who.member.personId}`;
    for (const r of myRunIds) {
      await h.db.migrator`insert into review_events (tenant_id, device_id, object_id, person_id, seq, created_at_ms, run_id,
          review_seconds, edit_seconds, fix_seconds, items_edited, decision, surface, received_at)
        values (${h.a.id}, ${memberDevice}, ${ulid(Number(r.created_at_ms))}, ${who.member.personId}, 2, ${Number(r.created_at_ms)},
          ${r.run_id}, 30, 0, 0, 0, 'approved', 'mac_review', now())`;
    }
    const data = await who.member.get("/v1/me/data");
    expect(data.status).toBe(200);
    expect(h.deps.validator.validate(SELF_VIEW, data.json)).toEqual({ ok: true });
    const hs = data.json.hoursSaved;
    expect(hs.scope).toEqual({ type: "person", id: who.member.personId });
    // Real numbers from my three successful runs, not an empty report.
    expect(hs.total.runs.success).toBe(3);
    expect(hs.total.people).toBe(1);
    expect(hs.total.seconds).toBeGreaterThan(0);
    expect(hs.total.hours).toBeGreaterThan(0);
    expect(hs.topWorkflows.length).toBe(1);

    // S2-05's own person-scope read over the same period gives the same report, digest included.
    const ref = await who.member.get(
      `/v1/metrics/hours-saved?scope=person:${who.member.personId}&from=${hs.period.from}&to=${hs.period.toExclusive}`,
    );
    expect(ref.status).toBe(200);
    expect(hs).toEqual(ref.json);

    // The digest is rebuildable from what the self-view lists: my runs (as listed, with my department and job role)
    // and the baseline samples of their workflow, which come from S2-05's evidence read.
    const person = data.json.person as { departmentId: string | null; jobRoleIds: string[] };
    const runs: RunInput[] = data.json.runs.map((run: RunInput["run"]) => ({
      run,
      personId: who.member.personId,
      departmentId: person.departmentId,
      jobRoleId: person.jobRoleIds.length === 1 ? person.jobRoleIds[0]! : null,
    }));
    const wf = data.json.runs[0].workflowId as string;
    const samples = await samplesOf(wf);
    expect(samples.length).toBe(1);
    const reviews = (await h.db.migrator`select object_id, created_at_ms, run_id, review_seconds, edit_seconds, fix_seconds,
        items_edited, decision, surface from review_events where tenant_id = ${h.a.id} and person_id = ${who.member.personId}`)
      .map((r: Record<string, unknown>) => ({
        id: r.object_id as string, kind: "review_event" as const, createdAt: Number(r.created_at_ms), runId: r.run_id as string,
        reviewSeconds: r.review_seconds as number, editSeconds: r.edit_seconds as number, fixSeconds: r.fix_seconds as number,
        itemsEdited: r.items_edited as number, decision: r.decision as "approved", surface: r.surface as "mac_review",
      }));
    expect(reviews.length).toBe(3);
    expect(reportInputsDigest({ runs, reviews, samples, estimates: [], workflows: [] })).toBe(hs.inputsDigest);
    // Change one listed input and the digest no longer matches: it is a digest of these rows, not a constant.
    const changed = [{ ...runs[0]!, run: { ...runs[0]!.run, costCents: runs[0]!.run.costCents + 1 } }, ...runs.slice(1)];
    expect(reportInputsDigest({ runs: changed, reviews, samples, estimates: [], workflows: [] })).not.toBe(hs.inputsDigest);

    // The export carries the same report.
    expect((await who.member.get("/v1/me/export")).json.hoursSaved).toEqual(hs);
  });

  test("SELFVIEW: without S2-05's tables hoursSaved fails closed (suppressed), never a made-up 0", async () => {
    if (INGEST_TABLES) {
      // On a tree with S2-05, take one of its input tables away in this file's own schema.
      await h.db.migrator.unsafe("drop table baseline_sample_instances cascade");
    }
    for (const path of ["/v1/me/data", "/v1/me/export"]) {
      const r = await who.member2.get(path);
      expect(r.status).toBe(200);
      expect(h.deps.validator.validate(SELF_VIEW, r.json)).toEqual({ ok: true });
      expect(r.json.hoursSaved.computation).toBe("hs-1");
      expect(r.json.hoursSaved.scope).toEqual({ type: "person", id: who.member2.personId });
      expect(r.json.hoursSaved.total).toEqual({ suppressed: true, reason: "feature_disabled" });
      expect(r.json.hoursSaved.topWorkflows).toEqual([]);
    }
  });
});
