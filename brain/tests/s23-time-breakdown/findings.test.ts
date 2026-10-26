// s23 FREED, NOCLAIM, FIXKIND, WORKFLOW: what could be more efficient, the hours it frees (code, ADR 0005), the best
// kind of fix when s22 is merged (never a fake one when it is not), and workflows only as the answer to a finding.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyzeHome, type Analysis } from "../../src/analyze.ts";
import { StubModel } from "../../src/models/model.ts";
import { formatHours } from "../../src/time/format.ts";
import { timeBreakdown } from "../../src/time/breakdown.ts";
import { brainOn, call, FIX_KINDS, neutralHome, NOW, OUTREACH_WORDS, S22_PRESENT, strings } from "./setup.ts";

const fx = neutralHome();
let analysis: Analysis;
let absent: any;
let api: any;
let insights: Map<string, any>;
let model: StubModel;

beforeAll(async () => {
  analysis = await analyzeHome(fx.home, { now: () => NOW });
  absent = await timeBreakdown(analysis, { fixOf: null });
  model = new StubModel();
  const brain = brainOn(fx.home, model);
  const r = await call(brain, "/time");
  expect(r.status).toBe(200);
  api = r.body;
  insights = new Map(((await call(brainOn(fx.home), "/insights")).body.insights as any[]).map((i) => [i.id, i]));
});
afterAll(() => fx.cleanup());

const observedOf = (f: any, days: number) => (f.taskMinutes.value / 60) * (7 / days);

describe("s23 hours freed", () => {
  test("FREED: the neutral week has at least two findings that free time, best first", () => {
    for (const w of [absent, api]) {
      const freeing = (w.findings as any[]).filter((f) => f.hoursFreed.value > 0);
      expect(freeing.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < w.findings.length; i++) expect(w.findings[i - 1].hoursFreed.value).toBeGreaterThanOrEqual(w.findings[i].hoursFreed.value);
    }
  });

  test("FREED: findings are the analysis's insights (same ids and tasks), nothing invented", () => {
    const ids = new Set(analysis.insights.map((i) => i.id));
    expect(absent.findings.length).toBeGreaterThan(0);
    for (const f of absent.findings as any[]) {
      expect(ids.has(f.insightId)).toBe(true);
      expect(analysis.insights.find((i) => i.id === f.insightId)!.taskId).toBe(f.taskId);
    }
  });

  test("FREED: observed hours a week = task minutes / 60 x 7 / window days", () => {
    const days = absent.window.days.length;
    for (const f of absent.findings as any[]) {
      expect(f.observedHoursPerWeek.unit).toBe("hours_per_week");
      expect(Math.abs(f.observedHoursPerWeek.value - observedOf(f, days))).toBeLessThan(1e-9);
    }
  });

  test("FREED: without s22, hours freed = min(observed, the s04 estimate), computed in code", () => {
    for (const f of absent.findings as any[]) {
      const ins = insights.get(f.insightId);
      expect(ins).toBeDefined();
      const want = Math.min(f.observedHoursPerWeek.value, ins.saving.weeklyHoursSaved);
      expect(Math.abs(f.hoursFreed.value - want)).toBeLessThan(1e-9);
      expect(f.hoursFreed.unit).toBe("hours_per_week");
    }
  });

  test("FREED: hours freed never exceed the task's own time, even when the fix source claims more", async () => {
    for (const w of [absent, api]) for (const f of w.findings as any[]) expect(f.hoursFreed.value).toBeLessThanOrEqual(f.observedHoursPerWeek.value + 1e-9);
    const greedy = await timeBreakdown(analysis, { fixOf: async () => ({ kind: "tool", weeklyHoursSaved: 1e9 }) });
    expect(greedy.findings.length).toBeGreaterThan(0);
    for (const f of greedy.findings as any[]) {
      expect(f.hoursFreed.value).toBeLessThanOrEqual(f.observedHoursPerWeek.value + 1e-9);
      expect(f.hoursFreed.value).toBeGreaterThan(0);
    }
  });

  test("FREED: the arithmetic line shows the inputs and ends with the hours-freed display", () => {
    for (const f of absent.findings as any[]) {
      expect(typeof f.arithmetic).toBe("string");
      expect(f.arithmetic).toContain(f.observedHoursPerWeek.display);
      expect(f.arithmetic.trim().endsWith(f.hoursFreed.display) || f.arithmetic.includes(`= ${f.hoursFreed.display}`)).toBe(true);
      expect(f.hoursFreed.display).toBe(formatHours(f.hoursFreed.value));
    }
  });

  test("FREED: GET /time calls no model and is the same twice (numbers by code)", async () => {
    expect(model.calls.length).toBe(0);
    const again = await call(brainOn(fx.home, model), "/time");
    expect(model.calls.length).toBe(0);
    const strip = (x: any) => JSON.stringify({ ...x, model: undefined, generatedAt: undefined });
    expect(strip(again.body)).toBe(strip(api));
  });
});

describe("s23 no inflated claims", () => {
  test("NOCLAIM: findings carry no saving percentage, range or s04 review chain", () => {
    for (const w of [absent, api]) {
      for (const f of w.findings as any[]) {
        for (const k of ["savingPct", "pct", "percent", "range", "reviewSecondsPerItem", "saving"]) expect(k in f).toBe(false);
        for (const s of strings(f)) {
          expect(s).not.toContain("%");
          expect(s).not.toMatch(/read\s*(\+|and|&)\s*approve/i);
          expect(s).not.toMatch(/→ review/);
        }
      }
    }
  });

  test("NOCLAIM: nothing in the response claims an 87-90% style saving", () => {
    for (const s of strings(api)) expect(s).not.toMatch(/\b(8[5-9]|9\d|100)\s?%/);
  });

  test("NOCLAIM: the neutral week's findings are not outreach", () => {
    for (const f of api.findings as any[]) {
      expect(f.name).not.toMatch(OUTREACH_WORDS);
      expect(String(insights.get(f.insightId)?.kind ?? "")).not.toBe("email.outreach");
    }
  });
});

describe("s23 fix kind", () => {
  test("FIXKIND: with s22 absent, every finding is shown without a fix kind, never a made-up one", () => {
    expect(absent.fixKinds).toBe("absent");
    expect(absent.findings.length).toBeGreaterThan(0);
    for (const f of absent.findings as any[]) {
      expect(f.fixKind).toBeNull();
      for (const s of strings(f)) expect(s).not.toMatch(/custom tool|setup change|remove the step|leave (it )?alone/i);
    }
  });

  test("FIXKIND: a fix source that answers something outside the five kinds gives no fix kind", async () => {
    const odd = await timeBreakdown(analysis, { fixOf: async () => ({ kind: "automate_everything" as any, weeklyHoursSaved: 1 }) });
    for (const f of odd.findings as any[]) expect(f.fixKind).toBeNull();
    const none = await timeBreakdown(analysis, { fixOf: async () => null });
    for (const f of none.findings as any[]) expect(f.fixKind).toBeNull();
  });

  test("FIXKIND: an injected fix kind is passed through, and its hours (capped) replace the s04 estimate", async () => {
    const set = await timeBreakdown(analysis, { fixOf: async () => ({ kind: "setup", weeklyHoursSaved: 0.5 }) });
    expect(set.fixKinds).toBe("s22");
    for (const f of set.findings as any[]) {
      expect(f.fixKind).toBe("setup");
      expect(Math.abs(f.hoursFreed.value - Math.min(0.5, f.observedHoursPerWeek.value))).toBeLessThan(1e-9);
    }
  });

  test(`FIXKIND: the API's fix kinds match s22 when it is merged, and are absent when it is not (s22 ${S22_PRESENT ? "present" : "absent"})`, async () => {
    expect(api.findings.length).toBeGreaterThan(0);
    if (!S22_PRESENT) {
      expect(api.fixKinds).toBe("absent");
      for (const f of api.findings as any[]) expect(f.fixKind).toBeNull();
      return;
    }
    expect(api.fixKinds).toBe("s22");
    const brain = brainOn(fx.home);
    for (const f of api.findings as any[]) {
      expect(FIX_KINDS as readonly string[]).toContain(f.fixKind);
      const s = await call(brain, `/insights/${f.insightId}/solutions`);
      expect(s.status).toBe(200);
      expect(f.fixKind).toBe(s.body.top);
      const top = (s.body.options as any[]).find((o) => o.kind === s.body.top);
      expect(Math.abs(f.hoursFreed.value - Math.min(top.weeklyHoursSaved, f.observedHoursPerWeek.value))).toBeLessThan(1e-9);
    }
  });
});

describe("s23 workflows come last", () => {
  test("WORKFLOW: a finding offers a workflow only when its fix is a workflow or no fix kind is known", async () => {
    const mixed = await timeBreakdown(analysis, {
      fixOf: async (i: { id: string }) => ({ kind: analysis.insights.findIndex((x) => x.id === i.id) % 2 === 0 ? "workflow" : "setup", weeklyHoursSaved: 1 }),
    });
    expect(mixed.findings.length).toBeGreaterThanOrEqual(2);
    for (const w of [absent, api, mixed]) {
      for (const f of w.findings as any[]) {
        if (f.fixKind === null || f.fixKind === "workflow") expect(f.workflowInsightId).toBe(f.insightId);
        else expect(f.workflowInsightId).toBeNull();
      }
    }
    expect((mixed.findings as any[]).some((f) => f.workflowInsightId === null)).toBe(true);
  });

  test("WORKFLOW: reading your time drafts nothing: no workflow folder, no automation", async () => {
    const wf = join(fx.home, "workflows");
    const before = existsSync(wf) ? readdirSync(wf).length : 0;
    const brain = brainOn(fx.home);
    await call(brain, "/time");
    await call(brain, `/time?day=${api.window.days[2]}`);
    expect(existsSync(wf) ? readdirSync(wf).length : 0).toBe(before);
    const d = await call(brain, "/dashboard");
    expect(d.body.automations.length).toBe(0);
  });

  test("WORKFLOW: the response has no workflow list of its own, only findings that may point at one", () => {
    for (const k of ["workflows", "automations", "suggestions"]) expect(k in api).toBe(false);
    expect(Object.keys(api)).toEqual(expect.arrayContaining(["total", "byTask", "byApp", "byKind", "findings"]));
  });
});
