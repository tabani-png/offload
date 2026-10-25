// AC-7 FIXTURES and AC-8 KNOWN-ANSWER: each persona's top task, share, instances, evidence and label under v2;
// grouping agreement vs ground truth (v2 >= 0.9, and better than v1); the founder week keeps outreach first.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { generatePersona, PERSONAS, writePersona, type PersonaId } from "../../fixtures/gen-domains.ts";
import { agreementOf } from "../../fixtures/domains-report.ts";
import { analyzeHome, type Analysis, type Insight } from "../../src/analyze.ts";
import { toInsights } from "../../src/api/dto.ts";
import { tempHome } from "../helpers.ts";
import { personaRun, REPORT_START, reportNow, SEED } from "./setup.ts";

const SINGLE: readonly PersonaId[] = ["recruiter", "bookkeeper", "support", "salesops"];

function truthLabelOf(_a: Analysis, i: Insight, majority: Map<string, string>): string {
  return majority.get(i.taskId) ?? "none";
}

describe("FIXTURES", () => {
  test("deterministic by seed; another seed is another week", () => {
    const h = (seed: number) => createHash("sha256").update(JSON.stringify(generatePersona("salesops", { seed, startDay: REPORT_START }).truth)).digest("hex");
    expect(h(SEED)).toBe(h(SEED));
    expect(h(SEED)).not.toBe(h(SEED + 1));
  });

  test("every persona: 7 days, frame notes on almost every span, truth shares sum to 1, noise present", async () => {
    for (const p of PERSONAS) {
      const { week, v2 } = await personaRun(p);
      expect(week.days.length).toBe(7);
      const shares = Object.values(week.truth.tasks).reduce((n, t) => n + t.share, 0);
      expect(shares).toBeCloseTo(1, 6);
      expect(Object.keys(week.truth.tasks)).toEqual(expect.arrayContaining(["slack", "meeting"]));
      const withFrames = v2.understanding!.descriptions.filter((d) => d.source === "frames").length;
      expect(withFrames / v2.spans.length).toBeGreaterThan(0.95);
      expect(v2.understanding!.invalidFrames).toBe(0);
    }
  });

  test("plain and encrypted stores give identical v2 analyses", async () => {
    const plain = tempHome();
    const enc = tempHome();
    try {
      const week = generatePersona("support", { seed: SEED, startDay: REPORT_START });
      writePersona(plain.home, week, { encrypted: false, seed: SEED });
      writePersona(enc.home, week, { encrypted: true, seed: SEED });
      const a = await analyzeHome(plain.home, { now: reportNow, understanding: "v2" });
      const b = await analyzeHome(enc.home, { now: reportNow, understanding: "v2" });
      expect(b.understanding!.framesRead).toBe(week.truth.frameCount);
      expect(JSON.stringify(toInsights(b).insights)).toBe(JSON.stringify(toInsights(a).insights));
    } finally {
      plain.cleanup();
      enc.cleanup();
    }
  });
});

describe("KNOWN-ANSWER per persona (v2)", () => {
  for (const p of SINGLE) {
    test(`${p}: top insight is the truth task, share +-3 pts, instances +-10%, not email`, async () => {
      const { week, v2 } = await personaRun(p);
      const ag = agreementOf(v2, week.truth);
      const top = v2.insights[0]!;
      const truth = week.truth.topTask;
      expect(truthLabelOf(v2, top, ag.majority)).toBe(truth.label);
      expect(Math.abs(top.stats.share.value - truth.share)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(top.stats.instances.value - truth.instances)).toBeLessThanOrEqual(0.1 * truth.instances);
      expect(top.label.kind.startsWith("email.")).toBe(false);
      const surfaces = new Set(top.profile.understanding!.surfaces.flatMap((s) => [s.app, s.host]));
      for (const app of truth.apps) expect(surfaces.has(app)).toBe(true);
    });

    test(`${p}: every evidence id resolves`, async () => {
      const { v2 } = await personaRun(p);
      const events = new Set(v2.events.map((e) => e.id));
      const frames = new Set(v2.understanding!.descriptions.flatMap((d) => d.frameIds));
      for (const i of v2.insights.slice(0, 3)) {
        for (const f of Object.values(i.stats)) if (typeof f === "object" && f !== null && "eventIds" in f) for (const id of (f as { eventIds: string[] }).eventIds) expect(events.has(id)).toBe(true);
        for (const id of i.saving.eventIds) expect(events.has(id)).toBe(true);
        const u = i.profile.understanding!;
        for (const sid of u.evidenceSpanIds) expect(v2.spansById.has(sid)).toBe(true);
        for (const fid of u.frameIds) expect(frames.has(fid)).toBe(true);
        expect(u.instanceBoundaries.length).toBe(i.stats.instances.value);
      }
    });

    test(`${p}: grouping agreement F >= 0.9 under v2 and better than v1`, async () => {
      const { week, v1, v2 } = await personaRun(p);
      const a2 = agreementOf(v2, week.truth);
      const a1 = agreementOf(v1, week.truth);
      expect(a2.f).toBeGreaterThanOrEqual(0.9);
      expect(a2.f).toBeGreaterThan(a1.f);
    });
  }

  test("v1 on the same weeks does not find the cross-app task whole (the reason for v2)", async () => {
    const { week, v1 } = await personaRun("salesops");
    const ag = agreementOf(v1, week.truth);
    const truth = week.truth.topTask;
    const top = v1.insights.find((i) => ag.majority.get(i.taskId) === truth.label);
    expect(top === undefined || top.stats.share.value < truth.share - 0.1).toBe(true);
  });

  test("mixed: the top two insights are the two real tasks, in different apps, each within +-3 pts and +-10%", async () => {
    const { week, v2 } = await personaRun("mixed");
    const ag = agreementOf(v2, week.truth);
    const [a, b] = v2.insights;
    const labels = [truthLabelOf(v2, a!, ag.majority), truthLabelOf(v2, b!, ag.majority)].sort();
    expect(labels).toEqual([week.truth.topTask.label, week.truth.second!.label].sort());
    const hosts = (i: Insight) => new Set(i.profile.understanding!.surfaces.map((s) => s.host || s.app));
    expect([...hosts(a!)].some((h) => hosts(b!).has(h))).toBe(false);
    for (const i of [a!, b!]) {
      const t = week.truth.tasks[truthLabelOf(v2, i, ag.majority)]!;
      expect(Math.abs(i.stats.share.value - t.share)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(i.stats.instances.value - t.instances)).toBeLessThanOrEqual(0.1 * t.instances);
      expect(i.label.kind.startsWith("email.")).toBe(false);
    }
    expect(ag.f).toBeGreaterThanOrEqual(0.9);
  });

  test("founder week (gen.ts, no frames): v2 still ranks email.outreach first, labelled as email", async () => {
    const { home, cleanup } = tempHome();
    try {
      writeFixture(home, generateFixture({ seed: 42, startDay: REPORT_START }), { encrypted: false, seed: 42 });
      const a = await analyzeHome(home, { now: reportNow, understanding: "v2" });
      expect(a.insights[0]!.label.kind).toBe("email.outreach");
      expect(a.understanding!.framesRead).toBe(0);
      expect(a.insights[0]!.connectors.primary?.id).toBe("gmail");
    } finally {
      cleanup();
    }
  });
});
