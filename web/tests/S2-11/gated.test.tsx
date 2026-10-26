import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { hoursText, minutesText } from "../../src/lib/format.ts";
import { main, settle, until } from "../helpers/render.tsx";
import { renderReal, startControl, type Control } from "./real.tsx";
import { TREE_FLOOR_WORDS } from "../../src/design/components.tsx";

// One story, in order: both features off → the owner turns per-person views on in the compliance sheet (3-day notice)
// → nothing appears until it is effective → it appears → working time follows the same path → disable hides at once.
let c: Control;
let noticeV2 = "";
const DAY = 86_400_000;
const SHA = "a".repeat(64);
const text = () => main().textContent ?? "";
const headers = () => Array.from(main().querySelectorAll("th")).map((h) => h.textContent ?? "");
const NOTICE = { template: "custom", markdown: "# Electronic monitoring policy\n\nPer-person views and working time.", jurisdictions: [] };

beforeAll(async () => {
  c = await startControl();
}, 90_000);
afterAll(() => c.close());
afterEach(cleanup);

async function publish(features: string[], title: string) {
  const owner = await c.as("owner");
  const n = await owner.api.post<{ id: string }>("/v1/compliance/notices", { ...NOTICE, title, features });
  await owner.api.post(`/v1/compliance/notices/${n.id}/publish`);
  return n.id;
}

const change = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const field = (label: string) => {
  const l = Array.from(document.querySelectorAll("[role=dialog] label")).find((x) => x.textContent?.startsWith(label))!;
  return (l.querySelector("input, select") ?? document.getElementById(l.getAttribute("for") ?? ""))!;
};

describe("GATED per-person and working-time views", () => {
  test("GATED: with both features off, no per-person column and no working-time numbers anywhere; only the off notice", async () => {
    await renderReal(c, "/people", "owner");
    expect(headers().some((h) => h.startsWith("Own hours saved"))).toBe(false);
    expect(main().querySelector("[data-feature-off=per_person_views]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show hours/ })).toBeNull();
    cleanup();
    await renderReal(c, `/departments/${c.state.depts.sales}`, "owner");
    expect(main().querySelector("[data-feature-off=working_time]")).toBeTruthy();
    expect(text()).not.toContain("median active time a day");
    cleanup();
    await renderReal(c, "/", "owner");
    expect(text()).not.toContain("median active time a day");
    expect(main().querySelector("[data-section=working-time]")).toBeNull();
  });

  test("GATED: the owner turns per-person views on in the sheet; during the notice period nothing per-person appears", async () => {
    noticeV2 = await publish(["workflow_metrics", "per_person_views"], "Monitoring policy v2");
    await renderReal(c, "/compliance", "owner");
    const row = Array.from(main().querySelectorAll(".row")).find((r) => r.textContent!.includes("Per-person views"))!;
    await act(async () => {
      fireEvent.click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Turn on…")!);
    });
    const dialog = document.querySelector("[role=dialog]")!;
    const onCheckbox = Array.from(dialog.querySelectorAll("label.check")).find((l) => l.textContent === "CA-ON")!.querySelector("input")!;
    await act(async () => {
      fireEvent.click(onCheckbox);
      change(field("DPIA completed on"), "2026-10-01");
      change(field("DPIA document"), "dpia-2026.pdf");
      change(field("Document SHA-256"), SHA);
      change(field("Signed by"), "Pia Owner");
      change(field("Title"), "COO");
      change(field("Notice period, days"), "3");
    });
    expect((field("Notice") as HTMLSelectElement).value).toBe(noticeV2);
    const attest = Array.from(dialog.querySelectorAll("label.check")).find((l) => l.textContent!.startsWith("I attest"))!.querySelector("input")!;
    await act(async () => {
      fireEvent.click(attest);
    });
    await act(async () => {
      fireEvent.submit(dialog.querySelector("form")!);
    });
    await until(() => !document.querySelector("[role=dialog]"), "sheet closes after the API accepted");
    const owner = await c.as("owner");
    const fs = await owner.json("/v1/compliance/features");
    expect(fs.items.length).toBe(1);
    expect(fs.items[0].feature).toBe("per_person_views");
    expect(fs.items[0].effectiveAt).toBe(c.now() + 3 * DAY);
    await until(() => !!main().querySelector("[aria-label=Scheduled]") && text().includes("after a 3-day notice period"), "scheduled state");
    cleanup();

    await renderReal(c, "/people", "owner");
    expect(headers().some((h) => h.startsWith("Own hours saved"))).toBe(false);
    expect(main().querySelector("[data-feature-off=per_person_views]")).toBeTruthy();
    const pp = await owner.api.get(`/v1/metrics/hours-saved?scope=person:${c.state.people.member}`).catch((e: unknown) => e);
    expect((pp as { code: string }).code).toBe("feature_disabled");
  });

  test("GATED: once effective the column appears, and one opened person's hours equal the API exactly", async () => {
    await c.setClock(c.now() + 3 * DAY + 3600_000);
    const owner = await c.as("owner");
    const member = c.state.people.member;
    const api = await owner.json(`/v1/metrics/hours-saved?scope=person:${member}&from=2026-10-01&to=2026-10-30`);
    expect(api.total.runs.success).toBe(3);
    await renderReal(c, "/people", "owner");
    await until(() => headers().some((h) => h.startsWith("Own hours saved")), "per-person column");
    expect(main().querySelector("[data-feature-on=per_person_views]")).toBeTruthy();
    // Numbers load only on an explicit open of one person.
    expect(text()).not.toMatch(/\d\.\d h/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show hours for member" }));
    });
    await until(() => text().includes(hoursText(api.total.seconds)), "the member's hours");
    expect(Array.from(main().querySelectorAll("button")).filter((b) => b.textContent === "Show hours").length).toBeGreaterThan(5);
  });

  test("GATED: the opened person sees the read in My data, and per-person views shown as on", async () => {
    await renderReal(c, "/me", "member");
    await until(() => text().includes("Opened your record"), "access log row");
    // A member cannot list people, so the reader is named by role, never as "System"; the Mac's own actions say so.
    const opened = Array.from(main().querySelectorAll("tbody tr")).find((r) => r.textContent!.includes("Opened your record"))!;
    expect(opened.querySelectorAll("td")[1]!.textContent).toBe("Owner");
    expect(text()).not.toContain("System Owner");
    expect(text()).toContain("Your Mac");
    expect(text()).toContain("On. Each time someone opens your numbers it shows above.");
  });

  test("GATED: working time appears only once enabled, acknowledged and effective: team medians equal the API", async () => {
    const v3 = await publish(["workflow_metrics", "per_person_views", "working_time"], "Monitoring policy v3");
    const owner = await c.as("owner");
    await owner.api.post("/v1/compliance/features/working_time/enable", {
      feature: "working_time", jurisdictions: ["CA-ON"], legalBasis: "legitimate_interest",
      dpiaAttestation: { completedOn: "2026-10-01", documentHash: SHA, documentName: "dpia-2026.pdf", signerName: "Pia Owner", signerTitle: "COO" },
      noticeVersionId: v3, noticePeriodDays: 1, worksAgreementRef: null, quebecActivationAck: false, purposeLock: "process_improvement",
    });
    await c.ctl("/ack", { noticeId: v3, features: ["workflow_metrics", "per_person_views", "working_time"] });
    // Scheduled, not effective: still no working-time numbers.
    await renderReal(c, `/departments/${c.state.depts.sales}`, "owner");
    expect(main().querySelector("[data-feature-off=working_time]")).toBeTruthy();
    expect(text()).not.toContain("median active time a day");
    cleanup();

    const effective = (await owner.json("/v1/compliance/features")).items.find((f: { feature: string }) => f.feature === "working_time").effectiveAt;
    await c.setClock(effective + DAY + 2 * 3600_000);
    const day = new Date(effective + 3600_000).toISOString().slice(0, 10);
    await c.ctl("/working-time", { noticeId: v3, days: [day] });
    const owner2 = await c.as("owner");
    const wt = await owner2.json(`/v1/metrics/working-time?scope=department:${c.state.depts.sales}&from=2026-10-01&to=${new Date(c.now() + DAY).toISOString().slice(0, 10)}`);
    expect(wt.value.people).toBe(6);
    await renderReal(c, `/departments/${c.state.depts.sales}`, "owner");
    await until(() => text().includes("median active time a day"), "working-time card");
    expect(text()).toContain(minutesText(wt.value.medianActiveMinutesPerDay * 60));
    expect(text()).toContain(`${minutesText(wt.value.p25 * 60)} – ${minutesText(wt.value.p75 * 60)}`);
    expect(text()).toContain("Team medians only. Nobody is listed or ranked.");
    for (const m of c.state.members) expect(text()).not.toContain(m.name);
    cleanup();

    const company = await owner2.json(`/v1/metrics/working-time?scope=company&from=2026-10-01&to=${new Date(c.now() + DAY).toISOString().slice(0, 10)}`);
    await renderReal(c, "/", "owner");
    await until(() => !!main().querySelector("[data-section=working-time]"), "company working time");
    const section = main().querySelector("[data-section=working-time]")!;
    expect(section.textContent).toContain(minutesText(company.value.medianActiveMinutesPerDay * 60));
    expect(section.textContent).toContain(`${company.value.people} people`);
  });

  test("GATED: with working time on, the floor still holds: Legal's working-time card shows the floor message and no minutes", async () => {
    await renderReal(c, `/departments/${c.state.depts.legal}`, "owner");
    await until(() => !main().querySelector("[data-feature-off=working_time]") && text().includes("Working time"), "working-time section");
    const section = Array.from(main().querySelectorAll("section")).find((s) => s.querySelector("h2")?.textContent === "Working time")!;
    await until(() => section.textContent!.includes(TREE_FLOOR_WORDS), "floor message");
    expect(section.textContent).not.toMatch(/\d+ min/);
  });

  test("GATED: disabling per-person views hides the column at once", async () => {
    const admin = await c.as("admin");
    await admin.api.post("/v1/compliance/features/per_person_views/disable");
    await renderReal(c, "/people", "owner");
    expect(headers().some((h) => h.startsWith("Own hours saved"))).toBe(false);
    expect(main().querySelector("[data-feature-off=per_person_views]")).toBeTruthy();
    await settle();
  });
});
