import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome, type Analysis } from "../../src/analyze.ts";
import { validateEvent } from "../../src/store/schema.ts";
import { tempHome } from "../helpers.ts";

// The fixture week is 2026-10-12..18; analyse it from the day after (the reader refuses days older than 7).
const FIXTURE_NOW = new Date(2026, 9, 19, 12).getTime();
const plain = tempHome();
const enc = tempHome();
let analysis: Analysis;
let encAnalysis: Analysis;

beforeAll(async () => {
  const days = generateFixture({ seed: 42 });
  writeFixture(plain.home, days, { encrypted: false, seed: 42 });
  writeFixture(enc.home, days, { encrypted: true, seed: 42 });
  analysis = await analyzeHome(plain.home, { now: () => FIXTURE_NOW });
  encAnalysis = await analyzeHome(enc.home, { now: () => FIXTURE_NOW });
});
afterAll(() => {
  plain.cleanup();
  enc.cleanup();
});

describe("fixture generator", () => {
  test("is deterministic for a seed and differs across seeds", () => {
    expect(JSON.stringify(generateFixture({ seed: 42 }))).toBe(JSON.stringify(generateFixture({ seed: 42 })));
    expect(JSON.stringify(generateFixture({ seed: 7 }))).not.toBe(JSON.stringify(generateFixture({ seed: 42 })));
  });

  test("produces 7 days of schema-valid, time-ordered events with unique ids", () => {
    const days = generateFixture({ seed: 42 });
    expect(days.length).toBe(7);
    const ids = new Set<string>();
    for (const d of days) {
      for (let i = 0; i < d.events.length; i++) {
        const e = d.events[i]!;
        expect(validateEvent(e).ok).toBe(true);
        ids.add(e.id);
        if (i > 0) expect(e.ts).toBeGreaterThanOrEqual(d.events[i - 1]!.ts);
      }
    }
    expect(ids.size).toBe(days.reduce((n, d) => n + d.events.length, 0));
  });

  test("never records key values, only counts", () => {
    for (const d of generateFixture({ seed: 42 })) for (const e of d.events) if (e.kind === "input") expect(Object.keys(e).sort()).toEqual(["clicks", "id", "keys", "kind", "ts"]);
  });

  test("the store reads back with zero bad lines, plain and encrypted", () => {
    expect(analysis.store.badLineCount).toBe(0);
    expect(encAnalysis.store.badLineCount).toBe(0);
    expect(encAnalysis.store.days.every((d) => d.source === "encrypted")).toBe(true);
  });
});

describe("insights on the fixture week", () => {
  test("insight #1 is the outreach email task with a 60-70% share", () => {
    const top = analysis.insights[0]!;
    expect(top.label.kind).toBe("email.outreach");
    expect(top.stats.share.value).toBeGreaterThanOrEqual(0.6);
    expect(top.stats.share.value).toBeLessThanOrEqual(0.7);
  });

  test("insight #1 saves 85-92% of its time", () => {
    const s = analysis.insights[0]!.saving;
    expect(s.savingPct).toBeGreaterThanOrEqual(0.85);
    expect(s.savingPct).toBeLessThanOrEqual(0.92);
  });

  test("outreach runs about 100 a day at about 3 minutes each, to many funds", () => {
    const top = analysis.insights[0]!;
    expect(top.stats.instancesPerDay.value).toBeGreaterThan(90);
    expect(top.stats.instancesPerDay.value).toBeLessThan(110);
    expect(top.stats.medianMinutes.value).toBeGreaterThan(2.5);
    expect(top.stats.medianMinutes.value).toBeLessThan(3.5);
    expect(top.profile.identifiers.domains.length).toBeGreaterThan(20);
    expect(top.connectors.primary?.id).toBe("gmail");
  });

  test("the scheduling task is in the top 3 and needs Google Calendar", () => {
    const sched = analysis.insights.slice(0, 3).find((i) => i.label.kind === "email.scheduling");
    expect(sched).toBeDefined();
    expect(sched?.connectors.all.map((c) => c.id)).toContain("google-calendar");
  });

  test("insights are sorted by score and ranked from 1", () => {
    analysis.insights.forEach((ins, i) => {
      expect(ins.rank).toBe(i + 1);
      if (i > 0) expect(ins.score.value).toBeLessThanOrEqual(analysis.insights[i - 1]!.score.value);
    });
  });

  test("every figure of every insight traces to events that exist in the store", () => {
    const known = new Set(analysis.events.map((e) => e.id));
    for (const ins of analysis.insights) {
      const s = ins.stats;
      for (const f of [s.instances, s.daysActive, s.instancesPerDay, s.medianMinutes, s.p90Minutes, s.activeMinutes, s.share, s.sameness]) {
        expect(f.eventIds.length).toBeGreaterThan(0);
        for (const id of f.eventIds) expect(known.has(id)).toBe(true);
      }
      for (const id of ins.saving.eventIds) expect(known.has(id)).toBe(true);
    }
  });

  test("tasks without a connector, like coding in Terminal, are not offered as insights", () => {
    expect(analysis.tasks.some((t) => t.label.kind === "code.claude-code")).toBe(true);
    expect(analysis.insights.some((i) => i.label.kind === "code.claude-code")).toBe(false);
  });

  test("live calls are not offered as automations even though Zoom has a connector", () => {
    expect(analysis.tasks.some((t) => t.label.kind === "call.meetings")).toBe(true);
    expect(analysis.insights.some((i) => i.label.kind === "call.meetings")).toBe(false);
  });

  test("encrypted and plain stores give identical insights", () => {
    const view = (a: Analysis) => a.insights.map((i) => [i.id, i.score.value, i.saving.arithmetic]);
    expect(view(encAnalysis)).toEqual(view(analysis));
  });

  test("a different review time changes the saving but not the ranking inputs", async () => {
    const slow = await analyzeHome(plain.home, { reviewSeconds: 40, now: () => FIXTURE_NOW });
    expect(slow.insights[0]!.saving.savingPct).toBeLessThan(analysis.insights[0]!.saving.savingPct);
    expect(slow.insights[0]!.stats.share.value).toBe(analysis.insights[0]!.stats.share.value);
  });
});
