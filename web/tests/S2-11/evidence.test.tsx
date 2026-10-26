import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { hoursText, minutesText, timeText } from "../../src/lib/format.ts";
import { evidenceAll as screenEvidence } from "../../src/screens/Evidence.tsx";
import { main, settle, until } from "../helpers/render.tsx";
import { renderReal, startControl, type Control } from "./real.tsx";

let c: Control;
beforeAll(async () => {
  c = await startControl();
}, 180_000);
afterAll(() => c.close());
afterEach(cleanup);

const P = "from=2026-10-01&to=2026-10-27";

interface Run { runId: string; endedAt: number; itemsSucceeded: number; baselineSeconds: number; residualSeconds: number | null; savedSeconds: number }

/** Every page of a workflow's evidence, as the API answers it. */
async function evidenceAll(who: string, workflowId: string) {
  const b = await c.as(who);
  let cursor: string | null = null;
  const runs: Run[] = [];
  let first: any = null;
  do {
    const e: any = await b.json(`/v1/metrics/hours-saved/evidence?workflowId=${workflowId}&version=1&${P}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    first ??= e;
    runs.push(...e.runs);
    cursor = e.page.nextCursor;
  } while (cursor);
  return { ...first, runs };
}

const table = (caption: string) =>
  Array.from(main().querySelectorAll("table")).find((t) => t.querySelector("caption")?.textContent === caption) ?? null;
const bodyRows = (t: HTMLTableElement | null) => Array.from(t?.querySelectorAll("tbody tr") ?? []).filter((r) => r.querySelectorAll("td").length > 1);

describe("EVIDENCE drill-down on the real API", () => {
  test("EVIDENCE: company total → top workflow → evidence: the runs listed add up to the workflow's hours exactly", async () => {
    const owner = await c.as("owner");
    const r = await owner.json(`/v1/metrics/hours-saved?scope=company&${P}`);
    const top = r.topWorkflows.find((t: { workflowId: string }) => t.workflowId === c.state.workflows.sales);
    const ev = await evidenceAll("owner", c.state.workflows.sales);
    const listed = ev.runs.reduce((a: number, x: Run) => a + x.savedSeconds, 0);
    expect(listed).toBe(top.seconds);

    const paths: string[] = [];
    const { router } = await renderReal(c, "/", "owner", { onRequest: (_m, p) => paths.push(p) });
    await until(() => main().textContent!.includes("Lead follow-up"), "top workflows");
    const row = Array.from(main().querySelectorAll(".row")).find((x) => x.textContent!.includes("Lead follow-up"))!;
    expect(row.textContent).toContain(hoursText(top.seconds));
    const link = Array.from(row.querySelectorAll("a")).find((a) => a.textContent === "Evidence")!;
    await act(async () => {
      fireEvent.click(link);
    });
    await until(() => router.state.location.pathname === `/workflows/${c.state.workflows.sales}/evidence`, "navigation");
    await settle();
    await until(() => bodyRows(table("Runs behind the hours")).length === ev.runs.length, "every run listed");
    expect(main().textContent).toContain(`${ev.runs.length} successful of ${ev.runs.length} · ${hoursText(top.seconds)} saved in this list`);
    // The evidence was asked for the overview's period, so both screens describe the same runs.
    const total = paths.find((p) => p.startsWith("/v1/metrics/hours-saved?scope=company"))!;
    const evidence = paths.find((p) => p.startsWith("/v1/metrics/hours-saved/evidence"))!;
    const period = (p: string) => new URLSearchParams(p.split("?")[1]).get("from") + ".." + new URLSearchParams(p.split("?")[1]).get("to");
    expect(period(evidence)).toBe(period(total));
    expect(period(total)).toBe("2026-10-01..2026-10-27");
  });

  test("EVIDENCE: the screen's loader follows every page: 5 per page gives the same runs as one page", async () => {
    const { api } = await c.as("owner");
    const path = `/v1/metrics/hours-saved/evidence?workflowId=${c.state.workflows.sales}&version=1&${P}`;
    const small = await screenEvidence(api, path, 5);
    const one = await evidenceAll("owner", c.state.workflows.sales);
    expect(small.runs.length).toBe(18);
    expect(small.runs).toEqual(one.runs);
    expect(small.baseline).toEqual(one.baseline);
    expect(small.page.nextCursor).toBeNull();
  });

  test("EVIDENCE: each run row matches the API exactly (ended, items, baseline, review time, saved), in API order", async () => {
    const ev = await evidenceAll("owner", c.state.workflows.sales);
    await renderReal(c, `/workflows/${c.state.workflows.sales}/evidence`, "owner");
    await until(() => bodyRows(table("Runs behind the hours")).length === ev.runs.length, "runs");
    const rows = bodyRows(table("Runs behind the hours"));
    rows.forEach((tr, i) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => td.textContent);
      const x = ev.runs[i]!;
      expect(cells[0]).toBe(timeText(x.endedAt));
      expect(cells[2]).toBe(String(x.itemsSucceeded));
      expect(cells[3]).toBe(minutesText(x.baselineSeconds));
      expect(cells[4]).toBe(x.residualSeconds === null ? "Not reviewed yet" : minutesText(x.residualSeconds));
      expect(cells[5]).toBe(minutesText(x.savedSeconds));
    });
  });

  test("EVIDENCE: the baseline shows the API median and every sample row", async () => {
    const ev = await evidenceAll("owner", c.state.workflows.sales);
    await renderReal(c, `/workflows/${c.state.workflows.sales}/evidence`, "owner");
    await until(() => !!table("Baseline samples"), "samples");
    expect(main().textContent).toContain(`${minutesText(ev.baseline.medianSeconds)} per item`);
    expect(main().textContent).toContain(`${ev.baseline.n} samples`);
    const rows = bodyRows(table("Baseline samples"));
    expect(rows.length).toBe(ev.baseline.samples.length);
    expect(rows.map((r) => r.querySelector("td")!.textContent).sort()).toEqual(ev.baseline.samples.map((s: { instanceRef: string }) => s.instanceRef).sort());
  });

  test("EVIDENCE: a member sees only their own runs of the workflow, matching their own API answer", async () => {
    const ev = await evidenceAll("member", c.state.workflows.sales);
    expect(ev.runs.length).toBe(3);
    await renderReal(c, `/workflows/${c.state.workflows.sales}/evidence`, "member");
    await until(() => bodyRows(table("Runs behind the hours")).length === 3, "own runs");
    const saved = ev.runs.reduce((a: number, x: Run) => a + x.savedSeconds, 0);
    expect(main().textContent).toContain(`· ${hoursText(saved)} saved in this list`);
  });

  test("EVIDENCE: the department page links each role workflow to the same evidence", async () => {
    const { router } = await renderReal(c, `/departments/${c.state.depts.sales}`, "owner");
    await until(() => Array.from(main().querySelectorAll("a")).some((a) => a.textContent === "Evidence"), "evidence link");
    const link = Array.from(main().querySelectorAll("a")).find((a) => a.textContent === "Evidence")!;
    await act(async () => {
      fireEvent.click(link);
    });
    await until(() => router.state.location.pathname.endsWith("/evidence"), "navigation");
    expect(router.state.location.pathname).toBe(`/workflows/${c.state.workflows.sales}/evidence`);
  });
});
