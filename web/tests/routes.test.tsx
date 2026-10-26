import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import * as fx from "../src/api/mock/fixtures.ts";
import { ROUTE_PATHS } from "../src/app/router.tsx";
import { h1, main, renderAt } from "./helpers/render.tsx";

afterEach(cleanup);

const W = fx.WF[301]!;

describe("every route renders on fixtures", () => {
  test("ROUTES: / shows company hours saved, grade split, departments, top workflows, overnight share and quality", async () => {
    await renderAt("/");
    expect(h1()).toBe("Northwind Supply");
    const text = main().textContent!;
    expect(text).toContain("Hours saved");
    expect(text).toContain("142.0 h");
    expect(text).toMatch(/Grade A.*Grade B.*Grade C/s);
    expect(text).toContain("By department");
    expect(text).toContain("Top workflows");
    expect(text).toContain("Overnight");
    expect(text).toContain("Quality");
    expect(screen.getAllByRole("link", { name: "Evidence" }).length).toBeGreaterThan(2);
    expect(screen.getByRole("img", { name: /Hours saved per month/ })).toBeTruthy();
  });

  test("ROUTES: /departments/:id shows the department, its job roles and workflows", async () => {
    await renderAt(`/departments/${fx.DEPT.sales}`);
    expect(h1()).toBe("Sales");
    expect(main().textContent).toContain("SDR, Sales");
    expect(main().textContent).toContain("Follow up on demo requests");
    expect(main().textContent).toContain("65.0 h");
  });

  test("ROUTES: /workflows lists the registry with states", async () => {
    await renderAt("/workflows");
    expect(h1()).toBe("Workflows");
    expect(screen.getAllByRole("row").length).toBe(fx.workflows.length + 1);
    expect(main().textContent).toContain("Proposed, needs review");
  });

  test("ROUTES: /workflows/:id shows versions and steps", async () => {
    await renderAt(`/workflows/${W}`);
    expect(h1()).toBe("Follow up on demo requests");
    expect(main().textContent).toContain("Version 3");
    expect(main().textContent).toContain("Send from sales@");
    expect(screen.getByRole("button", { name: /Preview SOP/ })).toBeTruthy();
  });

  test("ROUTES: /workflows/:id/evidence shows baseline samples and runs", async () => {
    await renderAt(`/workflows/${W}/evidence`);
    expect(h1()).toContain("Evidence");
    expect(main().textContent).toContain("12 samples");
    expect(main().textContent).toContain("Not reviewed yet");
  });

  test("ROUTES: /approvals lists pending batches", async () => {
    await renderAt("/approvals");
    expect(h1()).toBe("Approvals");
    expect(document.querySelectorAll("[role=listitem]").length).toBe(3);
  });

  test("ROUTES: /digest shows what ran and what waits", async () => {
    await renderAt("/digest");
    expect(h1()).toBe("Morning digest");
    expect(main().textContent).toContain("Waiting for you");
    expect(main().textContent).toContain("Ran overnight");
    expect(main().textContent).toContain("estimated");
  });

  test("ROUTES: /workers, worker runs and run detail render", async () => {
    await renderAt("/workers");
    expect(h1()).toBe("Cloud workers");
    expect(main().textContent).toContain("Setting up");
    cleanup();
    await renderAt(`/workers/${fx.workers[0]!.id}`);
    expect(main().textContent).toContain("Runs");
    cleanup();
    await renderAt(`/worker-runs/${fx.workerRuns[0]!.id}`);
    expect(h1()).toBe("Run");
    expect(main().textContent).toContain("Summary");
  });

  test("ROUTES: /people is a directory of name, department, access role and state", async () => {
    await renderAt("/people");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Name", "Department", "Access role", "State"]);
    expect(screen.getAllByRole("row").length).toBe(fx.people.length + 1);
  });

  test("ROUTES: /offboarding lists leavers and their hand-overs", async () => {
    await renderAt("/offboarding");
    expect(main().textContent).toContain(fx.LEAVING.displayName);
    expect(main().textContent).toContain(fx.FROZEN.displayName);
    expect(main().textContent).toContain("Needs a successor");
  });

  test("ROUTES: /compliance shows features, notices and the audit log", async () => {
    await renderAt("/compliance");
    const t = main().textContent!;
    expect(t).toContain("Per-person views");
    expect(t).toContain("Working time");
    expect(t).toContain("Notices");
    expect(t).toContain("Audit log");
    expect(t).toContain("workflow.promote");
  });

  test("ROUTES: /me shows my data including who viewed it", async () => {
    await renderAt("/me");
    expect(h1()).toBe("My data");
    expect(main().textContent).toContain("Who looked at my data");
    expect(main().textContent).toContain("Opened your record");
    expect(screen.getByRole("button", { name: /Download my data/ })).toBeTruthy();
  });

  test("ROUTES: every route path in the router is covered by a test above", () => {
    expect([...ROUTE_PATHS].sort()).toEqual([
      "/", "/approvals", "/compliance", "/departments/$id", "/digest", "/me", "/offboarding", "/people", "/worker-runs/$id",
      "/workers", "/workers/$id", "/workflows", "/workflows/$id", "/workflows/$id/evidence",
    ]);
  });

  test("ROUTES: an unknown path says so in plain words", async () => {
    await renderAt("/nope");
    expect(h1()).toBe("Not found");
  });
});
