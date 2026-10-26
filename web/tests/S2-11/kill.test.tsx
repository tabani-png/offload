import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { main, until } from "../helpers/render.tsx";
import { renderReal, startControl, type Control } from "./real.tsx";

// Kill-switch clearing rights on the real API (API.md "Clearing a kill switch", S2-07): the digest offers "Clear the
// stop" only to someone the server lets clear it, and "Stop all sending" only to an owner or admin.
let c: Control;
beforeAll(async () => {
  c = await startControl();
}, 180_000);
afterAll(() => c.close());
afterEach(cleanup);

const buttons = () => Array.from(document.querySelectorAll("button")).map((b) => b.textContent ?? "");
const has = (label: string) => buttons().some((t) => t.startsWith(label));
type Switch = { scope: string; active: boolean };
const tenantActive = async () =>
  (await (await c.as("owner")).json<{ items: Switch[] }>("/v1/kill-switches")).items.some((k) => k.scope === "tenant" && k.active);

describe("CLEAR rights for the tenant stop", () => {
  test("KILL: a member sees neither stop nor clear; an owner can stop", async () => {
    await renderReal(c, "/digest", "member");
    await until(() => main().textContent!.includes("morning digest") || main().textContent!.includes("Waiting for you"), "digest");
    expect(has("Stop all sending")).toBe(false);
    expect(has("Clear the stop")).toBe(false);
    cleanup();
    await renderReal(c, "/digest", "owner");
    await until(() => has("Stop all sending"), "stop button");
  });

  test("KILL: a stop an owner set is not offered to an admin to clear (the server refuses it too), and the owner clears it", async () => {
    const owner = await c.as("owner");
    await owner.api.post("/v1/kill-switches", { scope: "tenant", targetId: null, reason: "Audit week" });
    const admin = await c.as("admin");
    const refused = await admin.api.delete("/v1/kill-switches/tenant/null").catch((e: unknown) => e);
    expect((refused as { code: string }).code).toBe("forbidden");

    await renderReal(c, "/digest", "admin");
    await until(() => main().textContent!.includes("All sending is stopped"), "stop banner");
    expect(has("Clear the stop")).toBe(false);
    expect(has("Stop all sending")).toBe(false);
    cleanup();

    await renderReal(c, "/digest", "owner");
    await until(() => has("Clear the stop"), "clear button");
    await act(async () => {
      fireEvent.click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Clear the stop"))!);
    });
    const form = document.getElementById("clear-form") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
    });
    await until(() => !main().textContent!.includes("All sending is stopped"), "stop cleared");
    expect(await tenantActive()).toBe(false);
  });

  test("KILL: a stop an admin set is offered to the admin to clear", async () => {
    const admin = await c.as("admin");
    await admin.api.post("/v1/kill-switches", { scope: "tenant", targetId: null, reason: "Vendor outage" });
    await renderReal(c, "/digest", "admin");
    await until(() => has("Clear the stop"), "clear button");
    await admin.api.delete("/v1/kill-switches/tenant/null");
    expect(await tenantActive()).toBe(false);
  });
});
