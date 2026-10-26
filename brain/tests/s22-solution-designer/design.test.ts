// DESIGN: the Opus wording pass. Model calls are faked at the router boundary (a Backend replaying recorded replies),
// so the real router (route, tier, effort), the real prompt and the real validator run.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { ModelRouter, RoutedModel, type Backend, type BackendReply, type BackendRequest } from "../../src/models/router.ts";
import { applySolutionDesign, designSolutionWords, solutionDesignPrompt, SOLUTION_DESIGN_SYSTEM } from "../../src/solutions/design.ts";
import { rulesSolutions } from "../../src/solutions/rules.ts";
import type { SolutionSet } from "../../src/solutions/types.ts";
import { buildFixture, CODING_AGENT, LINKEDIN_IMAGE, type FixtureSpec } from "./fixtures.ts";

class RecordedBackend implements Backend {
  readonly kind = "api" as const;
  readonly metered = true;
  readonly calls: BackendRequest[] = [];
  constructor(private readonly reply: string) {}
  async complete(r: BackendRequest): Promise<BackendReply> {
    this.calls.push(r);
    return { text: this.reply, stopReason: "end_turn", usage: { inputTokens: 3000, outputTokens: 900, cacheReadTokens: 0 }, model: r.model };
  }
}

const recorded = (name: string) => (JSON.parse(readFileSync(join(import.meta.dir, "recorded", `${name}.json`), "utf8")) as { reply: string }).reply;
const setOf = (spec: FixtureSpec) => {
  const f = buildFixture(spec);
  return { f, set: rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf }) };
};
const routed = (reply: string) => {
  const backend = new RecordedBackend(reply);
  const router = new ModelRouter({ home: mkdtempSync(join(tmpdir(), "offload-s22d-")), backend, monthlyBudgetUsd: null });
  return { backend, model: new RoutedModel(router) };
};
const figures = (s: SolutionSet) => s.options.map((o) => [o.kind, o.weeklyHoursSaved, o.share, o.arithmetic, o.effort, o.confidence, o.evidence, o.handoff.to]);

describe("s22 design: Opus words the options, code keeps the numbers", () => {
  test("DESIGN: the call goes through the router's design route on Opus 5.5, high effort, adaptive thinking", async () => {
    const { f, set } = setOf(LINKEDIN_IMAGE);
    const { backend, model } = routed(recorded("linkedin"));
    await designSolutionWords({ subject: f.subject, set, model, models: DEFAULT_MODELS });
    expect(backend.calls).toHaveLength(1);
    const c = backend.calls[0]!;
    expect(c.route).toBe("design");
    expect(c.role).toBe("solution_design");
    expect(c.model).toBe("claude-opus-5-5");
    expect(c.effort).toBe("high");
    expect(c.adaptiveThinking).toBe(true);
    expect(c.system).toBe(SOLUTION_DESIGN_SYSTEM);
  });

  test("DESIGN: a recorded LinkedIn reply rewrites what, why and the brief; figures, order and evidence stay", async () => {
    const { f, set } = setOf(LINKEDIN_IMAGE);
    const out = await designSolutionWords({ subject: f.subject, set, model: routed(recorded("linkedin")).model, models: DEFAULT_MODELS });
    expect(out.designedBy).toBe("claude-opus-5-5");
    expect(out.options[0]!.what).toBe("Auto-generate each post's image from its text in your brand style, so you only approve it");
    const d = out.options[0]!;
    expect(d.handoff.to === "brief" && d.handoff.spec.acceptance).toContain("nothing is posted until I approve the exact image");
    expect(figures(out)).toEqual(figures(set));
    expect(out.top).toBe(set.top);
  });

  test("DESIGN: a recorded coding-agent reply (prose before the JSON) keeps the rules brief where the model left it out", async () => {
    const { f, set } = setOf(CODING_AGENT);
    const out = await designSolutionWords({ subject: f.subject, set, model: routed(recorded("coding")).model, models: DEFAULT_MODELS });
    expect(out.options[0]!.kind).toBe("setup");
    expect(out.options[0]!.what).toMatch(/Claude Code/);
    const tool = out.options[1]!;
    const ruleTool = set.options[1]!;
    expect(tool.what).toMatch(/supervisor/);
    expect(tool.handoff).toEqual(ruleTool.handoff);
    expect(figures(out)).toEqual(figures(set));
  });

  test("DESIGN: a reply with a digit, a new kind, a reorder, a figure or an extra key is ignored whole", () => {
    const { set } = setOf(LINKEDIN_IMAGE);
    const good = JSON.parse(JSON.parse(readFileSync(join(import.meta.dir, "recorded", "linkedin.json"), "utf8")).reply) as { options: Array<Record<string, unknown>> };
    const variants: Array<(o: typeof good) => void> = [
      (o) => (o.options[0]!.what = "Saves 3 hours a week"),
      (o) => (o.options[0]!.kind = "magic"),
      (o) => o.options.reverse(),
      (o) => (o.options[0]!.weeklyHoursSaved = 40),
      (o) => o.options.pop(),
      (o) => ((o.options[1] as Record<string, unknown>).brief = { inputs: ["x"] }),
      (o) => ((o.options[0]!.brief as Record<string, unknown>).acceptance = []),
      (o) => (o.options[0]!.why = "<script>"),
    ];
    for (const change of variants) {
      const bad = structuredClone(good);
      change(bad);
      expect(applySolutionDesign(set, JSON.stringify(bad))).toBeNull();
    }
    expect(applySolutionDesign(set, "not json")).toBeNull();
    expect(applySolutionDesign(set, JSON.stringify(good))).not.toBeNull();
  });

  test("DESIGN: when the reply is invalid the router escalation check fails and the rules wording stands", async () => {
    const { f, set } = setOf(LINKEDIN_IMAGE);
    const { model } = routed('{"options":[]}');
    const out = await designSolutionWords({ subject: f.subject, set, model, models: DEFAULT_MODELS });
    expect(out.designedBy).toBe("rules");
    expect(out.options).toEqual(set.options);
  });

  test("DESIGN: a model that throws leaves the complete rules set", async () => {
    const { f, set } = setOf(CODING_AGENT);
    const boom = { complete: async () => Promise.reject(new Error("offline")) };
    expect(await designSolutionWords({ subject: f.subject, set, model: boom, models: DEFAULT_MODELS })).toEqual(set);
  });

  test("DESIGN: the prompt holds the masked profile and parts, the user context in its block, and no figure", () => {
    const { f, set } = setOf(LINKEDIN_IMAGE);
    const p = solutionDesignPrompt(f.subject, set, { role: "Founder" });
    expect(p).toContain("<task_profile>");
    expect(p).toContain("part: generate image on ChatGPT image chat [media_make]");
    expect(p).toMatch(/<user_context[^>]*>\nrole: Founder\n<\/user_context>/);
    const baseline = p.split("<baseline>")[1]!;
    expect(baseline).not.toContain("weeklyHoursSaved");
    expect(baseline).not.toContain("confidence");
    expect(baseline).not.toMatch(/\d/);
  });

  test("DESIGN: the stub model echoes the baseline: the rules set, worded by rules", async () => {
    const { f, set } = setOf(CODING_AGENT);
    const out = await designSolutionWords({ subject: f.subject, set, model: new StubModel(), models: DEFAULT_MODELS });
    expect(out).toEqual(set);
  });

  test("DESIGN: the system prompt is domain-neutral (no email or outreach default)", () => {
    expect(SOLUTION_DESIGN_SYSTEM).toMatch(/Do not assume it is about email or sales/);
    expect(SOLUTION_DESIGN_SYSTEM).not.toMatch(/investor|recipient|outreach/i);
  });
});
