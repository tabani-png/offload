// AC-5 INSIGHTS and AC-6 CONTEXT: reach, Labeler/Judge interfaces in v2, user context as context only.
import { describe, expect, test } from "bun:test";
import { analyzeHome } from "../../src/analyze.ts";
import { defaultLabeler, type LabelContext, type Labeler } from "../../src/grouping/group.ts";
import type { Judge, JudgeInput } from "../../src/insights/judge.ts";
import { estimateSaving } from "../../src/insights/saving.ts";
import type { TaskProfile } from "../../src/types.ts";
import { buildJudgePrompt, buildLabelerPrompt, PromptLabeler, sanitizeUserContext } from "../../src/understanding/context.ts";
import { COMPUTER_USE_REACH, connectorsForReach, estimateReach, LOCAL_FILE_REACH } from "../../src/understanding/reach.ts";
import { personaRun, reportNow } from "./setup.ts";

describe("INSIGHTS reach (domain-neutral)", () => {
  test("catalog connector, local file, computer use; task reach is the time-weighted mean", () => {
    const r = estimateReach([
      { app: "com.google.Chrome", host: "docs.google.com", urlPattern: "/spreadsheets/d/<id>/edit", activeMs: 2 },
      { app: "com.apple.Preview", host: "", urlPattern: "", activeMs: 1 },
      // s14 scope change: Xero is a catalog connector now (s16 commit schemas); a site no catalog entry knows stands in.
      { app: "com.google.Chrome", host: "portal.example-erp.test", urlPattern: "/AccountsPayable/Edit.aspx", activeMs: 1 },
    ]);
    expect(r.perSurface.map((s) => [s.via, s.connectorId, s.reach])).toEqual([
      ["catalog", "google-sheets", 0.9],
      ["local_file", null, LOCAL_FILE_REACH],
      ["computer_use", null, COMPUTER_USE_REACH],
    ]);
    expect(r.value).toBeCloseTo((2 * 0.9 + 0.8 + 0.35) / 4, 3);
    const m = connectorsForReach(r);
    expect(m.primary?.id).toBe("google-sheets");
    expect(m.reachability).toBe(r.value);
  });

  test("v2 insight figures come from the deterministic stats and saving code, with evidence ids", async () => {
    const { v2 } = await personaRun("bookkeeper");
    const top = v2.insights[0]!;
    const st = top.stats;
    const again = estimateSaving({ instances: st.instances.value, daysActive: st.daysActive.value, windowDays: v2.windowDays.length, medianMinutes: st.medianMinutes.value, eventIds: st.instances.eventIds });
    expect(top.saving.arithmetic).toBe(again.arithmetic);
    expect(top.score.factors.reachability).toBe(top.profile.understanding!.reach.value);
    expect(st.instances.eventIds.length).toBeGreaterThan(st.instances.value);
  });
});

describe("INSIGHTS custom Labeler and Judge keep working in v2", () => {
  test("a one-argument v1-style labeler and a custom judge are used; context reaches both", async () => {
    const { home, week } = await personaRun("support");
    const seen: { label: Array<LabelContext | undefined>; judge: JudgeInput["user"][] } = { label: [], judge: [] };
    const labeler: Labeler = {
      label(p: TaskProfile, ctx?: LabelContext) {
        seen.label.push(ctx);
        return { kind: "custom.kind", name: `custom ${p.appName}`, description: "x" };
      },
    };
    const judge: Judge = {
      judge(i: JudgeInput) {
        seen.judge.push(i.user);
        return { judgement: 0.1, risk: 0, reasons: ["custom"] };
      },
    };
    const user = { role: week.truth.role, industry: week.truth.industry };
    const a = await analyzeHome(home, { now: reportNow, understanding: "v2", labeler, judge, userContext: user });
    expect(a.insights[0]!.label.kind).toBe("custom.kind");
    expect(a.insights[0]!.judge.reasons).toEqual(["custom"]);
    expect(seen.label.every((c) => c?.user?.role === user.role)).toBe(true);
    expect(seen.judge.every((u) => u?.industry === user.industry)).toBe(true);
    // The v1 rules labeler still satisfies the interface with its one-argument signature.
    const v1 = await analyzeHome(home, { now: reportNow, labeler: defaultLabeler, userContext: user });
    expect(v1.tasks.length).toBeGreaterThan(0);
  });

  test("user context changes no number with the default labeler and judge", async () => {
    const { home, v2 } = await personaRun("recruiter");
    const withCtx = await analyzeHome(home, { now: reportNow, understanding: "v2", userContext: { role: "Recruiter", industry: "Staffing" } });
    const nums = (a: typeof v2) => a.insights.map((i) => [i.id, i.score.value, i.saving.arithmetic, i.stats.share.value, i.label.kind]);
    expect(nums(withCtx)).toEqual(nums(v2));
  });
});

describe("CONTEXT", () => {
  test("sanitised to one line of at most 80 chars; empty becomes undefined", () => {
    expect(sanitizeUserContext({ role: "  Book\nkeeper <b>", industry: "x".repeat(200) })).toEqual({ role: "Book keeper b", industry: "x".repeat(80) });
    expect(sanitizeUserContext({ role: "   " })).toBeUndefined();
    expect(sanitizeUserContext(null)).toBeUndefined();
    expect(sanitizeUserContext({ role: 5 })).toBeUndefined();
  });

  test("prompts carry the context only inside the marked block, and nothing without it", async () => {
    const { v2 } = await personaRun("bookkeeper");
    const p = v2.insights[0]!.profile;
    const withCtx = buildLabelerPrompt(p, { role: "Bookkeeper", industry: "Accounting" });
    const block = withCtx.match(/<user_context[^>]*>([\s\S]*?)<\/user_context>/);
    expect(block?.[1]).toContain("role: Bookkeeper");
    expect(withCtx.replace(block![0], "")).not.toContain("Bookkeeper");
    expect(buildLabelerPrompt(p)).not.toContain("user_context");
    expect(buildJudgePrompt({ profile: p, sameness: 0.5, user: { industry: "Accounting" } })).toContain("industry: Accounting");
    expect(withCtx).toContain("goal:");
    expect(withCtx).not.toMatch(/inv-\d+/i);
  });

  test("PromptLabeler: a valid reply names the task; numbers, bad kinds, junk and errors fall back to rules", async () => {
    const { v2 } = await personaRun("bookkeeper");
    const p = v2.insights[0]!.profile;
    const rules = { label: () => ({ kind: "task.rules", name: "Rules name", description: "rules" }) };
    const make = (reply: string | Error) => new PromptLabeler(async () => (reply instanceof Error ? Promise.reject(reply) : reply), rules);
    expect((await make('{"kind":"bookkeeping.enter-bill","name":"Enter supplier bills","description":"Bills from PDFs into Xero"}').label(p)).kind).toBe("bookkeeping.enter-bill");
    for (const bad of ['{"kind":"x.y","name":"Enter 140 bills","description":"d"}', '{"kind":"Bad Kind","name":"n","description":"d"}', "no json here", new Error("down")]) {
      expect((await make(bad).label(p)).kind).toBe("task.rules");
    }
  });
});
