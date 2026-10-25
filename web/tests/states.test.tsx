import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ERROR_CODES, ERROR_WORDS, createHttpClient, errorWords, ApiError } from "../src/api/client.ts";
import * as fx from "../src/api/mock/fixtures.ts";
import { uuid } from "../src/api/mock/ids.ts";
import { validateEnable, toEnableRequest, type EnableForm } from "../src/screens/Compliance.tsx";
import { check } from "./helpers/schemas.ts";
import { findRoute } from "../src/api/mock/server.ts";
import { main, renderAt, settle, until } from "./helpers/render.tsx";

afterEach(cleanup);

const dialogEl = () => document.querySelector("[role=dialog]") as HTMLElement;

const NUMBER_HOURS = /\d[\d,]*\.\d h/;
const rowOf = (label: string) => screen.getAllByRole("row").find((r) => r.querySelector("td")?.textContent === label)!;

describe("suppressed cells", () => {
  test("STATES: overview shows the floor message for small departments and no number", async () => {
    await renderAt("/");
    for (const name of ["Legal", "Facilities"]) {
      const row = rowOf(name);
      expect(row.textContent).toContain("Fewer than 5 people");
      expect(row.textContent).not.toMatch(NUMBER_HOURS);
      expect(row.textContent!.replace("Fewer than 5 people", "")).not.toMatch(/\d/);
    }
    expect(rowOf("Sales").textContent).toMatch(NUMBER_HOURS);
  });

  test("STATES: a department under the floor shows the floor message instead of a hero number", async () => {
    await renderAt(`/departments/${fx.DEPT.legal}`);
    const t = main().textContent!;
    expect(t).toContain("Fewer than 5 people");
    expect(t).not.toMatch(NUMBER_HOURS);
    expect(main().querySelector("[data-suppressed=group_floor]")).toBeTruthy();
  });

  test("STATES: complementary suppression hides a second job role so the small one cannot be derived", async () => {
    await renderAt(`/departments/${fx.DEPT.finance}`);
    const ap = rowOf("AP clerk, Finance");
    const controller = rowOf("Controller, Finance");
    for (const r of [ap, controller]) {
      expect(r.textContent).toContain("Fewer than 5 people");
      expect(r.textContent).not.toMatch(NUMBER_HOURS);
    }
  });
});

describe("sensitive views are gated", () => {
  test("STATES: per-person metrics column is absent and the gate is visible while the feature is off", async () => {
    const { api } = await renderAt("/people");
    expect(main().querySelector("[data-feature-off=per_person_views]")?.textContent).toContain("Per-person views are off");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).not.toContainEqual(expect.stringContaining("hours"));
    expect(api.calls.some((c) => c.includes("metrics"))).toBe(false);
  });

  test("STATES: per-person metrics column appears only when the feature is on and effective", async () => {
    const { api } = await renderAt("/people", { features: ["per_person_views"] });
    expect(main().querySelector("[data-feature-off]")).toBeNull();
    expect(main().querySelector("[data-feature-on=per_person_views]")).toBeTruthy();
    expect(screen.getAllByRole("columnheader").at(-1)!.textContent).toContain("Own hours saved");
    expect(api.calls.filter((c) => c === "GET /v1/metrics/hours-saved").length).toBe(fx.people.length);
  });

  test("STATES: working time is hidden behind its gate and never requested while off", async () => {
    const { api } = await renderAt(`/departments/${fx.DEPT.sales}`);
    expect(main().querySelector("[data-feature-off=working_time]")).toBeTruthy();
    expect(api.calls).not.toContain("GET /v1/metrics/working-time");
    cleanup();
    const on = await renderAt(`/departments/${fx.DEPT.sales}`, { features: ["working_time"] });
    expect(main().querySelector("[data-feature-off=working_time]")).toBeNull();
    expect(main().textContent).toContain("median active time a day");
    expect(main().textContent).toContain("Nobody is listed or ranked");
    expect(on.api.calls).toContain("GET /v1/metrics/working-time");
  });

  test("STATES: working time for a group under the floor shows the floor message", async () => {
    await renderAt(`/departments/${fx.DEPT.facilities}`, { features: ["working_time"] });
    expect(main().textContent).toContain("Fewer than 5 people");
    expect(main().textContent).not.toContain("median active time a day");
  });

  test("STATES: self-view tells me which sensitive features are off for me", async () => {
    await renderAt("/me");
    expect(main().textContent).toContain("Off. Nobody at the company can see your own numbers.");
  });
});

describe("errors in plain words", () => {
  test("STATES: every error code has plain words and screens show them, not the code", async () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_WORDS[code].length).toBeGreaterThan(10);
      expect(ERROR_WORDS[code]).not.toContain("_");
    }
    for (const code of ["forbidden", "rate_limited", "server_error", "feature_disabled"] as const) {
      await renderAt("/people", { failures: { "GET /v1/people": code } });
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe(ERROR_WORDS[code]);
      expect(main().textContent).not.toContain(code);
      cleanup();
    }
  });

  test("STATES: unknown errors fall back to the server_error words", () => {
    expect(errorWords(new Error("boom"))).toBe(ERROR_WORDS.server_error);
    expect(errorWords(new ApiError("hash_mismatch", 409))).toBe(ERROR_WORDS.hash_mismatch);
  });

  test("STATES: the HTTP client maps error.code from the body and sends CSRF on mutations", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith("/auth/session")) return new Response(JSON.stringify({ csrfToken: "csrf-abc" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "kill_switch_active", message: "stopped" } }), { status: 409 });
    };
    const http = createHttpClient("", fake);
    const err = await http.post("/v1/batches/x/approve", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("kill_switch_active");
    const post = seen.find((s) => s.init.method === "POST")!;
    expect((post.init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-abc");
  });

  test("STATES: a promote that would bind a personal LinkedIn commit is refused with forbidden_binding", async () => {
    const r = findRoute("POST", `/v1/workflows/${fx.WF[309]}/promote`)!;
    expect(r).toBeTruthy();
    const { createMockClient } = await import("../src/api/mock/server.ts");
    const api = createMockClient();
    const body = { jobRoleId: fx.JR.sdr, departmentId: fx.DEPT.sales, fromVersion: 1, bindings: [{ stepId: "send-invites", connectionId: uuid(506), disable: false }] };
    expect(api.post(`/v1/workflows/${fx.WF[309]}/promote`, body)).rejects.toMatchObject({ code: "forbidden_binding" });
  });
});

describe("flows", () => {
  test("STATES: approving a batch from its sheet removes it from the queue", async () => {
    const { api } = await renderAt("/approvals");
    fireEvent.click(screen.getByRole("button", { name: /Review the oldest/ }));
    await settle();
    const dialog = dialogEl();
    expect(within(dialog).getByText(/Thanks for asking about a demo for Harbor Logistics/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Approve 6 items/ }));
    await until(() => document.querySelector("[role=dialog]") === null, "sheet to close");
    await until(() => document.querySelectorAll("[role=listitem]").length === 2, "queue to shrink");
    expect(api.calls).toContain(`POST /v1/batches/${fx.batches[0]!.batchHash}/approve`);
  });

  test("STATES: a kill switch turns approval into plain words", async () => {
    const { api } = await renderAt("/approvals");
    await act(async () => {
      await api.post("/v1/kill-switches", { scope: "tenant", targetId: null, reason: "Audit week" });
    });
    fireEvent.click(screen.getByRole("button", { name: /Review the oldest/ }));
    await settle();
    fireEvent.click(within(dialogEl()).getByRole("button", { name: /Approve/ }));
    await until(() => dialogEl().querySelector("[role=alert]")?.textContent === ERROR_WORDS.kill_switch_active, "kill switch words");
  });

  test("STATES: promoting a proposal keeps the personal LinkedIn step off and becomes a role workflow", async () => {
    const { api } = await renderAt(`/workflows/${fx.WF[309]}`);
    fireEvent.keyDown(window, { key: "p" });
    await settle();
    const dialog = dialogEl();
    expect(dialog.textContent).toContain("A personal LinkedIn can never be automated");
    fireEvent.click(within(dialog).getByRole("button", { name: /Promote as a new version/ }));
    expect(within(dialog).getByRole("alert").textContent).toContain("Choose the job role");
    fireEvent.change(within(dialog).getByLabelText("Job role"), { target: { value: fx.JR.sdr } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Promote as a new version/ }));
    await until(() => document.querySelector("[role=dialog]") === null, "sheet to close");
    await settle();
    expect(main().textContent).toContain("Role workflow");
    expect(api.calls).toContain(`POST /v1/workflows/${fx.WF[309]}/promote`);
  });

  test("STATES: assigning a hand-over to a role identity closes the open task", async () => {
    await renderAt("/offboarding");
    fireEvent.click(screen.getByRole("button", { name: /Assign the next hand-over/ }));
    await settle();
    const dialog = dialogEl();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Assign/ }));
    expect(within(dialog).getByRole("alert").textContent).toContain("Choose a successor");
    fireEvent.click(within(dialog).getByLabelText(/Sales team/));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Assign/ }));
    await until(() => document.querySelector("[role=dialog]") === null, "sheet to close");
  });

  test("STATES: enabling a sensitive feature needs a complete DPIA attestation and respects jurisdiction rules", () => {
    const ok: EnableForm = {
      jurisdictions: ["CA-ON"], legalBasis: "legitimate_interest", completedOn: "2026-10-20", documentName: "DPIA.pdf",
      documentHash: "ab".repeat(32), signerName: "Pia Roy", signerTitle: "Owner", noticeVersionId: uuid(703),
      noticePeriodDays: "0", worksName: "", worksHash: "", quebecAck: false, attest: true,
    };
    expect(validateEnable(ok)).toEqual({});
    expect(validateEnable({ ...ok, jurisdictions: ["US-NY"] }).noticePeriodDays).toContain("at least 1 day");
    expect(validateEnable({ ...ok, jurisdictions: ["DE"], noticePeriodDays: "14" }).worksName).toContain("works agreement");
    expect(validateEnable({ ...ok, jurisdictions: ["CA-QC"] }).quebecAck).toContain("8.1");
    expect(validateEnable({ ...ok, documentHash: "nope" }).documentHash).toBeTruthy();
    expect(validateEnable({ ...ok, attest: false }).attest).toBeTruthy();
    const body = toEnableRequest("per_person_views", ok);
    expect(check(findRoute("POST", "/v1/compliance/features/per_person_views/enable")!.route.request!, body)).toBeNull();
  });

  test("STATES: only the owner can turn a sensitive feature on", async () => {
    await renderAt("/compliance", { role: "admin" });
    for (const b of screen.getAllByRole("button", { name: /Turn on/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(main().textContent).toContain("Only the owner can turn a sensitive feature on.");
  });

  test("STATES: an owner's enablement is scheduled after the notice period, not on at once", async () => {
    await renderAt("/compliance");
    fireEvent.click(screen.getAllByRole("button", { name: /Turn on/ })[0]!);
    await settle();
    const d = dialogEl();
    fireEvent.click(within(d).getByLabelText("CA-ON"));
    fireEvent.change(within(d).getByLabelText("DPIA completed on"), { target: { value: "2026-10-20" } });
    fireEvent.change(within(d).getByLabelText("DPIA document"), { target: { value: "DPIA.pdf" } });
    fireEvent.change(within(d).getByLabelText(/Document SHA-256/), { target: { value: "cd".repeat(32) } });
    fireEvent.change(within(d).getByLabelText("Signed by"), { target: { value: "Pia Roy" } });
    fireEvent.change(within(d).getByLabelText("Title"), { target: { value: "Owner" } });
    fireEvent.click(within(d).getByLabelText(/I attest/));
    fireEvent.click(within(d).getByRole("button", { name: /Turn on after the notice period/ }));
    await until(() => document.querySelector("[role=dialog]") === null, "sheet to close");
    await settle();
    expect(main().textContent).toMatch(/Starts .* after a 14-day notice period/);
  });

  test("STATES: verifying the audit chain reports it intact", async () => {
    await renderAt("/compliance");
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    await until(() => main().textContent!.includes("Chain intact"), "chain result");
  });
});
