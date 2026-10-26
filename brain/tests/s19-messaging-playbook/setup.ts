// Shared s19 setup: the three personas as playbook inputs, and a founder world (fixture week, tone pack, outreach
// workflow with the fixture facts) for the dry run and the API.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { RECRUITER_FACTS, RECRUITER_MESSAGES, SUPPORT_FACTS, SUPPORT_MESSAGES } from "../../fixtures/playbook-personas.ts";
import { FIXTURE_FACTS, SENT_MAIL } from "../../fixtures/sent-mail.ts";
import { analyzeHome, type Analysis } from "../../src/analyze.ts";
import { DEFAULT_MODELS, StubModel, type Model } from "../../src/models/model.ts";
import { buildPlaybook, workflowMessages, type BuildPlaybookOptions, type BuildPlaybookResult } from "../../src/playbook/build.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { FixtureMailSource } from "../../src/tone/mail-source.ts";
import { bucketCorpus, buildTonePack } from "../../src/tone/pack.ts";
import { draftWorkflow } from "../../src/workflows/drafter.ts";
import type { WorkflowJson } from "../../src/workflows/types.ts";
import { tempHome } from "../helpers.ts";

export const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

export interface Persona {
  name: "founder" | "support" | "recruiter";
  channel: PlaybookMessage["channel"];
  messages: PlaybookMessage[];
  readIds?: Set<string>;
  facts: string;
}

export async function founderPersona(): Promise<Persona> {
  const { messages, readIds } = workflowMessages({ corpus: await bucketCorpus(SENT_MAIL), cards: {} }, "investor_outreach");
  return { name: "founder", channel: "email", messages, readIds, facts: FIXTURE_FACTS };
}

export const supportPersona = (): Persona => ({ name: "support", channel: "ticket", messages: [...SUPPORT_MESSAGES], facts: SUPPORT_FACTS });
export const recruiterPersona = (): Persona => ({ name: "recruiter", channel: "dm", messages: [...RECRUITER_MESSAGES], facts: RECRUITER_FACTS });

export async function personas(): Promise<Persona[]> {
  return [await founderPersona(), supportPersona(), recruiterPersona()];
}

export function build(p: Persona, model: Model | null = new StubModel(), extra: Partial<BuildPlaybookOptions> = {}): Promise<BuildPlaybookResult> {
  return buildPlaybook({ workflowId: "wf_test", channel: p.channel, messages: p.messages, ...(p.readIds === undefined ? {} : { readIds: p.readIds }), facts: p.facts, model, now: NOW, ...extra });
}

/** Names, companies, addresses and private figures of each persona that must never reach a playbook or a prompt. */
export const PERSONAL: Record<Persona["name"], string[]> = {
  founder: ["Muhammad", "Offload", "offload.so", "+44", "7700", "2.5M", "$2.5", "Anna", "Northzone", "Spotify", "Raycast", "James", "Accel", "Priya", "LocalGlobe", "Balderton", "Nina", "Hustle", "Leo"],
  support: ["Jordan", "Brightcart", "brightcart", "415", "Maria", "Kwame", "Leeds", "Elm Street", "SPRING15", "48213", "$64", "Amira", "Noah"],
  recruiter: ["Taylor", "Fernway", "Hana", "Sato", "Stripe", "Algolia", "Monzo", "Deliveroo", "GoCardless", "Figma", "London", "£120k", "120k"],
};

export function containsWord(text: string, w: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${w.replace(/[.$+£]/g, "\\$&")}($|[^A-Za-z0-9])`).test(text);
}

export interface World {
  home: string;
  cleanup: () => void;
  analysis: Analysis;
  model: StubModel;
  outreach: WorkflowJson;
}

/** The fixture week, analysed, the founder's tone pack and the outreach workflow with the fixture facts. */
export async function world(): Promise<World> {
  const { home, cleanup } = tempHome();
  writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
  const analysis = await analyzeHome(home, { now: () => NOW });
  const model = new StubModel();
  await buildTonePack({ home, source: new FixtureMailSource(), model, models: DEFAULT_MODELS, now: () => NOW });
  const { workflow } = draftWorkflow({ home, analysis, insightId: analysis.insights[0]!.id, facts: FIXTURE_FACTS, now: () => NOW });
  return { home, cleanup, analysis, model, outreach: workflow };
}

export function writeFacts(home: string, wfId: string, text: string): void {
  writeFileSync(join(home, "workflows", wfId, "facts.md"), text);
}
