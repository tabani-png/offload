import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { renderSop, type SopInput } from "../../src/modules/registry/sop/template.ts";
import { stripDefinition } from "../../src/modules/registry/strip.ts";
import { definitionHash } from "../../src/modules/registry/hash.ts";
import { holdJobRole, promoteBody, proposal, propose, versionBody } from "./fixtures.ts";

const GOLDEN = join(import.meta.dir, "golden/sop-investor-outreach-v2.md");

/** A fixed SOP input: the stripped fixture as version 2 of a role workflow, with fixed ids and times. */
function goldenInput(): SopInput {
  const p = proposal();
  const steps = p.steps
    .filter((s) => s.id !== "post_linkedin")
    .map((s) =>
      s.connection === null
        ? s
        : { ...s, connection: { kind: "m365_shared_mailbox" as const, ownership: "company" as const, connectionId: "11111111-1111-4111-8111-111111111111", label: "Sales shared mailbox" } },
    );
  const def = stripDefinition({ ...p, steps, workflowId: "22222222-2222-4222-8222-222222222222", version: 2 });
  return {
    workflow: { id: "22222222-2222-4222-8222-222222222222", name: def.name, state: "role", latestVersion: 2 },
    jobRole: { name: "SDR" },
    department: { name: "Sales" },
    version: 2,
    definition: def,
    history: [
      { version: 1, definitionHash: "a".repeat(64), createdAt: Date.UTC(2026, 9, 26, 9, 0, 0) },
      { version: 2, definitionHash: definitionHash(def), createdAt: Date.UTC(2026, 9, 27, 14, 30, 0) },
    ],
  };
}

let h: Harness;
let roleId: string;
beforeAll(async () => {
  h = await createHarness();
  await holdJobRole(h, h.a, h.a.jobRoles.sdr, h.a.people.member.id);
  const { id } = await propose(h);
  const admin = await asPrincipal(h, "admin");
  expect((await admin.post(`/v1/workflows/${id}/promote`, promoteBody(h.a))).status).toBe(200);
  h.clock.advance(86_400_000);
  const later = await asPrincipal(h, "admin"); // sessions idle out over a day
  const v1 = (await later.get(`/v1/workflows/${id}/versions/1`)).json;
  expect((await later.post(`/v1/workflows/${id}/versions`, versionBody(v1, (d) => { d.description = "Second version."; }))).status).toBe(200);
  roleId = id;
});
afterAll(async () => {
  await h.close();
});

async function sop(path: string, who: "admin" | "member" | "auditor" = "admin") {
  const c = await asPrincipal(h, who);
  const res = await h.app.request(`http://control.test${path}`, { headers: { Cookie: c.cred.cookie } });
  return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
}

describe("SOP", () => {
  test("SOP: the template renders the golden Markdown bytes", () => {
    expect(renderSop(goldenInput())).toBe(readFileSync(GOLDEN, "utf8"));
  });

  test("SOP: same input, same bytes, whatever the key order of the definition", () => {
    const a = goldenInput();
    const b = goldenInput();
    b.definition = Object.fromEntries(Object.entries(b.definition).reverse()) as SopInput["definition"];
    expect(renderSop(b)).toBe(renderSop(a));
  });

  test("SOP: the golden SOP has every section of ADR 0104 §7", () => {
    const md = renderSop(goldenInput());
    for (const s of ["## Purpose", "## Trigger", "## Steps", "## Rules", "## Gates", "## Connections", "## Owner", "## Version history"]) {
      expect(md).toContain(s);
    }
  });

  test("SOP: GET ...sop?format=md answers text/markdown, byte-identical on repeat", async () => {
    const a = await sop(`/v1/workflows/${roleId}/versions/2/sop?format=md`);
    const b = await sop(`/v1/workflows/${roleId}/versions/2/sop`);
    expect(a.status).toBe(200);
    expect(a.type).toContain("text/markdown");
    expect(b.text).toBe(a.text);
    expect(a.text).toContain("Owner job role: SDR");
    expect(a.text).toContain("Second version.");
  });

  test("SOP: an earlier version renders itself with the full history", async () => {
    const r = await sop(`/v1/workflows/${roleId}/versions/1/sop`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("version 1 of 2");
    expect(r.text).toMatch(/\| 1 \|[^\n]*\n\| 2 \|/);
    expect((await sop(`/v1/workflows/${roleId}/versions/3/sop`)).status).toBe(404);
  });

  test("SOP: no connection secrets, ids or external refs in the output", async () => {
    const r = await sop(`/v1/workflows/${roleId}/versions/2/sop`);
    const refs = await h.db.migrator`select id, external_ref from connections where tenant_id = ${h.a.id}`;
    for (const c of refs) {
      expect(r.text).not.toContain(c.id as string);
      expect(r.text).not.toContain(c.external_ref as string);
    }
    expect(r.text).not.toContain("ref_");
    expect(r.text).not.toMatch(/https?:\/\//);
    expect(r.text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(renderSop(goldenInput())).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  test("SOP: format=pdf is 501 until a PDF dependency is approved", async () => {
    const r = await (await asPrincipal(h, "admin")).get(`/v1/workflows/${roleId}/versions/2/sop?format=pdf`);
    expect(r.status).toBe(501);
    expect(r.json.error.details).toEqual({ reason: "not_implemented" });
  });

  test("SOP: an unknown format is 400", async () => {
    const r = await (await asPrincipal(h, "admin")).get(`/v1/workflows/${roleId}/versions/2/sop?format=docx`);
    expect(r.status).toBe(400);
  });

  test("SOP: a member holding the job role and an auditor may export it", async () => {
    expect((await sop(`/v1/workflows/${roleId}/versions/2/sop`, "member")).status).toBe(200);
    expect((await sop(`/v1/workflows/${roleId}/versions/2/sop`, "auditor")).status).toBe(200);
  });

  test("SOP: a proposal has no SOP until it is promoted", async () => {
    const { id } = await propose(h);
    const r = await (await asPrincipal(h, "admin")).get(`/v1/workflows/${id}/versions/1/sop`);
    expect(r.status).toBe(409);
  });

  test("SOP: generated from the definition alone (no clock, no model)", async () => {
    const before = await sop(`/v1/workflows/${roleId}/versions/2/sop`);
    h.clock.advance(7 * 86_400_000);
    expect((await sop(`/v1/workflows/${roleId}/versions/2/sop`)).text).toBe(before.text);
  });
});
