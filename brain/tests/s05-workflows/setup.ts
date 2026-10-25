// Shared s05 setup: the seeded fixture week, analysed, a stub-built tone pack and the outreach workflow drafted.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { analyzeHome, type Analysis } from "../../src/analyze.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { FixtureMailSource } from "../../src/tone/mail-source.ts";
import { buildTonePack } from "../../src/tone/pack.ts";
import { draftWorkflow } from "../../src/workflows/drafter.ts";
import type { WorkflowJson } from "../../src/workflows/types.ts";
import { tempHome } from "../helpers.ts";

export const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

export interface World {
  home: string;
  cleanup: () => void;
  analysis: Analysis;
  model: StubModel;
  outreach: WorkflowJson;
}

export async function world(opts: { tone?: boolean } = {}): Promise<World> {
  const { home, cleanup } = tempHome();
  writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
  const analysis = await analyzeHome(home, { now: () => NOW });
  const model = new StubModel();
  if (opts.tone !== false) await buildTonePack({ home, source: new FixtureMailSource(), model, models: DEFAULT_MODELS, now: () => NOW });
  const first = analysis.insights[0]!;
  const { workflow } = draftWorkflow({ home, analysis, insightId: first.id, facts: FIXTURE_FACTS, now: () => NOW });
  return { home, cleanup, analysis, model, outreach: workflow };
}

export function writeRecipients(home: string, wfId: string, rows: string[]): void {
  writeFileSync(join(home, "workflows", wfId, "recipients.csv"), ["email,first_name,last_name,org,notes", ...rows].join("\n") + "\n");
}
