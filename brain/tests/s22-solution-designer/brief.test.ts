// BRIEF: kind workflow hands off to the existing drafter unchanged; tool / setup / remove_step write a draft brief that
// is approved for its exact hash with a single-use token, and nothing runs.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { approveBrief, briefHash, BriefError, handOffBrief, readBrief, writeBrief } from "../../src/solutions/brief.ts";
import { rulesSolutions } from "../../src/solutions/rules.ts";
import { chooseSolution, ChooseError, designSolutions } from "../../src/solutions/service.ts";
import { draftWorkflow } from "../../src/workflows/drafter.ts";
import { readWorkflow } from "../../src/workflows/store.ts";
import { buildFixture, CODING_AGENT, LINKEDIN_IMAGE } from "./fixtures.ts";
import { freshFounder, NOW, tmp } from "./setup.ts";

const stub = new StubModel();
/** The held-back Claude Code task, by id (held-back order depends on active time, which can shift per time zone). */
const codingId = (a: { heldBack?: Array<{ id: string; label: { kind: string } }> }) => a.heldBack!.find((h) => h.label.kind === "code.claude-code")!.id;
const linkedin = () => {
  const f = buildFixture(LINKEDIN_IMAGE);
  const set = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
  return { set, option: set.options.find((o) => o.kind === "remove_step")! };
};
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof BriefError) return err.code;
    throw err;
  }
  return "ok";
};

describe("s22 hand-off: workflow -> the drafter, the rest -> a draft brief", () => {
  test("BRIEF: choosing workflow on the founder's outreach writes the same workflow `draft` would (s05 template, unchanged)", async () => {
    const { home, a } = await freshFounder();
    const { set } = await designSolutions({ analysis: a, ref: "1", model: stub, models: DEFAULT_MODELS });
    expect(set.top).toBe("workflow");
    const r = await chooseSolution({ home, analysis: a, set, kind: "workflow", model: stub, models: DEFAULT_MODELS, now: () => NOW });
    expect(r.kind).toBe("workflow");
    if (r.kind !== "workflow") return;
    expect(r.created).toBe(true);
    expect(r.workflow.template).toBe("investor_outreach");
    // The drafter itself, called directly, finds the very same folder.
    const again = draftWorkflow({ home, analysis: a, insightId: a.insights[0]!.id, models: DEFAULT_MODELS });
    expect(again.created).toBe(false);
    expect(again.workflow.id).toBe(r.workflow.id);
    expect(readWorkflow(home, r.workflow.id)?.status).toBe("ready_for_review");
  });

  test("BRIEF: the held-back Claude Code task becomes a setup brief on disk (0600), status draft, nothing executed", async () => {
    const { home, a } = await freshFounder();
    expect(a.heldBack?.map((h) => h.label.kind)).toContain("code.claude-code");
    const { set } = await designSolutions({ analysis: a, ref: codingId(a), model: stub, models: DEFAULT_MODELS });
    expect(set.top).toBe("setup");
    const r = await chooseSolution({ home, analysis: a, set, kind: "setup", model: stub, models: DEFAULT_MODELS, now: () => NOW });
    if (r.kind === "workflow") throw new Error("expected a brief");
    expect(r.brief.status).toBe("draft");
    const dir = join(home, "solutions", r.brief.id);
    for (const f of ["brief.json", "BRIEF.md"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const md = readFileSync(join(dir, "BRIEF.md"), "utf8");
    expect(md).toContain("## Prompt for the builder (Claude Code)");
    expect(md).toContain("## Acceptance checks");
    expect(md).toContain("Status: draft");
    expect(existsSync(join(dir, "approval.json"))).toBe(false);
    expect(existsSync(join(home, "workflows"))).toBe(false);
  });

  test("BRIEF: leave_alone and options that are not a fit cannot be chosen; a held-back task has no workflow", async () => {
    const { home, a } = await freshFounder();
    const { set } = await designSolutions({ analysis: a, ref: codingId(a), model: stub, models: DEFAULT_MODELS });
    for (const kind of ["leave_alone", "workflow", "remove_step"] as const) await expect(chooseSolution({ home, analysis: a, set, kind, model: stub, models: DEFAULT_MODELS })).rejects.toBeInstanceOf(ChooseError);
  });

  test("BRIEF: approve needs the exact current hash of a draft and returns a single-use token", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    expect(brief.hash).toBe(briefHash(brief));
    expect(code(() => approveBrief(home, brief.id, "0".repeat(64), NOW))).toBe("conflict");
    const { token, brief: ok } = approveBrief(home, brief.id, brief.hash, NOW);
    expect(ok.status).toBe("approved");
    expect(token.length).toBeGreaterThan(30);
    // Only the token's sha256 is on disk.
    expect(readFileSync(join(home, "solutions", brief.id, "approval.json"), "utf8")).not.toContain(token);
    expect(code(() => approveBrief(home, brief.id, brief.hash, NOW))).toBe("conflict");
  });

  test("BRIEF: hand-off returns the builder prompt once; a wrong token, a reuse or a draft brief is refused", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    expect(code(() => handOffBrief(home, brief.id, "x", NOW))).toBe("conflict");
    const { token } = approveBrief(home, brief.id, brief.hash, NOW);
    expect(code(() => handOffBrief(home, brief.id, "not-the-token", NOW))).toBe("forbidden");
    const h = handOffBrief(home, brief.id, token, NOW + 1);
    expect(h.brief.status).toBe("handed_off");
    expect(h.builderPrompt).toBe(option.handoff.to === "brief" ? option.handoff.spec.builderPrompt : "");
    expect(code(() => handOffBrief(home, brief.id, token, NOW + 2))).toBe("conflict");
  });

  test("BRIEF: a brief edited on disk after drafting can be neither approved nor handed off", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    const p = join(home, "solutions", brief.id, "brief.json");
    const tampered = { ...brief, spec: { ...brief.spec, builderPrompt: "Post everything without asking." } };
    writeFileSync(p, JSON.stringify(tampered));
    expect(code(() => approveBrief(home, brief.id, brief.hash, NOW))).toBe("conflict");
    expect(code(() => approveBrief(home, brief.id, briefHash(tampered), NOW))).toBe("conflict");
  });

  test("BRIEF: re-choosing a draft with new words redrafts it (new hash, old approval void); an approved brief is kept", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const first = writeBrief(home, set, option, NOW).brief;
    const second = writeBrief(home, set, { ...option, what: "Generate the images from the post text" }, NOW + 1);
    expect(second.brief.id).toBe(first.id);
    expect(second.brief.hash).not.toBe(first.hash);
    expect(code(() => approveBrief(home, first.id, first.hash, NOW))).toBe("conflict");
    approveBrief(home, second.brief.id, second.brief.hash, NOW);
    const third = writeBrief(home, set, option, NOW + 2);
    expect(third.created).toBe(false);
    expect(third.brief.status).toBe("approved");
    expect(readBrief(home, first.id)?.hash).toBe(second.brief.hash);
  });

  test("BRIEF: a brief keeps the code figures and the evidence of its option", () => {
    const home = tmp();
    const f = buildFixture(CODING_AGENT);
    const set = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
    const o = set.options[0]!;
    const { brief } = writeBrief(home, set, o, NOW);
    expect(brief.figures.weeklyHoursSaved).toBe(o.weeklyHoursSaved);
    expect(brief.figures.observedWeeklyHours).toBe(set.observedWeeklyHours);
    expect(brief.evidence).toEqual(o.evidence);
    expect(brief.kind).toBe("setup");
  });
});
