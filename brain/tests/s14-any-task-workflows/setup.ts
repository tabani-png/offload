// Shared s14 fixtures: each s12 persona week written once (plain store + frame-note sidecar), analysed with v2 at the
// fixture's own "now"; fresh copies of a home for tests that write workflows.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePersona, writePersona, type PersonaId, type PersonaWeek } from "../../fixtures/gen-domains.ts";
import { REPORT_START, reportNow } from "../../fixtures/domains-report.ts";
import { analyzeHome, type Analysis, type Insight } from "../../src/analyze.ts";
import { StubModel } from "../../src/models/model.ts";
import { draftGeneralWorkflow } from "../../src/workflows/drafter.ts";
import type { WorkflowJson } from "../../src/workflows/types.ts";

export const SEED = 7;
export { REPORT_START, reportNow };
export const NOW = reportNow();

export interface Persona {
  home: string;
  week: PersonaWeek;
  v2: Analysis;
}

const cache = new Map<PersonaId, Promise<Persona>>();
const homes: string[] = [];

export function tmp(prefix = "offload-s14t-"): string {
  const h = mkdtempSync(join(tmpdir(), prefix));
  homes.push(h);
  return h;
}

export function persona(p: PersonaId): Promise<Persona> {
  let hit = cache.get(p);
  if (hit === undefined) {
    hit = (async () => {
      const home = tmp(`offload-s14t-${p}-`);
      const week = generatePersona(p, { seed: SEED, startDay: REPORT_START });
      writePersona(home, week, { encrypted: false, seed: SEED });
      const v2 = await analyzeHome(home, { now: reportNow, understanding: "v2" });
      return { home, week, v2 };
    })();
    cache.set(p, hit);
  }
  return hit;
}

/** A copy of a persona home without workflows, for tests that write. */
export async function freshHome(p: PersonaId): Promise<{ home: string; v2: Analysis; week: PersonaWeek }> {
  const base = await persona(p);
  const home = tmp(`offload-s14w-${p}-`);
  cpSync(base.home, home, { recursive: true, filter: (src) => !src.includes("/workflows") });
  return { home, v2: base.v2, week: base.week };
}

/** The insight of a persona's ground-truth task (by its apps). */
export function truthInsight(a: Analysis, apps: readonly string[]): Insight {
  const i = a.insights.find((x) => {
    const s = new Set((x.profile.understanding?.surfaces ?? []).flatMap((u) => [u.app, u.host]));
    return apps.every((app) => s.has(app));
  });
  if (i === undefined) throw new Error(`no insight with ${apps.join(",")}`);
  return i;
}

export async function draftFor(home: string, a: Analysis, insight: Insight, model = new StubModel()): Promise<WorkflowJson> {
  const { workflow } = await draftGeneralWorkflow({ home, analysis: a, insightId: insight.id, model, now: () => NOW });
  return workflow;
}

process.on("exit", () => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
