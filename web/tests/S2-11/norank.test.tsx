import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { main, until } from "../helpers/render.tsx";
import { renderReal, startControl, type Control } from "./real.tsx";

// No screen sorts people by a metric (ADR 0108 §6). Checked in the DOM on the real API with per-person views on, so the
// one place a per-person number can appear is present.
let c: Control;
beforeAll(async () => {
  c = await startControl();
  const owner = await c.as("owner");
  const n = await owner.api.post<{ id: string }>("/v1/compliance/notices", {
    template: "ontario-esa-policy", title: "Monitoring policy v2", markdown: "# Policy", features: ["workflow_metrics", "per_person_views"], jurisdictions: [],
  });
  await owner.api.post(`/v1/compliance/notices/${n.id}/publish`);
  await owner.api.post("/v1/compliance/features/per_person_views/enable", {
    feature: "per_person_views", jurisdictions: ["CA-ON"], legalBasis: "legitimate_interest",
    dpiaAttestation: { completedOn: "2026-10-01", documentHash: "a".repeat(64), documentName: "dpia.pdf", signerName: "Pia Owner", signerTitle: "COO" },
    noticeVersionId: n.id, noticePeriodDays: 0, worksAgreementRef: null, quebecActivationAck: false, purposeLock: "process_improvement",
  });
}, 90_000);
afterAll(() => c.close());
afterEach(cleanup);

/** No header anywhere offers sorting, and nothing in the page is a sort control. */
function noSortControls() {
  for (const th of Array.from(main().querySelectorAll("th"))) {
    expect(th.getAttribute("aria-sort")).toBeNull();
    expect(th.querySelector("button, a, [role=button], select")).toBeNull();
  }
  expect(main().querySelector("[aria-sort], [data-sort]")).toBeNull();
  expect(Array.from(main().querySelectorAll("button, select, [role=tab]")).map((b) => b.textContent ?? "").filter((t) => /sort|rank|top people|most|least/i.test(t))).toEqual([]);
}

const firstCells = (caption: string) => {
  const t = Array.from(main().querySelectorAll("table")).find((x) => x.querySelector("caption")?.textContent === caption)!;
  return Array.from(t.querySelectorAll("tbody tr")).map((r) => r.querySelector("td")!.textContent!);
};

describe("NORANK on the real API", () => {
  test("NORANK: people (owner, per-person views on) keeps the API's directory order and offers no sort", async () => {
    const owner = await c.as("owner");
    const api = (await owner.json("/v1/people?limit=200")).items as Array<{ displayName: string }>;
    await renderReal(c, "/people", "owner");
    await until(() => !!main().querySelector("[data-feature-on=per_person_views]"), "per-person on");
    expect(firstCells("People in the directory")).toEqual(api.map((p) => p.displayName));
    noSortControls();
  });

  test("NORANK: the dept lead's people list (summaries) is in API order with no sort and no per-person numbers loaded", async () => {
    const lead = await c.as("lead");
    const api = (await lead.json("/v1/people?limit=200")).items as Array<{ displayName: string }>;
    await renderReal(c, "/people", "lead");
    expect(firstCells("People in the directory")).toEqual(api.map((p) => p.displayName));
    expect(main().textContent).not.toMatch(/\d\.\d h/);
    noSortControls();
  });

  test("NORANK: department screens list no person and no table sorts", async () => {
    for (const d of [c.state.depts.sales, c.state.depts.legal]) {
      await renderReal(c, `/departments/${d}`, "owner");
      await until(() => main().textContent!.includes("Workflows"), "department");
      for (const m of c.state.members) expect(main().textContent).not.toContain(m.name);
      expect(main().textContent).not.toContain("member");
      noSortControls();
      cleanup();
    }
  });

  test("NORANK: the overview lists departments in the API's order (by name), never by hours", async () => {
    const owner = await c.as("owner");
    const r = await owner.json("/v1/metrics/hours-saved?scope=company&from=2026-10-01&to=2026-10-27");
    await renderReal(c, "/", "owner");
    expect(firstCells("Hours saved by department")).toEqual(r.children.map((x: { label: string }) => x.label));
    for (const m of c.state.members) expect(main().textContent).not.toContain(m.name);
    noSortControls();
  });
});
