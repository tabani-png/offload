// KNOWN: the s12 personas get the right workflow: step types in order, every commit gated behind the approval step,
// capability targets in the persona's apps, and a dry run with per-instance output of the persona's output type.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { StubModel } from "../../src/models/model.ts";
import { chosenVariant } from "../../src/plan/build.ts";
import { draftWorkflow, isGeneralInsight } from "../../src/workflows/drafter.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { draftFor, freshHome, NOW } from "./setup.ts";
import type { PersonaId } from "../../fixtures/gen-domains.ts";

interface Want {
  persona: PersonaId;
  apps: string[];
  out: string;
  types: string[];
  targets: string[];
}

const CASES: Want[] = [
  { persona: "recruiter", apps: ["com.apple.Preview", "app.greenhouse.io"], out: "stage_change", types: ["read", "decide", "transform", "draft", "commit"], targets: ["app-preview", "greenhouse"] },
  { persona: "bookkeeper", apps: ["com.apple.Preview", "go.xero.com"], out: "form_fields", types: ["read", "transform", "commit"], targets: ["app-preview", "xero"] },
  { persona: "support", apps: ["acme.zendesk.com"], out: "ticket_reply", types: ["read", "decide", "read", "draft", "commit"], targets: ["zendesk", "web-admin-shopify-com"] },
  { persona: "salesops", apps: ["docs.google.com", "www.linkedin.com"], out: "rows", types: ["read", "read", "transform", "commit"], targets: ["google-sheets", "linkedin"] },
  { persona: "mixed", apps: ["com.apple.Preview", "go.xero.com"], out: "form_fields", types: ["read", "transform", "commit"], targets: ["xero"] },
  { persona: "mixed", apps: ["acme.zendesk.com"], out: "ticket_reply", types: ["read", "decide", "read", "draft", "commit"], targets: ["zendesk"] },
];

describe("s14 known answers on the s12 personas", () => {
  for (const c of CASES) {
    test(`KNOWN: ${c.persona} (${c.out}) gets ${c.types.join(" > ")}, gated commits and a ${c.out} dry run`, async () => {
      const { home, v2 } = await freshHome(c.persona);
      const insight = v2.insights.find((i) => {
        const s = new Set((i.profile.understanding?.surfaces ?? []).flatMap((u) => [u.app, u.host]));
        return c.apps.every((a) => s.has(a));
      })!;
      expect(insight).toBeDefined();
      expect(isGeneralInsight(v2, insight.id)).toBe(true);
      const wf = await draftFor(home, v2, insight);
      const plan = wf.plan!;
      expect(plan.outputType).toBe(c.out as typeof plan.outputType);
      const v = chosenVariant(plan);
      expect(v.steps.map((s) => s.type)).toEqual(c.types as typeof v.steps[number]["type"][]);
      // Every commit is gated, and the legacy steps put the approval step before the first side effect.
      expect(v.steps.filter((s) => s.type === "commit").every((s) => s.gated)).toBe(true);
      const firstSide = wf.steps.findIndex((s) => s.sideEffect);
      expect(firstSide).toBeGreaterThan(0);
      expect(wf.steps.findIndex((s) => s.type === "approval_gate")).toBe(firstSide - 1);
      expect(wf.steps.filter((s) => s.sideEffect).every((s) => s.tool === undefined)).toBe(true);
      expect(wf.autoRun).toBe(false);
      const targets = new Set(plan.variants.flatMap((x) => x.steps.flatMap((s) => (s.capability === null ? [] : [s.capability.target]))));
      for (const t of c.targets) expect(targets.has(t)).toBe(true);
      const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 5 });
      expect(r.general).toBeDefined();
      expect(r.general!.outputType).toBe(plan.outputType);
      expect(r.general!.instances.length).toBe(5);
      for (const i of r.general!.instances) {
        expect(i.ours.kind).toBe(plan.outputType);
        expect(i.evidence.eventIds.length).toBeGreaterThan(0);
        expect(i.estimate.observedMinutes).toBeGreaterThan(0);
      }
      expect(r.sideEffects.attempted).toBeGreaterThan(0);
      expect(r.sideEffects.denied).toBe(r.sideEffects.attempted);
    });
  }

  test("KNOWN: bookkeeper bills are filled with the exact values the user typed (copied by code)", async () => {
    const { home, v2 } = await freshHome("bookkeeper");
    const insight = v2.insights[0]!;
    const wf = await draftFor(home, v2, insight);
    const r = await dryRun({ home, analysis: v2, workflowId: wf.id, model: new StubModel(), now: () => NOW, limit: 10 });
    const g = r.general!;
    expect(g.totals.agreement).toBe(1);
    for (const i of g.instances) {
      expect(i.ours.fields.map((f) => f.label)).toEqual(["From", "Reference", "Total"]);
      expect(i.theirs.fields).toEqual(i.ours.fields);
      expect(i.commit).toMatchObject({ tool: "xero", verb: "create_bill" });
    }
  });

  test("KNOWN: the support plan keeps the occasional order lookup behind a decide, and wins the probe with it", async () => {
    const { home, v2 } = await freshHome("support");
    const wf = await draftFor(home, v2, v2.insights[0]!);
    const plan = wf.plan!;
    expect(plan.chosen).toBe("a");
    const [a, b] = plan.probe;
    expect(a!.agreement).toBeGreaterThan(b!.agreement);
    const lookup = chosenVariant(plan).steps.find((s) => s.capability?.target === "web-admin-shopify-com")!;
    expect(lookup.when).toBe("when the item names order number");
  });

  test("KNOWN: the founder week (gen.ts) still drafts the investor outreach email template", async () => {
    const home = mkdtempSync(join(tmpdir(), "offload-s14-founder-"));
    try {
      writeFixture(home, generateFixture({ seed: 42, startDay: "2026-10-12" }), { encrypted: false, seed: 42 });
      const a = await analyzeHome(home, { now: () => NOW });
      const top = a.insights[0]!;
      expect(top.label.kind).toBe("email.outreach");
      expect(isGeneralInsight(a, top.id)).toBe(false);
      const { workflow } = draftWorkflow({ home, analysis: a, insightId: top.id });
      expect(workflow.template).toBe("investor_outreach");
      expect(workflow.plan).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
