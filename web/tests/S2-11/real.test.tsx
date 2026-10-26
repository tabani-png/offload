import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup } from "@testing-library/react";
import { hoursText } from "../../src/lib/format.ts";
import { main, h1, until } from "../helpers/render.tsx";
import { renderReal, startControl, type Control } from "./real.tsx";

let c: Control;
beforeAll(async () => {
  c = await startControl();
}, 90_000);
afterAll(() => c.close());
afterEach(cleanup);

const P = "from=2026-10-01&to=2026-10-27";
const text = () => main().textContent ?? "";

describe("REAL screens render the seeded company from the control plane", () => {
  test("REAL: overview shows the company total, the departments and named top workflows from the API", async () => {
    const owner = await c.as("owner");
    const r = await owner.json(`/v1/metrics/hours-saved?scope=company&${P}`);
    await renderReal(c, "/", "owner");
    await until(() => text().includes("Lead follow-up"), "top workflow names");
    expect(h1()).toContain("Acme");
    expect(text()).toContain(hoursText(r.total.seconds));
    expect(text()).toContain(`Saved across ${r.total.people} people and ${r.total.runs.success} successful runs.`);
    for (const d of ["Sales", "Finance", "Legal"]) expect(text()).toContain(d);
    // Names come from the registry, not raw ids.
    expect(text()).not.toContain(c.state.workflows.sales);
  });

  test("REAL: the sales department page shows its API numbers and its workflow", async () => {
    const owner = await c.as("owner");
    const r = await owner.json(`/v1/metrics/hours-saved?scope=department:${c.state.depts.sales}&${P}`);
    await renderReal(c, `/departments/${c.state.depts.sales}`, "owner");
    await until(() => text().includes("Lead follow-up"), "department workflows");
    expect(h1()).toBe("Sales");
    expect(text()).toContain(hoursText(r.total.seconds));
    expect(text()).toContain(`${r.total.runs.success} successful runs by ${r.total.people} people.`);
  });

  test("REAL: the workflows registry lists the three role workflows", async () => {
    await renderReal(c, "/workflows", "admin");
    for (const n of ["Lead follow-up", "Invoice matching", "Contract intake"]) expect(text()).toContain(n);
  });

  test("REAL: approvals shows the waiting batch to its runner", async () => {
    await renderReal(c, "/approvals", "member");
    await until(() => text().includes("Lead follow-up"), "batch row");
    expect(text()).toContain("1 item · Mac");
  });

  test("REAL: compliance shows both features off, the published notice with 15 acknowledgements, and the audit log", async () => {
    await renderReal(c, "/compliance", "owner");
    await until(() => text().includes("workflow.promoted"), "audit rows");
    expect(text()).toContain("Per-person views");
    expect(text()).toContain("Working time");
    const notices = Array.from(main().querySelectorAll("table")).find((t) => t.querySelector("caption")?.textContent === "Notice versions")!;
    expect(notices.textContent).toContain("How Offload is used at Acme");
    expect(notices.textContent).toContain("Published");
    expect(notices.querySelector("tbody tr td:last-child")!.textContent).toBe("15");
  });

  test("REAL: my data shows the member's own record and what is on for them", async () => {
    await renderReal(c, "/me", "member");
    expect(h1()).toBe("My data");
    expect(text()).toContain("Per-person views");
    expect(text()).toContain("Off. Nobody at the company can see your own numbers.");
  });
});

describe("REAL failure paths", () => {
  test("REAL: a signed-out browser gets plain words on the overview, not an endless spinner", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { createMemoryHistory } = await import("@tanstack/react-router");
    const { render } = await import("@testing-library/react");
    const { createHttpClient } = await import("../../src/api/client.ts");
    const { App, createAppRouter } = await import("../../src/app/router.tsx");
    const api = createHttpClient(c.state.api, (i, init) => fetch(i, init));
    render(<App deps={{ api, now: c.now }} router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await until(() => text().includes("You are signed out. Sign in again to continue."), "signed-out words", 8000);
    expect(main().querySelector("[role=status]")).toBeNull();
  });
});
