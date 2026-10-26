// s26 guards on the new and fixed steps: the live batch of a general plan says plainly what it needs and what is not
// built; a value changed on screen is never saved; the dry run claims no time for work it cannot do and keeps the old
// arithmetic when it can do every instance.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectedCommit } from "../../src/connectors/computer/actions.ts";
import { StubModel } from "../../src/models/model.ts";
import { NOTHING_TO_FILL } from "../../src/plan/dryrun.ts";
import { readItemRows, rowKey } from "../../src/workflows/plan-live.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { prepareLiveBatch, RunError } from "../../src/workflows/runner.ts";
import { readBatch } from "../../src/workflows/store.ts";
import { draftFor, freshHome, NOW as PERSONA_NOW } from "../s14-any-task-workflows/setup.ts";
import { activeMetricsWorkflow, itemsCsv, world, writeFirstDays, type World } from "./setup.ts";

let w: World | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

describe("s26 live batch guards", () => {
  test("LIVE: no live batch before the dry run is approved, nor while the workflow is paused", async () => {
    w = world();
    writeFirstDays(w.home);
    const ins = ((await w.call("/insights")).body.insights as any[]).find((i) => /Team metrics/.test(i.name));
    const wf = (await w.call(`/insights/${ins.id}/solutions/choose`, "POST", { kind: "workflow" })).body.workflow;
    writeFileSync(join(w.home, "workflows", wf.id, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    const early = await w.call(`/workflows/${wf.id}/run`, "POST", {});
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/approve a dry run first/);
    const d = await w.call(`/workflows/${wf.id}/dry-run`, "POST", { limit: 2 });
    await w.call(`/workflows/${wf.id}/approve`, "POST", { batchHash: d.body.batchHash });
    await w.call(`/workflows/${wf.id}/pause`, "POST", {});
    const paused = await w.call(`/workflows/${wf.id}/run`, "POST", {});
    expect(paused.status).toBe(409);
    expect(paused.body.message).toMatch(/paused/);
  });

  test("LIVE: the person's list is checked in plain words: header only, a column named twice, a short line, all rows done", async () => {
    w = world();
    const { id, dir } = await activeMetricsWorkflow(w);
    const run = async (csv: string) => {
      writeFileSync(join(dir, "items.csv"), csv);
      return w!.call(`/workflows/${id}/run`, "POST", {});
    };
    expect((await run("Week,Signups\n")).body.message).toMatch(/no rows to do yet/);
    expect((await run("Week,week\n1,2\n")).body.message).toMatch(/names the column "week" twice/);
    expect((await run("Week,Signups\n1\n")).body.message).toMatch(/line 2 of items\.csv has 1 values for 2 columns/);
    // Rows that are already done (same values) are never offered again.
    const done = rowKey(id, [["Week", "43"], ["Signups", "352"]]);
    writeFileSync(join(dir, "done-log.csv"), `date,email,subject,batch,status\n2026-10-14T20:00:00.000Z,${done},x,abc,sent\n`);
    const r = await run("Week,Signups\n43,352\n");
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/every row in items\.csv is done/);
  });

  test("LIVE: values are copied as written (quotes, commas, accents), the hash covers them, an empty cell stays empty with a warning", () => {
    const { labels, rows } = readItemRows('Name,Note\n"Zoë, Ltd","said ""ok"""\nAnn,\n', "items.csv");
    expect(labels).toEqual(["Name", "Note"]);
    expect(rows.map((r) => r.fields)).toEqual([
      [["Name", "Zoë, Ltd"], ["Note", 'said "ok"']],
      [["Name", "Ann"], ["Note", ""]],
    ]);
    expect(rowKey("wf_a", rows[0]!.fields)).not.toBe(rowKey("wf_b", rows[0]!.fields));
  });

  test("LIVE: a row's identity is its canonical form (the gate's): reordered columns, label case and spacing do not make a new row", () => {
    const a = rowKey("wf_a", [["Week", "43"], ["Signups", "352"]]);
    expect(rowKey("wf_a", [["Signups", "352"], ["Week", "43"]])).toBe(a);
    expect(rowKey("wf_a", [[" signups ", " 352 "], ["WEEK", "43"]])).toBe(a);
    // The gate's form check sees these two rows as the same commit, so they are the same row.
    expect(expectedCommit({ key: "k", to: "k", subject: "", body: "", warnings: [], commit: { verb: "save", fields: [["Signups", "352"], ["Week", "43"]] } }).fields).toEqual(
      expectedCommit({ key: "k", to: "k", subject: "", body: "", warnings: [], commit: { verb: "save", fields: [["Week", "43"], ["Signups", "352"]] } }).fields,
    );
    expect(rowKey("wf_a", [["Week", "44"], ["Signups", "352"]])).not.toBe(a);
  });

  test("LIVE: a done row re-exported with its columns reordered is never committed again", async () => {
    w = world();
    const { id, dir } = await activeMetricsWorkflow(w);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    const live = (await w.call(`/workflows/${id}/run`, "POST", {})).body;
    await w.call(`/workflows/${id}/approve`, "POST", { batchHash: live.batch.hash });
    await w.brain.idle();
    expect(w.driver.pressed).toHaveLength(1);
    writeFileSync(join(dir, "items.csv"), "Churn,Active,Signups,Week\n3,2410,352,43\n");
    const again = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/every row in items\.csv is done/);
  });

  test("LIVE: commits through a tool's own fields (Xero) and text replies (Zendesk) are not built yet and say so", async () => {
    for (const [p, re] of [["bookkeeper", /save through xero's own fields are not built yet/], ["support", /draft text \(ticket reply\) are not built yet/]] as const) {
      const { home, v2 } = await freshHome(p);
      const wf = await draftFor(home, v2, v2.insights[0]!);
      const d = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => PERSONA_NOW, limit: 2 });
      const { approveBatch } = await import("../../src/workflows/runner.ts");
      approveBatch(home, wf.id, d.batchHash, PERSONA_NOW + 1);
      writeFileSync(join(home, "workflows", wf.id, "items.csv"), "A,B\n1,2\n");
      const err = await prepareLiveBatch({ home, workflowId: wf.id, model: new StubModel(), now: () => PERSONA_NOW + 2 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RunError);
      expect((err as RunError).code).toBe("bad_request");
      expect((err as RunError).message).toMatch(re);
    }
  });
});

describe("s26 auto-run", () => {
  test("LIVE: with auto-run turned on, a plan batch still waits for the person: nothing is saved on its own", async () => {
    w = world();
    const { id, dir } = await activeMetricsWorkflow(w);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    expect((await w.call(`/workflows/${id}/auto-run`, "POST", { enabled: true })).status).toBe(200);
    const r = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(r.status).toBe(201);
    await w.brain.idle();
    expect(w.driver.pressed).toEqual([]);
    const pending = [r.body.batch, r.body.held].filter((b: any) => b !== null && b !== undefined);
    expect(pending.length).toBeGreaterThan(0);
    for (const b of pending) expect(b.state).toBe("pending");
  });
});

describe("s26 execute guards", () => {
  test("EXECUTE: a value changed on screen is never saved: the commit is denied, Save is never pressed, the row is offered again", async () => {
    w = world();
    const { id, dir } = await activeMetricsWorkflow(w);
    w.rebrain({ override: { signups: "999" } });
    writeFileSync(join(dir, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    const live = (await w.call(`/workflows/${id}/run`, "POST", {})).body;
    expect((await w.call(`/workflows/${id}/approve`, "POST", { batchHash: live.batch.hash })).status).toBe(200);
    await w.brain.idle();
    expect(w.driver.pressed).toEqual([]);
    const b = readBatch(w.home, id, live.batch.hash, w.clock.now)!;
    expect(b.state).toBe("failed");
    expect(Object.values(b.itemStates!).map((s) => s.state)).toEqual(["failed_before_send"]);
    // Provably not saved: the same row is offered again in a new batch.
    w.rebrain();
    const again = await w.call(`/workflows/${id}/run`, "POST", {});
    expect(again.status).toBe(201);
    expect(again.body.items).toHaveLength(1);
    expect(again.body.batch.state).toBe("pending");
  });

  test("EXECUTE: an approval is used once: approving the same sent batch again is refused and nothing is saved twice", async () => {
    w = world();
    const { id, dir } = await activeMetricsWorkflow(w);
    writeFileSync(join(dir, "items.csv"), itemsCsv([["43", "352", "2410", "3"]]));
    const live = (await w.call(`/workflows/${id}/run`, "POST", {})).body;
    await w.call(`/workflows/${id}/approve`, "POST", { batchHash: live.batch.hash });
    await w.brain.idle();
    expect(w.driver.pressed).toHaveLength(1);
    const again = await w.call(`/workflows/${id}/approve`, "POST", { batchHash: live.batch.hash });
    expect(again.status).toBe(409);
    await w.brain.idle();
    expect(w.driver.pressed).toHaveLength(1);
  });
});

describe("s26 honest dry run", () => {
  test("DRYRUN: an instance the workflow cannot fill saves nothing and says why; the totals show how many it can do", async () => {
    w = world();
    const { id } = await activeMetricsWorkflow(w);
    const r = (await w.call(`/workflows/${id}/dry-run`, "POST", { limit: 3 })).body;
    for (const i of r.general.instances) expect(i.warnings).toContain(NOTHING_TO_FILL);
    expect(r.totals).toMatchObject({ instances: 3, reviewMinutes: 0, savedMinutes: 0 });
    expect(r.totals.arithmetic).toMatch(/→ 0 of 3 can be done from what was on screen \(0\.0 min\) → review 0 × 20 s = 0\.0 min → saves 0\.0 min$/);
  });

  test("DRYRUN: when every instance is filled the saving and its arithmetic are as before (bookkeeper: bills from PDFs)", async () => {
    const { home, v2 } = await freshHome("bookkeeper");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => PERSONA_NOW, limit: 4 });
    const g = r.general!.instances;
    expect(g.every((i) => !i.warnings.includes(NOTHING_TO_FILL))).toBe(true);
    const obs = Math.round(g.reduce((n, i) => n + i.estimate.observedMinutes, 0) * 10 + 1e-9) / 10;
    const rev = Math.round(((g.length * 20) / 60) * 10 + 1e-9) / 10;
    expect(r.totals.savedMinutes).toBe(Math.max(0, Math.round((obs - rev) * 10 + 1e-9) / 10));
    expect(r.totals.arithmetic).toBe(`you spent ${obs.toFixed(1)} min on these ${g.length} → review ${g.length} × 20 s = ${rev.toFixed(1)} min → saves ${r.totals.savedMinutes.toFixed(1)} min`);
  });
});
