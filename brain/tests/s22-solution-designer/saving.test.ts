// SAVING: no option ever saves more than the time actually observed; the arithmetic shows the figures; numbers do not
// depend on a model or on the user context.
import { describe, expect, test } from "bun:test";
import { StubModel, DEFAULT_MODELS } from "../../src/models/model.ts";
import { designSolutionWords } from "../../src/solutions/design.ts";
import { observedWeekly, rulesSolutions } from "../../src/solutions/rules.ts";
import type { SolutionSet } from "../../src/solutions/types.ts";
import type { Category } from "../../src/types.ts";
import { ALL_FIXTURES, buildFixture, LINKEDIN_IMAGE, type FixtureSpec, type StepSpec } from "./fixtures.ts";

const figures = (s: SolutionSet) => s.options.map((o) => [o.kind, o.weeklyHoursSaved, o.share, o.arithmetic, o.effort, o.confidence.value, o.evidence]);

/** mulberry32: a seeded generator so the random profiles are the same every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ["watch", "approve", "generate", "edit", "write", "publish", "enter", "copy", "paste", "read", "reply", "update", "review", "export"];
const OBJECTS = ["agent run", "permission prompt", "image", "post", "bill", "row", "article", "ticket", "record", "banner", "diff"];
const SURFACES: Array<[string, string, Category]> = [["Terminal", "", "code"], ["Google Chrome", "www.canva.com", "browse"], ["Google Chrome", "www.linkedin.com", "social"], ["Google Chrome", "mail.google.com", "email"], ["Microsoft Excel", "", "sheet"], ["Slack", "", "chat"], ["Preview", "", "other"]];

function randomSpec(r: () => number, n: number): FixtureSpec {
  const steps: StepSpec[] = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
    const [appName, host, category] = SURFACES[Math.floor(r() * SURFACES.length)]!;
    return { verb: VERBS[Math.floor(r() * VERBS.length)]!, object: OBJECTS[Math.floor(r() * OBJECTS.length)]!, surface: `${appName} window`, appName, host, category, minutes: 0.5 + r() * 40 };
  });
  const days = 1 + Math.floor(r() * 7);
  return { id: `r${n}`, kind: r() < 0.3 ? "email.replies" : "task.random", name: `random ${n}`, category: steps[0]!.category, appName: steps[0]!.appName, host: steps[0]!.host ?? "", template: "x", keysPerMinute: r() * 120, sameness: r(), instances: 3 + Math.floor(r() * 200), daysActive: days, steps: r() < 0.25 ? undefined : steps, minutesPerInstance: 0.5 + r() * 60, judgement: r() * 0.95, reach: r() < 0.5 ? undefined : r(), ...(r() < 0.2 ? { heldBack: "engineering work" } : {}) };
}

describe("s22 saving: never more than what was observed", () => {
  test("SAVING: observed weekly time = active minutes / 60 x 7 / window days, shown with its arithmetic", () => {
    const f = buildFixture(LINKEDIN_IMAGE);
    const o = observedWeekly(f.subject, 7);
    expect(o.hours).toBe(5.5);
    expect(o.arithmetic).toBe("330.0 min over 7 days × 7 / 7 = 5.50 h/wk observed");
    expect(observedWeekly(f.subject, 14).hours).toBe(2.75);
  });

  test("SAVING: no option of any fixture saves more than the observed weekly time", () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      const f = buildFixture(spec);
      const s = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
      for (const o of s.options) expect(o.weeklyHoursSaved).toBeLessThanOrEqual(s.observedWeeklyHours);
    }
  });

  test("SAVING: 500 seeded random tasks (any steps, window, reach, held back or not) never exceed observed time", () => {
    const r = rng(22);
    for (let n = 0; n < 500; n++) {
      const f = buildFixture(randomSpec(r, n));
      const s = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 1 + Math.floor(r() * 7), stepOf: f.stepOf });
      for (const o of s.options) {
        expect(o.weeklyHoursSaved).toBeGreaterThanOrEqual(0);
        expect(o.weeklyHoursSaved).toBeLessThanOrEqual(s.observedWeeklyHours);
        expect(o.share).toBeLessThanOrEqual(1);
      }
    }
  });

  test("SAVING: an inflated s04 estimate (1000 h/wk) is capped at the observed time for the workflow option", () => {
    const f = buildFixture(ALL_FIXTURES.followup);
    f.subject.saving = { ...f.subject.saving, weeklyHoursSaved: 1000 };
    const s = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7 });
    const w = s.options.find((o) => o.kind === "workflow")!;
    expect(w.weeklyHoursSaved).toBe(s.observedWeeklyHours);
    expect(w.arithmetic).toContain(`min(observed ${s.observedWeeklyHours.toFixed(1)} h/wk, estimate 1000.0 h/wk)`);
  });

  test("SAVING: each option's arithmetic ends in its own saving figure", () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      const f = buildFixture(spec);
      for (const o of rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf }).options) expect(o.arithmetic.endsWith(`${o.weeklyHoursSaved.toFixed(1)} h/wk`)).toBe(true);
    }
  });

  test("SAVING: the remove-step saving is observed x share x factor, by hand", () => {
    const f = buildFixture(LINKEDIN_IMAGE);
    const d = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf }).options.find((o) => o.kind === "remove_step")!;
    // image parts: 30 + 12 of 66 min per post; factor 0.85.
    expect(d.weeklyHoursSaved).toBe(Math.round(5.5 * (42 / 66) * 0.85 * 100) / 100);
    expect(d.effort.paybackWeeks).toBe(Math.round((6 / d.weeklyHoursSaved) * 100) / 100);
  });

  test("SAVING: figures, order and evidence are identical with the stub model, a rewording model and a user context", async () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      const f = buildFixture(spec);
      const rules = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
      const stub = await designSolutionWords({ subject: f.subject, set: rules, model: new StubModel(), models: DEFAULT_MODELS });
      const reword = new StubModel({ solution_design: (req) => (req.prompt.match(/<baseline>\n([\s\S]*)\n<\/baseline>/)?.[1] ?? "{}").replace(/"what": "([^"]*)"/g, '"what": "Plainly: $1"') });
      const worded = await designSolutionWords({ subject: f.subject, set: rules, model: reword, models: DEFAULT_MODELS, user: { role: "Founder", industry: "Software" } });
      expect(figures(stub)).toEqual(figures(rules));
      expect(figures(worded)).toEqual(figures(rules));
      expect(worded.options.every((o) => o.what.startsWith("Plainly: "))).toBe(true);
    }
  });
});
