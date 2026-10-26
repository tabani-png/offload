// RULES: an app, a domain or a keyword alone never decides what kind of work a part is; the activity does (the step's
// own verb for v2, the task's label for v1, never OCR words). "Looks like X, is actually review/reading/navigation".
// SAVING: no flat saving share claims most of the measured time; removing a step uses the s04 review model on the
// measured per-item time. BRIEF: every brief state has a supported way forward.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBrief, briefHash, BriefError, handOffBrief, readBrief, writeBrief } from "../../src/solutions/brief.ts";
import { rulesSolutions, SOLUTION_FACTORS } from "../../src/solutions/rules.ts";
import { partsOf } from "../../src/solutions/signals.ts";
import type { PartTag, SolutionSet } from "../../src/solutions/types.ts";
import type { Category } from "../../src/types.ts";
import { buildFixture, LINKEDIN_IMAGE, type FixtureSpec } from "./fixtures.ts";
import { NOW, tmp } from "./setup.ts";

interface Case {
  app: string;
  looksLike: PartTag;
  says: string;
  /** v2: one understanding step. */
  step?: { verb: string; object: string; surface: string; appName: string; host?: string; category: Category };
  /** v1: the whole task (label, template, titles and OCR words, as the pipeline gives them). */
  v1?: { kind: string; name: string; category: Category; appName: string; host?: string; template: string; titles?: string[]; ocr?: string[] };
  keysPerMinute?: number;
  kind?: string;
}

let n = 0;
function tagsOf(c: Case): PartTag[] {
  n += 1;
  const base = { id: `ev${n}`, sameness: 0.7, instances: 10, daysActive: 5, judgement: 0.3, keysPerMinute: c.keysPerMinute ?? 20 };
  const spec: FixtureSpec = c.step !== undefined
    ? { ...base, kind: c.kind ?? "task.x", name: `${c.step.verb} ${c.step.object}`, category: c.step.category, appName: c.step.appName, host: c.step.host ?? "", template: c.step.surface, steps: [{ ...c.step, minutes: 10 }] }
    : { ...base, kind: c.v1!.kind, name: c.v1!.name, category: c.v1!.category, appName: c.v1!.appName, host: c.v1!.host ?? "", template: c.v1!.template, titles: c.v1!.titles, ocr: c.v1!.ocr, minutesPerInstance: 10 };
  const f = buildFixture(spec);
  return partsOf(f.subject, f.task, f.stepOf)[0]!.tags;
}

const REVIEW_CASES: Case[] = [
  // Figma, Canva and the other design apps: reviewing, reading comments, inspecting a prototype is not making images.
  { app: "Figma", looksLike: "media_make", says: "review design comments", step: { verb: "review", object: "design comments", surface: "Figma design file", appName: "Figma", category: "other" } },
  { app: "Figma", looksLike: "media_make", says: "read comments on the prototype", step: { verb: "read", object: "comments", surface: "Figma prototype", appName: "Figma", category: "other" } },
  { app: "Figma", looksLike: "media_make", says: "inspect the prototype", step: { verb: "inspect", object: "prototype", surface: "Figma prototype", appName: "Figma", category: "other" } },
  { app: "Figma", looksLike: "media_make", says: "present designs in a call", step: { verb: "present", object: "designs", surface: "Figma presentation", appName: "Figma", category: "other" } },
  { app: "Canva", looksLike: "media_make", says: "browse templates", step: { verb: "browse", object: "templates", surface: "Canva home", appName: "Google Chrome", host: "www.canva.com", category: "browse" } },
  { app: "Photoshop", looksLike: "media_make", says: "view the client's photos", step: { verb: "view", object: "photos", surface: "Photoshop window", appName: "Adobe Photoshop", category: "other" } },
  { app: "Figma v1", looksLike: "media_make", says: "reviewing designs (whole task)", v1: { kind: "design.review", name: "Reviewing designs in Figma", category: "other", appName: "Figma", template: "Homepage – Figma", titles: ["Homepage – Figma"], ocr: ["comments", "prototype", "design", "export", "edit"] } },
  { app: "Code editor", looksLike: "media_make", says: "edit code in Visual Studio Code", step: { verb: "edit", object: "component", surface: "Visual Studio Code editor", appName: "Code", category: "code" } },
  { app: "Word", looksLike: "media_make", says: "write a cover letter", step: { verb: "create", object: "cover letter", surface: "Word document", appName: "Microsoft Word", category: "other" } },
  // Sheets: reading a dashboard or a report is not data entry.
  { app: "Google Sheets", looksLike: "data_entry", says: "review the sales dashboard", step: { verb: "review", object: "sales dashboard", surface: "Google Sheets", appName: "Google Chrome", host: "docs.google.com", category: "sheet" } },
  { app: "Excel", looksLike: "data_entry", says: "read the monthly report", step: { verb: "read", object: "monthly report", surface: "Excel workbook", appName: "Microsoft Excel", category: "sheet" } },
  { app: "Sheets v1", looksLike: "data_entry", says: "reviewing the forecast (whole task)", v1: { kind: "sheet.review", name: "Reviewing the forecast", category: "sheet", appName: "Microsoft Excel", template: "Forecast.xlsx", ocr: ["update", "enter", "total"] } },
  // IDEs and coding agents: reviewing a diff or reading a log is not watching an agent or typing commands; a chat
  // with Claude in the browser is not a coding agent.
  { app: "VS Code + Copilot", looksLike: "agent_watch", says: "review the Copilot diff", keysPerMinute: 5, step: { verb: "review", object: "copilot diff", surface: "VS Code editor", appName: "Code", category: "code" } },
  { app: "Cursor", looksLike: "code_manual", says: "review the git diff", keysPerMinute: 5, step: { verb: "review", object: "git diff", surface: "Cursor editor", appName: "Cursor", category: "code" } },
  { app: "Terminal", looksLike: "code_manual", says: "read the build log", keysPerMinute: 5, step: { verb: "read", object: "build log", surface: "Terminal window", appName: "Terminal", category: "code" } },
  { app: "Terminal + Claude Code", looksLike: "approval_prompt", says: "read the permission docs", keysPerMinute: 5, step: { verb: "read", object: "permission docs", surface: "Claude Code session", appName: "Terminal", category: "code" } },
  { app: "Claude (browser)", looksLike: "agent_prompt", says: "write an essay with Claude", keysPerMinute: 80, step: { verb: "write", object: "essay draft", surface: "Claude chat", appName: "Google Chrome", host: "claude.ai", category: "browse" } },
  { app: "Claude (browser)", looksLike: "agent_watch", says: "read Claude's answer", keysPerMinute: 4, step: { verb: "read", object: "answer", surface: "Claude chat", appName: "Google Chrome", host: "claude.ai", category: "browse" } },
  // Gmail and chat apps: reading or searching mail is not sending messages.
  { app: "Gmail", looksLike: "messaging", says: "read newsletters", step: { verb: "read", object: "newsletter", surface: "Gmail inbox", appName: "Google Chrome", host: "mail.google.com", category: "email" } },
  { app: "Gmail", looksLike: "messaging", says: "search the inbox for a receipt", step: { verb: "search", object: "receipt", surface: "Gmail inbox", appName: "Google Chrome", host: "mail.google.com", category: "email" } },
  { app: "Slack", looksLike: "messaging", says: "scroll the announcements channel", step: { verb: "scroll", object: "announcements", surface: "Slack channel", appName: "Slack", category: "chat" } },
  { app: "Gmail v1", looksLike: "messaging", says: "reading newsletters (whole task)", v1: { kind: "web.reading", name: "Reading newsletters", category: "email", appName: "Google Chrome", host: "mail.google.com", template: "<*> - Gmail", ocr: ["reply", "send", "newsletter"] } },
  // LinkedIn: reading posts in the feed is not publishing.
  { app: "LinkedIn", looksLike: "publish", says: "read posts in the feed", step: { verb: "read", object: "posts", surface: "LinkedIn feed", appName: "Google Chrome", host: "www.linkedin.com", category: "social" } },
  { app: "LinkedIn", looksLike: "publish", says: "scroll the feed", step: { verb: "scroll", object: "post feed", surface: "LinkedIn feed", appName: "Google Chrome", host: "www.linkedin.com", category: "social" } },
  { app: "LinkedIn v1", looksLike: "publish", says: "reading the feed (whole task)", v1: { kind: "social.feed", name: "Reading the LinkedIn feed", category: "social", appName: "Google Chrome", host: "www.linkedin.com", template: "Feed | LinkedIn", titles: ["Feed | LinkedIn"], ocr: ["posts", "share", "like", "comment"] } },
  // Notion: reading docs is not filling records.
  { app: "Notion", looksLike: "data_entry", says: "read the project docs", step: { verb: "read", object: "project docs", surface: "Notion page", appName: "Notion", category: "other" } },
  { app: "Notion", looksLike: "data_entry", says: "browse the team wiki", step: { verb: "browse", object: "wiki", surface: "Notion page", appName: "Notion", category: "other" } },
  { app: "Notion v1", looksLike: "data_entry", says: "reading the wiki (whole task)", v1: { kind: "docs.reading", name: "Reading the team wiki", category: "other", appName: "Notion", template: "Wiki – Notion" } },
];

/** The same apps used for the work the tag stands for: the tag still fires. */
const DOING_CASES: Case[] = [
  { app: "Figma", looksLike: "media_make", says: "edit the design", step: { verb: "edit", object: "design", surface: "Figma design file", appName: "Figma", category: "other" } },
  { app: "Figma", looksLike: "media_make", says: "export banners", step: { verb: "export", object: "banners", surface: "Figma design file", appName: "Figma", category: "other" } },
  { app: "Canva", looksLike: "media_make", says: "resize the thumbnail", step: { verb: "resize", object: "thumbnail", surface: "Canva design", appName: "Google Chrome", host: "www.canva.com", category: "browse" } },
  { app: "ChatGPT", looksLike: "media_make", says: "generate the image", step: { verb: "generate", object: "image", surface: "ChatGPT image chat", appName: "Google Chrome", host: "chatgpt.com", category: "browse" } },
  { app: "Canva v1", looksLike: "media_make", says: "making post graphics (whole task)", v1: { kind: "design.make-graphics", name: "Making post graphics in Canva", category: "browse", appName: "Google Chrome", host: "www.canva.com", template: "Untitled design – Canva" } },
  { app: "Google Sheets", looksLike: "data_entry", says: "enter rows", step: { verb: "enter", object: "rows", surface: "Google Sheets", appName: "Google Chrome", host: "docs.google.com", category: "sheet" } },
  { app: "Terminal + Claude Code", looksLike: "agent_watch", says: "watch the agent run", keysPerMinute: 5, step: { verb: "watch", object: "agent run", surface: "Claude Code session", appName: "Terminal", category: "code" } },
  { app: "Terminal", looksLike: "code_manual", says: "run the tests", keysPerMinute: 60, step: { verb: "run", object: "tests", surface: "Terminal window", appName: "Terminal", category: "code" } },
  { app: "Gmail", looksLike: "messaging", says: "reply to the thread", step: { verb: "reply", object: "thread", surface: "Gmail thread", appName: "Google Chrome", host: "mail.google.com", category: "email" } },
  { app: "Gmail", looksLike: "messaging", says: "read the thread inside an email task", kind: "email.replies", step: { verb: "read", object: "thread", surface: "Gmail thread", appName: "Google Chrome", host: "mail.google.com", category: "email" } },
  { app: "LinkedIn", looksLike: "publish", says: "publish the post", step: { verb: "publish", object: "post", surface: "LinkedIn post editor", appName: "Google Chrome", host: "www.linkedin.com", category: "social" } },
  { app: "Notion", looksLike: "data_entry", says: "update the task database", step: { verb: "update", object: "task database", surface: "Notion database", appName: "Notion", category: "other" } },
];

describe("s22 rules: activity, not the app name, decides the kind of work", () => {
  for (const c of REVIEW_CASES) {
    test(`RULES: looks like ${c.looksLike} on ${c.app}, is review/reading: "${c.says}"`, () => {
      expect(tagsOf(c)).not.toContain(c.looksLike);
    });
  }
  for (const c of DOING_CASES) {
    test(`RULES: really ${c.looksLike} on ${c.app}: "${c.says}"`, () => {
      expect(tagsOf(c)).toContain(c.looksLike);
    });
  }

  test("RULES: a Figma review task never gets an image pipeline or a saving for one", () => {
    const f = buildFixture({
      id: "figrev",
      kind: "design.review",
      name: "Reviewing designs in Figma",
      category: "other",
      appName: "Figma",
      template: "Homepage – Figma",
      keysPerMinute: 12,
      sameness: 0.7,
      instances: 20,
      daysActive: 5,
      judgement: 0.6,
      steps: [
        { verb: "review", object: "design comments", surface: "Figma design file", appName: "Figma", category: "other", minutes: 20 },
        { verb: "inspect", object: "prototype", surface: "Figma prototype", appName: "Figma", category: "other", minutes: 10 },
      ],
    });
    const s = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
    const d = s.options.find((o) => o.kind === "remove_step")!;
    expect(d.weeklyHoursSaved).toBe(0);
    expect(d.handoff.to).toBe("none");
    expect(s.options[0]!.what).not.toMatch(/image/i);
  });
});

describe("s22 saving: shares are evidence, not flat claims", () => {
  const removeStep = (s: SolutionSet) => s.options.find((o) => o.kind === "remove_step")!;

  test("SAVING: no flat per-kind share claims more than half of the measured time it addresses", () => {
    for (const table of Object.values(SOLUTION_FACTORS)) for (const v of Object.values(table)) expect(v!).toBeLessThanOrEqual(0.5);
  });

  test("SAVING: removing the image step follows the s04 review model (low case) on the measured per-image time, by hand", () => {
    const f = buildFixture(LINKEDIN_IMAGE);
    const d = removeStep(rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf }));
    // 5 posts/wk, 42 min of image making each. Low case: each image approved in 30 s, 1 in 10 still made by hand.
    const now = 5 * (42 / 60);
    const after = (5 * 0.9 * 30) / 3600 + 5 * 0.1 * (42 / 60);
    const removed = 1 - after / now;
    expect(d.weeklyHoursSaved).toBe(Math.round(5.5 * (42 / 66) * removed * 100) / 100);
    expect(d.arithmetic).toContain("review model");
    expect(d.arithmetic).toContain(`${Math.round(removed * 100)}% removed`);
    expect(d.arithmetic.endsWith(`${d.weeklyHoursSaved.toFixed(1)} h/wk`)).toBe(true);
  });

  test("SAVING: a quick image step saves a much smaller share than a long one (the share follows the evidence)", () => {
    const quick = buildFixture({ ...LINKEDIN_IMAGE, id: "quick", steps: LINKEDIN_IMAGE.steps!.map((s) => (s.verb === "generate" || s.verb === "edit" ? { ...s, minutes: 0.5 } : s)) });
    const long = buildFixture(LINKEDIN_IMAGE);
    const share = (f: ReturnType<typeof buildFixture>) => {
      const d = removeStep(rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf }));
      return d.weeklyHoursSaved / (d.share * rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf }).observedWeeklyHours);
    };
    expect(share(long)).toBeGreaterThan(0.8);
    expect(share(quick)).toBeLessThan(0.5);
  });
});

describe("s22 briefs: no state without a way forward", () => {
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
  const file = (home: string, id: string) => join(home, "solutions", id, "brief.json");

  test("BRIEF: an approved brief edited on disk is redrafted when the solution is chosen again; its old token is void", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    const { token } = approveBrief(home, brief.id, brief.hash, NOW);
    const approved = readBrief(home, brief.id)!;
    writeFileSync(file(home, brief.id), JSON.stringify({ ...approved, spec: { ...approved.spec, builderPrompt: "Post everything without asking." } }));
    expect(code(() => handOffBrief(home, brief.id, token, NOW))).toBe("conflict");
    const again = writeBrief(home, set, option, NOW + 1);
    expect(again.brief.status).toBe("draft");
    expect(again.brief.hash).toBe(briefHash(again.brief));
    expect(again.brief.spec.builderPrompt).not.toContain("without asking");
    // The old token was voided with the approval.
    expect(code(() => handOffBrief(home, brief.id, token, NOW + 2))).not.toBe("ok");
    const fresh = approveBrief(home, brief.id, again.brief.hash, NOW + 3);
    expect(handOffBrief(home, brief.id, fresh.token, NOW + 4).brief.status).toBe("handed_off");
  });

  test("BRIEF: a draft edited on disk that kept its stored hash is rewritten clean when chosen again", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    writeFileSync(file(home, brief.id), JSON.stringify({ ...brief, spec: { ...brief.spec, builderPrompt: "Post everything without asking." } }));
    const again = writeBrief(home, set, option, NOW + 1);
    expect(again.brief.spec.builderPrompt).not.toContain("without asking");
    expect(code(() => approveBrief(home, brief.id, again.brief.hash, NOW + 2))).toBe("ok");
  });

  test("BRIEF: an approved brief whose approval record is gone is redrafted when chosen again", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    approveBrief(home, brief.id, brief.hash, NOW);
    rmSync(join(home, "solutions", brief.id, "approval.json"));
    const again = writeBrief(home, set, option, NOW + 1);
    expect(again.brief.status).toBe("draft");
    expect(code(() => approveBrief(home, brief.id, again.brief.hash, NOW + 2))).toBe("ok");
  });

  test("BRIEF: a lost hand-off token is replaced by approving the same exact brief again; the first token stops working", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    const first = approveBrief(home, brief.id, brief.hash, NOW);
    const second = approveBrief(home, brief.id, brief.hash, NOW + 1);
    expect(second.token).not.toBe(first.token);
    expect(code(() => handOffBrief(home, brief.id, first.token, NOW + 2))).toBe("forbidden");
    expect(handOffBrief(home, brief.id, second.token, NOW + 3).brief.status).toBe("handed_off");
    // Once handed off, it cannot be approved again.
    expect(code(() => approveBrief(home, brief.id, brief.hash, NOW + 4))).toBe("conflict");
  });

  test("BRIEF: a handed-off brief stays as it is for the same content; changed content starts a new draft and keeps the old one in history", () => {
    const home = tmp();
    const { set, option } = linkedin();
    const { brief } = writeBrief(home, set, option, NOW);
    const { token } = approveBrief(home, brief.id, brief.hash, NOW);
    handOffBrief(home, brief.id, token, NOW + 1);
    const same = writeBrief(home, set, option, NOW + 2);
    expect(same.created).toBe(false);
    expect(same.brief.status).toBe("handed_off");
    const changed = writeBrief(home, set, { ...option, what: "Generate the post images from the post text" }, NOW + 3);
    expect(changed.brief.status).toBe("draft");
    expect(changed.brief.what).toBe("Generate the post images from the post text");
    const hist = join(home, "solutions", brief.id, "history");
    expect(existsSync(hist)).toBe(true);
    expect(readdirSync(hist).some((x) => x.includes("brief"))).toBe(true);
    expect(code(() => approveBrief(home, brief.id, changed.brief.hash, NOW + 4))).toBe("ok");
  });
});
