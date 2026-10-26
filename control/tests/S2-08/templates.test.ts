import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, type Harness } from "../helpers/harness.ts";
import {
  COMPLIANCE_DIR, COUNSEL_LINE, listTemplates, parseTemplate, templateById, unfilledFields, type Template,
} from "../../src/modules/compliance/templates.ts";
import { PERSON_COLUMNS } from "../../src/modules/compliance/selfview.ts";
import { noticeBody, signIn, type Who } from "./fixtures.ts";

const TEMPLATE_IDS = [
  "ontario-esa-policy", "ct-posting", "ny-notice-and-ack", "de-daily-notice", "bc-ab-notification", "quebec-8-1-8-2",
  "ca-notice-at-collection", "uk-eu-transparency", "dpia", "ca-risk-assessment", "de-works-agreement",
];

let h: Harness;
let who: Who;
beforeAll(async () => {
  h = await createHarness();
  who = await signIn(h);
});
afterAll(() => h.close());

/** The template body with every `{{field}}` replaced by "Value for <field>" (or the override). */
function fillAll(t: Template, over: Record<string, string> = {}): string {
  return t.body.replace(/\{\{([a-z_]+)\}\}/g, (_, f: string) => over[f] ?? `Value for ${f}`);
}

const read = (rel: string) => readFileSync(join(COMPLIANCE_DIR, rel), "utf8");

describe("TEMPLATES", () => {
  test.each(TEMPLATE_IDS)("TEMPLATES: %s exists with frontmatter id, title, jurisdictions and requiredFields", (id) => {
    const t = parseTemplate(read(`templates/${id}.md`));
    expect(t.id).toBe(id);
    expect(t.title.length).toBeGreaterThan(5);
    expect(t.jurisdictions.length).toBeGreaterThan(0);
    for (const j of t.jurisdictions) expect(j).toMatch(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);
    expect(t.requiredFields.length).toBeGreaterThan(0);
  });

  test.each(TEMPLATE_IDS)("TEMPLATES: %s carries the counsel line and a placeholder for every required field", (id) => {
    const t = parseTemplate(read(`templates/${id}.md`));
    expect(t.body).toContain(COUNSEL_LINE);
    for (const f of t.requiredFields) expect(t.body).toContain(`{{${f}}}`);
  });

  test("TEMPLATES: the Ontario policy has the ESA Part XI.1 fields: how, circumstances, purposes, date prepared, dates changed", () => {
    const t = parseTemplate(read("templates/ontario-esa-policy.md"));
    expect(t.jurisdictions).toEqual(["CA-ON"]);
    for (const f of ["how", "circumstances", "purposes", "date_prepared", "dates_changed"]) {
      expect(t.requiredFields).toContain(f);
      expect(t.body).toContain(`{{${f}}}`);
    }
    expect(t.body).toMatch(/3 years/);
  });

  test("TEMPLATES: the counsel line is the exact phrase, at the top of every template", () => {
    expect(COUNSEL_LINE).toBe("Not legal advice; review by counsel before use.");
    for (const id of TEMPLATE_IDS) {
      const firstLines = parseTemplate(read(`templates/${id}.md`)).body.trim().split("\n").slice(0, 4).join("\n");
      expect(firstLines).toContain(COUNSEL_LINE);
    }
  });

  test("TEMPLATES: the folder holds exactly the templates the SPEC names", () => {
    expect(listTemplates().map((t) => t.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });

  test("TEMPLATES: the data map names every table that holds a person id", () => {
    const map = read("data-map.md");
    expect(map).toContain(COUNSEL_LINE);
    for (const t of new Set(PERSON_COLUMNS.map((c) => c.table))) expect(map).toContain(`\`${t}\``);
  });

  test("TEMPLATES: the DPA lists the sub-processors (Managed Agents not ZDR, Composio, WorkOS, host TBD)", () => {
    expect(existsSync(join(COMPLIANCE_DIR, "dpa-subprocessors.md"))).toBe(true);
    const dpa = read("dpa-subprocessors.md");
    expect(dpa).toContain(COUNSEL_LINE);
    expect(dpa).toMatch(/Managed Agents/);
    expect(dpa).toMatch(/not (covered by )?zero data retention|not ZDR/i);
    expect(dpa).toMatch(/Composio/);
    expect(dpa).toMatch(/WorkOS/);
    expect(dpa).toMatch(/TBD/);
  });

  test("TEMPLATES: owner, admin and auditor list templates (id, title, jurisdictions); leads and members may not", async () => {
    for (const k of ["owner", "admin", "auditor"] as const) {
      const r = await who[k].get("/v1/compliance/templates");
      expect(r.status).toBe(200);
      expect(r.json.items.map((t: { id: string }) => t.id).sort()).toEqual([...TEMPLATE_IDS].sort());
      for (const t of r.json.items) expect(Object.keys(t).sort()).toEqual(["id", "jurisdictions", "title"]);
    }
    expect((await who.lead.get("/v1/compliance/templates")).status).toBe(403);
    expect((await who.member.get("/v1/compliance/templates")).status).toBe(403);
  });

  test("TEMPLATES: a notice can be drafted from every template id", async () => {
    for (const id of TEMPLATE_IDS) {
      expect((await who.admin.post("/v1/compliance/notices", noticeBody({ template: id }))).status).toBe(201);
    }
  });

  test("TEMPLATES: a notice that drops a required section or labelled line reports those fields as unfilled", () => {
    const on = templateById("ontario-esa-policy")!;
    expect(unfilledFields(on, "# Policy\nNothing here.").sort()).toEqual([...on.requiredFields].sort());
    const ny = templateById("ny-notice-and-ack")!;
    expect(unfilledFields(ny, "hello").sort()).toEqual([...ny.requiredFields].sort());
    // Only the "How we monitor" section (heading and text) is gone: that field alone is missing.
    const noHow = fillAll(on).replace(/## How we monitor\nValue for how\n/, "");
    expect(noHow).not.toContain("How we monitor");
    expect(unfilledFields(on, noHow)).toEqual(["how"]);
    // Only the "Date this policy was prepared" line is gone.
    const noDate = fillAll(on).replace(/\*\*Date this policy was prepared:\*\* .*\n/, "");
    expect(unfilledFields(on, noDate)).toEqual(["date_prepared"]);
  });

  test("TEMPLATES: filler (TBD, TODO, ..., -) is not a value for a required field", () => {
    const ny = templateById("ny-notice-and-ack")!;
    expect(unfilledFields(ny, ny.body.replace(/\{\{[a-z_]+\}\}/g, "TBD")).sort()).toEqual([...ny.requiredFields].sort());
    const on = templateById("ontario-esa-policy")!;
    for (const filler of ["TBD", "todo", "TBC.", "...", "-", "?", "XXX", "<fill in>", "[placeholder]"]) {
      expect(unfilledFields(on, fillAll(on, { how: filler }))).toEqual(["how"]);
      expect(unfilledFields(on, fillAll(on, { date_prepared: filler }))).toEqual(["date_prepared"]);
    }
  });

  test.each(TEMPLATE_IDS)("TEMPLATES: %s filled with real values has nothing unfilled", (id) => {
    const t = templateById(id)!;
    expect(unfilledFields(t, fillAll(t))).toEqual([]);
  });

  test("TEMPLATES: a field filled under its label still counts when another mention (the counsel note) is edited away", () => {
    const on = templateById("ontario-esa-policy")!;
    const noNote = fillAll(on).replace(/^> .*\n> .*\n/m, "> Reviewed by counsel.\n");
    expect(noNote).not.toContain("starting draft");
    expect(unfilledFields(on, noNote)).toEqual([]);
  });

  test("TEMPLATES: frontmatter parsing rejects a template without its fields", () => {
    expect(() => parseTemplate("no frontmatter")).toThrow();
    expect(() => parseTemplate("---\nid: x\n---\nbody")).toThrow(/jurisdictions/);
  });
});
