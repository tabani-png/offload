// KINDS: the four operator fixtures rank the right kind of fix first, through the real rules.
// RULES: the lexicon tags, messaging only from messaging evidence, evidence belongs to the task, ranking ties.
import { describe, expect, test } from "bun:test";
import { rulesSolutions, SOLUTION_FACTORS } from "../../src/solutions/rules.ts";
import { partsOf, tagsFor } from "../../src/solutions/signals.ts";
import { SOLUTION_KINDS, type SolutionSet } from "../../src/solutions/types.ts";
import { ALL_FIXTURES, buildFixture, CODING_AGENT, EMAIL_FOLLOWUP, LINKEDIN_IMAGE, ONE_OFF_BROWSING, type FixtureSpec } from "./fixtures.ts";

const run = (spec: FixtureSpec): SolutionSet => {
  const f = buildFixture(spec);
  return rulesSolutions({ subject: f.subject, task: f.task, windowDays: f.windowDays, stepOf: f.stepOf });
};
const opt = (s: SolutionSet, kind: string) => s.options.find((o) => o.kind === kind)!;

describe("s22 kinds: the best kind of fix for each fixture", () => {
  test("KINDS: watching a coding agent -> a setup change (or a tool) comes first, never a workflow", () => {
    const s = run(CODING_AGENT);
    expect(["setup", "tool"]).toContain(s.top);
    expect(s.top).toBe("setup");
    expect(opt(s, "setup").what).toMatch(/coding agent/i);
    expect(opt(s, "workflow").weeklyHoursSaved).toBe(0);
    expect(s.heldBack).toBe(true);
  });

  test("KINDS: generating the image for a LinkedIn post -> remove the step comes first", () => {
    const s = run(LINKEDIN_IMAGE);
    expect(s.top).toBe("remove_step");
    const d = opt(s, "remove_step");
    expect(d.what).toMatch(/image/i);
    expect(d.handoff.to).toBe("brief");
    // It removes the image parts only, not the writing.
    expect(d.evidence.parts).toEqual(["st_linkedin_1", "st_linkedin_2"]);
  });

  test("KINDS: email follow-ups -> a workflow comes first and hands off to the workflow drafter", () => {
    const s = run(EMAIL_FOLLOWUP);
    expect(s.top).toBe("workflow");
    expect(s.options[0]!.handoff).toEqual({ to: "workflow_drafter", insightId: "ins_followup" });
    expect(s.options[0]!.what).toMatch(/Gmail/);
  });

  test("KINDS: one-off browsing -> leave it alone, with the reason", () => {
    const s = run(ONE_OFF_BROWSING);
    expect(s.top).toBe("leave_alone");
    expect(s.options[0]!.why).toMatch(/reading is the work/);
    expect(s.options[0]!.handoff).toEqual({ to: "none" });
  });

  test("KINDS: every set has all five kinds once, each with what, saving, arithmetic, effort, confidence and evidence", () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      const s = run(spec);
      expect([...s.options.map((o) => o.kind)].sort()).toEqual([...SOLUTION_KINDS].sort());
      for (const o of s.options) {
        expect(o.what.length).toBeGreaterThan(10);
        expect(typeof o.weeklyHoursSaved).toBe("number");
        expect(o.arithmetic).toContain("h/wk");
        expect(["none", "low", "medium", "high"]).toContain(o.effort.level);
        expect(o.confidence.value).toBeGreaterThanOrEqual(0);
        expect(o.confidence.value).toBeLessThanOrEqual(1);
        if (o.weeklyHoursSaved > 0) expect(o.evidence.spanIds.length).toBeGreaterThan(0);
      }
    }
  });

  test("KINDS: tool, setup and remove_step options that save time carry a brief spec with a builder prompt and checks", () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      for (const o of run(spec).options.filter((x) => ["tool", "setup", "remove_step"].includes(x.kind) && x.weeklyHoursSaved > 0)) {
        expect(o.handoff.to).toBe("brief");
        if (o.handoff.to !== "brief") continue;
        expect(o.handoff.spec.inputs.length).toBeGreaterThan(0);
        expect(o.handoff.spec.outputs.length).toBeGreaterThan(0);
        expect(o.handoff.spec.runsWhere).not.toBe("");
        expect(o.handoff.spec.builderPrompt).toContain(o.what);
        expect(o.handoff.spec.acceptance.length).toBeGreaterThan(0);
      }
    }
  });

  test("KINDS: options are ranked by saving x confidence (leave_alone aside)", () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      const rest = run(spec).options.filter((o) => o.kind !== "leave_alone");
      for (let i = 1; i < rest.length; i++) expect(rest[i - 1]!.weeklyHoursSaved * rest[i - 1]!.confidence.value).toBeGreaterThanOrEqual(rest[i]!.weeklyHoursSaved * rest[i]!.confidence.value);
    }
  });

  test("KINDS: the same coding task that is not held back still ranks setup over a workflow", () => {
    const s = run({ ...CODING_AGENT, id: "agent2", heldBack: undefined, judgement: 0.5 });
    expect(s.top).toBe("setup");
    expect(s.heldBack).toBe(false);
  });
});

describe("s22 rules: tags and evidence", () => {
  const tag = (text: string, o: Partial<Parameters<typeof tagsFor>[0]> = {}) => tagsFor({ text: ` ${text} `, surface: o.surface ?? " ", category: "other", kind: "task.x", keysPerMinute: 10, ...o });

  test("RULES: the lexicon tags agent watching, approvals, image making, publishing, data entry and reading", () => {
    expect(tag("watch agent run claude code session terminal", { category: "code" })).toContain("agent_watch");
    expect(tag("approve permission prompt claude code session", { category: "code" })).toContain("approval_prompt");
    expect(tag("generate image chatgpt image chat")).toContain("media_make");
    expect(tag("edit design canva")).toContain("media_make");
    expect(tag("publish post linkedin post editor")).toContain("publish");
    expect(tag("enter bill xero new bill form", { verb: "enter", surface: " xero new bill form " })).toContain("data_entry");
    expect(tag("read article news", { category: "browse" })).toEqual(["reading"]);
  });

  test("RULES: messaging comes only from messaging evidence: a mail surface, a message verb, an email or chat kind", () => {
    expect(tag("generate image chatgpt")).not.toContain("messaging");
    // OCR words like "send" or "email" on a sheet or a design tool do not make it messaging.
    expect(tag("investor pipeline google sheets send email reply", { category: "sheet" })).not.toContain("messaging");
    expect(tag("update record crm reply", { category: "other" })).not.toContain("messaging");
    expect(tag("reply ticket zendesk", { verb: "reply" })).toContain("messaging");
    expect(tag("x", { surface: " gmail " })).toContain("messaging");
    expect(tag("x", { kind: "email.replies" })).toContain("messaging");
    expect(tag("x", { category: "chat" })).toContain("messaging");
  });

  test("RULES: a live call is not data entry because its screen shows the word record (OCR never tags records or copies)", () => {
    expect(tag("calls in zoom.us zoom meeting meeting mute record share stop video", { category: "call", surface: " zoom.us " })).toEqual([]);
    expect(tag("export copy paste download", { category: "other" })).toEqual([]);
    expect(tag("copy invoice total", { verb: "copy" })).toContain("copy_between");
    expect(tag("enter bill xero", { verb: "enter", surface: " xero " })).toContain("data_entry");
  });

  test("RULES: with an agent at work, test and git words do not make it the person's manual commands", () => {
    expect(tag("claude code running tests git", { category: "code" })).not.toContain("code_manual");
    expect(tag("terminal npm test git push", { category: "code", keysPerMinute: 60 })).toContain("code_manual");
  });

  test("RULES: v2 parts follow the steps and their spans; v1 is one part over every span of the task", () => {
    const v2 = buildFixture(LINKEDIN_IMAGE);
    const parts = partsOf(v2.subject, v2.task, v2.stepOf);
    expect(parts.map((p) => p.id)).toEqual(["st_linkedin_0", "st_linkedin_1", "st_linkedin_2", "st_linkedin_3"]);
    expect(parts[1]!.spanIds).toHaveLength(5);
    const v1 = buildFixture(EMAIL_FOLLOWUP);
    const one = partsOf(v1.subject, v1.task);
    expect(one).toHaveLength(1);
    expect(one[0]!.spanIds).toEqual(v1.task.spanIds);
  });

  test("RULES: every evidence span and instance id belongs to the task", () => {
    for (const spec of Object.values(ALL_FIXTURES)) {
      const f = buildFixture(spec);
      const s = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
      const spans = new Set(f.task.spanIds);
      const insts = new Set(f.task.instances.map((i) => i.id));
      for (const o of s.options) {
        for (const id of o.evidence.spanIds) expect(spans.has(id)).toBe(true);
        for (const id of o.evidence.instanceIds) expect(insts.has(id)).toBe(true);
      }
    }
  });

  test("RULES: the same input gives the same set (pure)", () => {
    expect(JSON.stringify(run(LINKEDIN_IMAGE))).toBe(JSON.stringify(run(LINKEDIN_IMAGE)));
  });

  test("RULES: removal factors are shares (0..1) for every kind and tag", () => {
    for (const table of Object.values(SOLUTION_FACTORS)) for (const v of Object.values(table)) expect(v! > 0 && v! <= 1).toBe(true);
  });

  test("RULES: a task too small to be worth a fix leaves it alone first", () => {
    const s = run({ ...EMAIL_FOLLOWUP, id: "tiny", instances: 3, daysActive: 3, minutesPerInstance: 2 });
    expect(s.top).toBe("leave_alone");
    expect(s.options[0]!.why).toMatch(/no fix saves enough/);
  });
});
