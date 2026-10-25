// s09b: AutomationDTO.taskId, and needsYou reasons written as full sentences for a person.
import { afterEach, describe, expect, test } from "bun:test";
import type { ApproveResponse, DashboardResponse, DryRunResponse, RunResponse, WorkflowsResponse } from "../../src/api/types.ts";
import { stateOf } from "../../src/workflows/service.ts";
import { updateWorkflow } from "../../src/workflows/store.ts";
import { writeRecipients } from "../s05-workflows/setup.ts";
import { connectGmail, s09bWorld, type S09bWorld } from "./setup.ts";

let w: S09bWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const SENTENCE = /^[A-Z][^\n]*[.]$/;

async function activate(x: S09bWorld): Promise<void> {
  const dry = await x.call<DryRunResponse>(`/workflows/${x.outreach.id}/dry-run`, { method: "POST", body: { limit: 1 } });
  expect((await x.call<ApproveResponse>(`/workflows/${x.outreach.id}/approve`, { method: "POST", body: { batchHash: dry.body.batchHash } })).body.result).toBe("activated");
}

describe("s09b dashboard: taskId", () => {
  test("TASKID: every automation carries the workflow's taskId (same as its insight's)", async () => {
    w = await s09bWorld();
    const d = await w.call<DashboardResponse>("/dashboard");
    const a = d.body.automations.find((x) => x.id === w!.outreach.id)!;
    expect(a.taskId).toBe(w.outreach.taskId);
    expect(a.taskId).toBe(w.analysis.insights[0]!.taskId);
    const list = await w.call<WorkflowsResponse>("/workflows");
    expect(list.body.workflows[0]!.taskId).toBe(a.taskId);
  });
});

describe("s09b needsYou sentences", () => {
  test("NEEDSYOU: a missing Gmail reads 'Connect Gmail so this can send.'", async () => {
    w = await s09bWorld();
    await activate(w);
    const a = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(a.state).toBe("needs_you");
    expect(a.needsYou).toEqual(["Connect Gmail so this can send."]);
  });

  test("NEEDSYOU: a pending batch reads 'A new batch of N is ready for review.'", async () => {
    w = await s09bWorld();
    connectGmail(w.home);
    await activate(w);
    writeRecipients(w.home, w.outreach.id, ["ana@fund.vc,Ana,Lee,Fund VC,", "bo@seed.vc,Bo,Kim,Seed VC,"]);
    const run = await w.call<RunResponse>(`/workflows/${w.outreach.id}/run`, { method: "POST" });
    expect(run.status).toBe(201);
    const a = (await w.call<DashboardResponse>("/dashboard")).body.automations[0]!;
    expect(a.needsYou).toEqual(["A new batch of 2 is ready for review."]);
    const s = (await w.call<WorkflowsResponse>("/workflows")).body.workflows[0]!;
    expect(s.needsYou).toEqual(a.needsYou);
  });

  test("NEEDSYOU: every reason starts with a capital and ends with a full stop (env var missing, log and other connectors)", async () => {
    w = await s09bWorld();
    const wf = updateWorkflow(w.home, w.outreach.id, (x) => {
      x.status = "active";
      x.activatedAt = 1;
      x.connectors = [...x.connectors, { id: "google-calendar", required: true }];
    }, 1);
    const conns = [
      { id: "gmail", name: "Gmail", how: "gmail-mcp" as const, required: true, status: "missing_env" as const },
      { id: "google-sheets", name: "Google Sheets", how: "composio:googlesheets" as const, required: true, status: "missing" as const },
      { id: "google-calendar", name: "Google Calendar", how: "composio:googlecalendar" as const, required: true, status: "missing" as const },
    ];
    const { needsYou } = stateOf(wf, conns, null);
    expect(needsYou.length).toBe(3);
    for (const r of needsYou) expect(r).toMatch(SENTENCE);
    expect(needsYou[0]).toBe("Connect Gmail so this can send. Its sign-in setting is not set yet.");
    expect(needsYou[1]).toBe("Connect Google Sheets so this can log what it sent.");
    expect(needsYou[2]).toBe("Connect Google Calendar so this can run.");
  });
});
