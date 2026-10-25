// s10b N8 (REVIEW-2): names taken from window titles (the generic template's name, insight.name) leave workflow.json.
// They live in workflows/<id>/labels.json.enc, sealed under the capture day of the oldest instance they came from and
// purged with it; workflow.json keeps ids and fixed template text. After the purge the name falls back to the template.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { purgeAll } from "../../src/store/retention.ts";
import { draftWorkflow } from "../../src/workflows/drafter.ts";
import { displayName } from "../../src/workflows/labels.ts";
import { summaryOf } from "../../src/workflows/service.ts";
import { readWorkflow, workflowDir, writeWorkflow } from "../../src/workflows/store.ts";
import { sealedDay } from "../../src/store/vault.ts";
import { local } from "../s09b-brain/setup.ts";
import { world, type World } from "../s05-workflows/setup.ts";

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(() => w.cleanup());

const AT = local(2026, 10, 19, 12);
const sheet = () => w.analysis.insights.find((i) => i.label.kind === "sheet.updates")!;

describe("s10b N8: title-derived names are sealed and purged", () => {
  test("N8: workflow.json of a generic workflow holds no title-derived name", () => {
    const ins = sheet();
    expect(ins.label.name).toContain("Investor pipeline");
    const { workflow } = draftWorkflow({ home: w.home, analysis: w.analysis, insightId: ins.id, now: () => AT });
    const text = readFileSync(join(workflowDir(w.home, workflow.id), "workflow.json"), "utf8");
    expect(text).not.toContain("Investor pipeline");
    expect(workflow.name).toBe("Repeated task");
    expect(workflow.insight.name).toBe("");
    expect(readFileSync(join(workflowDir(w.home, workflow.id), "SKILL.md"), "utf8")).not.toContain("Investor pipeline");
  });

  test("N8: the summary shows the observed name from the sealed store, dated by the oldest instance", () => {
    const ins = sheet();
    const { workflow } = draftWorkflow({ home: w.home, analysis: w.analysis, insightId: ins.id, now: () => AT });
    const days = w.analysis.tasks.find((t) => t.id === ins.taskId)!.instances.map((i) => i.day).sort();
    const f = join(workflowDir(w.home, workflow.id), "labels.json.enc");
    expect(sealedDay(f)).toBe(days[0]!);
    expect(readFileSync(f, "utf8")).not.toContain("Investor pipeline");
    expect(summaryOf(w.home, workflow, {}, AT).name).toBe(ins.label.name);
  });

  test("N8: 8 days after the oldest capture the name is gone and the summary falls back to the template name", () => {
    const ins = sheet();
    const { workflow } = draftWorkflow({ home: w.home, analysis: w.analysis, insightId: ins.id, now: () => AT });
    const oldest = w.analysis.tasks.find((t) => t.id === ins.taskId)!.instances.map((i) => i.day).sort()[0]!;
    const [y, m, d] = oldest.split("-").map(Number) as [number, number, number];
    const later = local(y, m, d + 8, 12);
    purgeAll(w.home, later, { log: () => {} });
    expect(existsSync(join(workflowDir(w.home, workflow.id), "labels.json.enc"))).toBe(false);
    expect(displayName(w.home, workflow, later)).toBe("Repeated task");
    expect(summaryOf(w.home, readWorkflow(w.home, workflow.id)!, {}, later).name).toBe("Repeated task");
  });

  test("N8: an older workflow.json with a title-derived name is moved into the sealed store by the purge", () => {
    const ins = sheet();
    const { workflow } = draftWorkflow({ home: w.home, analysis: w.analysis, insightId: ins.id, now: () => AT });
    writeWorkflow(w.home, { ...workflow, name: ins.label.name, insight: { ...workflow.insight, name: ins.label.name } });
    purgeAll(w.home, AT, { log: () => {} });
    const text = readFileSync(join(workflowDir(w.home, workflow.id), "workflow.json"), "utf8");
    expect(text).not.toContain("Investor pipeline");
    expect(displayName(w.home, readWorkflow(w.home, workflow.id)!, AT)).toBe(ins.label.name);
  });

  test("N8: the outreach workflow keeps its fixed name and an empty insight name", () => {
    expect(w.outreach.name).toBe("Investor outreach emails");
    expect(w.outreach.insight.name).toBe("");
  });
});
