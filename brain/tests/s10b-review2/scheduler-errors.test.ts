// s10b N2 (REVIEW-2): one failing workflow never stops the others. Any error marks the slot as handled, records the
// reason on the workflow (needs_you), and is not retried until the next slot: no model re-call every 30 s.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DashboardResponse, WorkflowSummaryDTO } from "../../src/api/types.ts";
import { readWorkflow, workflowDir, writeWorkflow } from "../../src/workflows/store.ts";
import type { S09bWorld } from "../s09b-brain/setup.ts";
import { activeWorld, live, MON_0900, tick, TUE_0900 } from "./setup.ts";

let w: S09bWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

/** A copy of the outreach workflow under an id that sorts first, so the scheduler reaches it before the original. */
function cloneFirst(x: S09bWorld, id = "wf_0000aaaa"): string {
  cpSync(workflowDir(x.home, x.outreach.id), workflowDir(x.home, id), { recursive: true });
  const wf = readWorkflow(x.home, id)!;
  writeWorkflow(x.home, { ...wf, id });
  return id;
}

describe("s10b N2: scheduler errors stay per workflow", () => {
  test("N2: a broken recipient list in one workflow does not stop the next one", async () => {
    w = await activeWorld();
    const bad = cloneFirst(w);
    writeFileSync(join(workflowDir(w.home, bad), "recipients.csv"), "name,org\nAna,Fund\n");
    const r = await tick(w, MON_0900);
    expect(r.failed.map((f) => f.workflowId)).toEqual([bad]);
    expect(r.failed[0]!.reason).toContain("email column");
    expect(r.started.map((s) => s.workflowId)).toEqual([w.outreach.id]);
    expect(live(w)).toHaveLength(1);
    expect(readWorkflow(w.home, bad)!.lastScheduledAt).toBe(MON_0900);
  });

  test("N2: a corrupt workflow.json does not stop the others", async () => {
    w = await activeWorld();
    const bad = cloneFirst(w);
    writeFileSync(join(workflowDir(w.home, bad), "workflow.json"), "{not json");
    const r = await tick(w, MON_0900);
    expect(r.started.map((s) => s.workflowId)).toEqual([w.outreach.id]);
    expect((await w.call<{ workflows: WorkflowSummaryDTO[] }>("/workflows")).status).toBe(200);
  });

  test("N2: a model failure marks the slot and backs off: no model call again until the next slot", async () => {
    w = await activeWorld();
    let calls = 0;
    const orig = w.model.complete.bind(w.model);
    w.model.complete = async (req) => {
      if (req.role === "draft") {
        calls += 1;
        throw new Error("model claude-opus-5-5 (draft) failed: error_during_execution");
      }
      return orig(req);
    };
    const r = await tick(w, MON_0900);
    expect(r.failed).toHaveLength(1);
    expect(calls).toBe(1);
    await tick(w, MON_0900 + 30_000);
    await tick(w, MON_0900 + 60_000);
    await tick(w, MON_0900 + 3_600_000);
    expect(calls).toBe(1);
    expect(readWorkflow(w.home, w.outreach.id)!.lastRunError).toMatchObject({ at: MON_0900 });
    await tick(w, TUE_0900);
    expect(calls).toBe(2);
  });

  test("N2: the failure shows as needs_you with the reason, and clears after the next good run", async () => {
    w = await activeWorld();
    const orig = w.model.complete.bind(w.model);
    let fail = true;
    w.model.complete = async (req) => {
      if (req.role === "draft" && fail) throw new Error("model claude-opus-5-5 (draft) failed: error_during_execution");
      return orig(req);
    };
    await tick(w, MON_0900);
    const a = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(a.state).toBe("needs_you");
    expect(a.needsYou.join(" ")).toContain("The last scheduled run did not finish: model claude-opus-5-5 (draft) failed: error_during_execution.");
    expect((await w.call<WorkflowSummaryDTO>(`/workflows/${w.outreach.id}`)).body.lastRunError?.reason).toContain("error_during_execution");
    fail = false;
    await tick(w, TUE_0900);
    expect(readWorkflow(w.home, w.outreach.id)!.lastRunError ?? null).toBeNull();
    const b = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(b.needsYou.join(" ")).not.toContain("did not finish");
  });

  test("N2: the recorded reason carries no addresses or quoted content", async () => {
    w = await activeWorld();
    w.model.complete = async () => {
      throw new Error('could not draft "Dear Ana, our secret raise" for ana@fund.vc');
    };
    await tick(w, MON_0900);
    const reason = readWorkflow(w.home, w.outreach.id)!.lastRunError!.reason;
    expect(reason).not.toContain("ana@fund.vc");
    expect(reason).not.toContain("secret raise");
    expect(readFileSync(join(workflowDir(w.home, w.outreach.id), "workflow.json"), "utf8")).not.toContain("secret raise");
  });
});
