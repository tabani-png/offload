import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { main, until } from "../helpers/render.tsx";
import { renderReal, startControl, type Control } from "./real.tsx";
import { TREE_FLOOR_WORDS } from "../../src/design/components.tsx";
import { EVIDENCE_FLOOR_WORDS } from "../../src/screens/Evidence.tsx";

// Legal: 4 people with data in October (under the tenant floor of 5). Its numbers must not appear anywhere.
let c: Control;
beforeAll(async () => {
  c = await startControl();
}, 180_000);
afterAll(() => c.close());
afterEach(cleanup);

// Below the company a hidden cell may be small or complementary, and the API does not say which (ADR 0113 floor §1).
const FLOOR = TREE_FLOOR_WORDS;
const NUMBER_HOURS = /\d[\d,]*\.\d h/;
const rowOf = (label: string) => screen.getAllByRole("row").find((r) => r.querySelector("td")?.textContent === label)!;

describe("FLOOR on the real API", () => {
  test("FLOOR: the overview's Legal row shows the floor message and no number; Sales keeps its hours", async () => {
    const owner = await c.as("owner");
    const r = await owner.json("/v1/metrics/hours-saved?scope=company&from=2026-10-01&to=2026-10-27");
    expect(r.children.find((x: { label: string }) => x.label === "Legal").value).toEqual({ suppressed: true, reason: "group_floor" });
    await renderReal(c, "/", "owner");
    const legal = rowOf("Legal");
    expect(legal.textContent).toContain(FLOOR);
    expect(legal.textContent!.replace(FLOOR, "")).not.toMatch(/\d/);
    expect(legal.querySelector("[data-suppressed=group_floor]")).toBeTruthy();
    // Finance (5 people) is hidden as well so Legal cannot be derived from the total: same words, no number, and
    // Finance's own read is hidden too, so its page cannot give the number back.
    expect(rowOf("Finance").textContent).toContain(FLOOR);
    expect(rowOf("Finance").textContent).not.toMatch(NUMBER_HOURS);
    const fin = await owner.json(`/v1/metrics/hours-saved?scope=department:${c.state.depts.finance}&from=2026-10-01&to=2026-10-27`);
    expect(fin.total).toEqual({ suppressed: true, reason: "group_floor" });
    expect(rowOf("Sales").textContent).toMatch(NUMBER_HOURS);
    expect(main().textContent).toContain("Departments where fewer than 5 people have data in this period are hidden");
  });

  test("FLOOR: Legal's department page shows the floor message for hours and adoption, and offers no evidence", async () => {
    await renderReal(c, `/departments/${c.state.depts.legal}`, "owner");
    await until(() => main().textContent!.includes("Contract intake"), "workflows card");
    const t = main().textContent!;
    expect(t).toContain(FLOOR);
    expect(t).not.toMatch(NUMBER_HOURS);
    expect(t).toContain("Legal's numbers are not shown for this period: fewer than 5 people have data, or showing them");
    expect(main().querySelectorAll("[data-suppressed=group_floor]").length).toBeGreaterThanOrEqual(2);
    expect(Array.from(main().querySelectorAll("a")).filter((a) => a.textContent === "Evidence")).toEqual([]);
  });

  test("FLOOR: opening Legal's workflow evidence directly shows the floor words and lists no run", async () => {
    const owner = await c.as("owner");
    const e = await owner.api.get(`/v1/metrics/hours-saved/evidence?workflowId=${c.state.workflows.legal}&version=1&from=2026-10-01&to=2026-10-27`).catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("group_floor");
    await renderReal(c, `/workflows/${c.state.workflows.legal}/evidence`, "owner");
    await until(() => !!main().querySelector("[data-suppressed=group_floor]"), "floor note");
    expect(main().textContent).toContain(EVIDENCE_FLOOR_WORDS);
    expect(main().querySelector("[role=alert]")).toBeNull();
    expect(Array.from(main().querySelectorAll("caption")).map((x) => x.textContent)).not.toContain("Runs behind the hours");
  });

  test("FLOOR: Legal's workflow is not among the overview's top workflows", async () => {
    await renderReal(c, "/", "owner");
    await until(() => main().textContent!.includes("Lead follow-up"), "top workflows");
    expect(main().textContent).not.toContain("Contract intake");
  });
});
