// s05 AC-3: the drafter writes a reviewable workflow folder for an insight.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { draftWorkflow, NotFoundError, templateFor } from "../../src/workflows/drafter.ts";
import { readWorkflow } from "../../src/workflows/store.ts";
import { world, NOW, type World } from "./setup.ts";

let w: World;
beforeAll(async () => {
  w = await world();
});
afterAll(() => w.cleanup());

describe("s05 workflow drafter", () => {
  test("insight #1 (outreach) becomes the investor outreach workflow, ready for review, auto-run off", () => {
    const wf = w.outreach;
    expect(wf.id).toMatch(/^wf_[a-z0-9]+$/);
    expect(wf.template).toBe("investor_outreach");
    expect(wf.status).toBe("ready_for_review");
    expect(wf.autoRun).toBe(false);
    expect(wf.bucket).toBe("investor_outreach");
    expect(wf.models).toEqual({ draft: "claude-opus-5-5", cheap: "claude-sonnet-5-5" });
  });

  test("steps are typed read → read → draft → approval_gate → send → log, with a connector per step", () => {
    expect(w.outreach.steps.map((s) => s.type)).toEqual(["read", "read", "draft", "approval_gate", "send", "log"]);
    const send = w.outreach.steps.find((s) => s.type === "send")!;
    expect(send.connector).toBe("gmail");
    expect(send.sideEffect).toBe(true);
    expect(w.outreach.steps.find((s) => s.type === "log")?.connector).toBe("google-sheets");
    expect(w.outreach.connectors).toEqual([
      { id: "gmail", required: true },
      { id: "google-sheets", required: false },
    ]);
    expect(w.outreach.schedule).toMatchObject({ type: "cron", cron: "0 9 * * 1-5" });
  });

  test("SKILL.md has frontmatter (name, description, connectors, gates) and plain-word steps", () => {
    const skill = readFileSync(join(w.home, "workflows", w.outreach.id, "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: investor-outreach-emails\n")).toBe(true);
    expect(skill).toContain("connectors: [gmail, google-sheets]");
    expect(skill).toContain("gates: [review]");
    expect(skill).toContain("auto_run: off");
    expect(skill).toContain("1. **Read the investor list**");
    expect(skill).toContain("4. **You review the batch**");
    expect(skill).toContain(w.outreach.estimate.arithmetic);
  });

  test("the folder has facts.md, recipients.csv, crm-log.csv and runnable scripts, all private", () => {
    const dir = join(w.home, "workflows", w.outreach.id);
    for (const f of ["facts.md", "recipients.csv", "crm-log.csv", "scripts/recipients.ts", "scripts/crm-log.ts", "workflow.json"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(readFileSync(join(dir, "facts.md"), "utf8")).toContain("company: Acme");
    expect(statSync(join(dir, "workflow.json")).mode & 0o077).toBe(0);
    const r = Bun.spawnSync(["bun", join(dir, "scripts/recipients.ts"), join(dir, "recipients.csv")]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual([]);
  });

  test("the estimate is the insight's arithmetic, copied (no model numbers)", () => {
    const ins = w.analysis.insights[0]!;
    expect(w.outreach.estimate.arithmetic).toBe(ins.saving.arithmetic);
    expect(w.outreach.estimate.weeklyHoursSaved).toBe(ins.saving.weeklyHoursSaved);
  });

  test("drafting again returns the same workflow unchanged; unknown insight is NotFound", () => {
    const again = draftWorkflow({ home: w.home, analysis: w.analysis, insightId: w.outreach.insightId, now: () => NOW + 1 });
    expect(again.created).toBe(false);
    expect(again.workflow.createdAt).toBe(NOW);
    expect(() => draftWorkflow({ home: w.home, analysis: w.analysis, insightId: "ins_nope" })).toThrow(NotFoundError);
  });

  test("scheduling insights get the scheduling template with Gmail and Calendar", () => {
    expect(templateFor("email.scheduling")).toBe("scheduling_reply");
    expect(templateFor("sheet.updates")).toBe("generic");
    const sched = w.analysis.insights.find((i) => i.label.kind === "email.scheduling")!;
    const { workflow } = draftWorkflow({ home: w.home, analysis: w.analysis, insightId: sched.id, now: () => NOW });
    expect(workflow.connectors.map((c) => c.id)).toEqual(["gmail", "google-calendar"]);
    expect(readWorkflow(w.home, workflow.id)?.status).toBe("ready_for_review");
  });
});
