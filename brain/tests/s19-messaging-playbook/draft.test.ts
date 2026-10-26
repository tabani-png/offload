// SUCCESSOR: a different person's tone pack + the founder's playbook -> the founder's MESSAGE in the successor's
// voice. DRYRUN: "follows the playbook: yes / partly / no" per draft with the rule; live runs draft with it too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FOUNDER_ONLY, SUCCESSOR_FACTS, SUCCESSOR_MAIL } from "../../fixtures/playbook-personas.ts";
import { FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { DEFAULT_MODELS, StubModel, tagged } from "../../src/models/model.ts";
import { buildWorkflowPlaybook } from "../../src/playbook/build.ts";
import { checkPlaybook, readDraft } from "../../src/playbook/check.ts";
import { readPlaybook } from "../../src/playbook/store.ts";
import type { Playbook } from "../../src/playbook/types.ts";
import { draftInTone, type DraftResult } from "../../src/tone/draft.ts";
import { FixtureMailSource } from "../../src/tone/mail-source.ts";
import { buildTonePack, loadTonePack, type TonePack } from "../../src/tone/pack.ts";
import { pinFiles } from "../../src/workflows/autorun.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { prepareLiveBatch } from "../../src/workflows/runner.ts";
import { updateWorkflow } from "../../src/workflows/store.ts";
import { tempHome } from "../helpers.ts";
import { build, containsWord, founderPersona, NOW, PERSONAL, world, writeFacts, type World } from "./setup.ts";

let founderPb: Playbook;
let successor: TonePack;
let succHome: { home: string; cleanup: () => void };
const drafts: DraftResult[] = [];
let model: StubModel;
const RECIPIENTS = [
  { email: "kim@harbourfund.vc", firstName: "Kim", org: "Harbour Fund" },
  { email: "jo@northlight.vc", firstName: "Jo", org: "Northlight" },
  { email: "sam@quayside.vc", firstName: "Sam", org: "Quayside" },
];

beforeAll(async () => {
  founderPb = (await build(await founderPersona())).playbook;
  succHome = tempHome();
  await buildTonePack({ home: succHome.home, source: new FixtureMailSource(SUCCESSOR_MAIL), model: new StubModel(), models: DEFAULT_MODELS, now: () => NOW });
  successor = loadTonePack(succHome.home, NOW)!;
  model = new StubModel();
  for (const r of RECIPIENTS) drafts.push(await draftInTone({ pack: successor, bucket: "investor_outreach", recipient: r, subject: `Offload seed round: ${r.org}`, facts: SUCCESSOR_FACTS, model, models: DEFAULT_MODELS, playbook: founderPb }));
});
afterAll(() => succHome.cleanup());

describe("s19 successor", () => {
  test("SUCCESSOR: the successor has no outreach emails of their own; their voice comes from all their sent mail", () => {
    expect(successor.corpus.some((e) => e.bucket === "investor_outreach")).toBe(false);
    for (const d of drafts) {
      expect(d.examplesUsed.length).toBeGreaterThanOrEqual(3);
      expect(d.examplesUsed.every((id) => id.startsWith("succ_"))).toBe(true);
    }
  });

  test("SUCCESSOR: drafts keep the founder's angle: the core message and the traction proof", () => {
    for (const d of drafts) {
      expect(d.body).toContain("watches a week of your work and automates the parts that repeat");
      expect(d.body).toContain("40 design partners, 3 paying");
      const r = readDraft(d.body);
      expect(r.moves).toContain("claim");
      expect(r.proof).toContain("traction");
    }
  });

  test("SUCCESSOR: drafts keep the founder's ask: a meeting", () => {
    for (const d of drafts) {
      expect(readDraft(d.body).cta).toBe("meeting");
      expect(checkPlaybook(d.body, founderPb).rules.find((x) => x.id === "cta")!.pass).toBe(true);
    }
  });

  test("SUCCESSOR: drafts are in the successor's voice: their greeting, closing line and name", () => {
    RECIPIENTS.forEach((r, i) => {
      const body = drafts[i]!.body;
      expect(body.startsWith(`Hello ${r.firstName},`)).toBe(true);
      expect(body.trimEnd().endsWith("Kind regards,\nDana")).toBe(true);
      expect(body).toMatch(/\n\nCould we find time for a call this week[^\n]*\?\n\n/);
    });
  });

  test("SUCCESSOR: no draft carries the founder's name, sign-off or phrases", () => {
    for (const d of drafts) for (const p of FOUNDER_ONLY) expect(d.body).not.toContain(p);
    for (const d of drafts) expect(d.warnings.filter((w) => w.startsWith("does not sign off"))).toEqual([]);
  });

  test("SUCCESSOR: the drafting prompt carries the playbook as an untrusted block with nothing personal in it", () => {
    const calls = model.calls.filter((c) => c.role === "draft");
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.prompt).toContain('<playbook untrusted="true">');
      expect(c.system).toContain("## The playbook");
      const block = tagged(c.prompt, "playbook")!;
      expect(block).toContain("template: {greeting} {claim} {proof} {ask} {sign_off}");
      for (const w of PERSONAL.founder) expect(containsWord(block, w)).toBe(false);
      expect(tagged(c.prompt, "examples")).not.toContain("Muhammad");
    }
  });

  test("SUCCESSOR: every successor draft follows the founder's playbook", () => {
    for (const d of drafts) expect(checkPlaybook(d.body, founderPb).verdict).toBe("yes");
  });
});

describe("s19 dry run and live runs", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(() => w.cleanup());

  test("DRYRUN: without a playbook a dry run is unchanged (no playbook verdict)", async () => {
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
    expect(r.instances.length).toBe(5);
    for (const i of r.instances) expect(i.playbook).toBeUndefined();
  });

  test("DRYRUN: with a playbook each draft says whether it follows it, rule by rule", async () => {
    const pb = await buildWorkflowPlaybook(w.home, w.outreach, w.model, NOW);
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
    expect(r.instances.length).toBe(5);
    for (const i of r.instances) {
      expect(i.playbook).toMatchObject({ version: pb.version, verdict: "yes" });
      expect(i.playbook!.rules.map((x) => x.id)).toEqual(pb.rules.filter((x) => x.check !== undefined).map((x) => x.id));
      expect(i.draft!.trimEnd().endsWith("Muhammad")).toBe(true);
    }
  });

  test("DRYRUN: a draft that breaks a rule is 'partly' and names the rule it broke", async () => {
    writeFacts(w.home, w.outreach.id, FIXTURE_FACTS.replace("ask: Worth 20 minutes next week?", "ask: Any thoughts on the deck?"));
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
    for (const i of r.instances) {
      expect(i.playbook!.verdict).toBe("partly");
      const failed = i.playbook!.rules.filter((x) => !x.pass);
      expect(failed.map((x) => x.id)).toEqual(["cta"]);
      expect(failed[0]!.text).toBe("End with one ask: a short meeting or call, with a time box.");
    }
    writeFacts(w.home, w.outreach.id, FIXTURE_FACTS);
  });

  test("DRYRUN: 'no' when most rules fail: long, linked, many questions, no proof, no ask", () => {
    const long = Array.from({ length: 30 }, () => "We do many things here and there for everyone.").join(" ");
    const v = checkPlaybook(`Hi Kim,\n\n${long} See https://example.com and https://example.org? Why? How? When?\n\nMuhammad`, founderPb);
    expect(v.verdict).toBe("no");
    expect(v.rules.filter((x) => !x.pass).map((x) => x.id)).toEqual(expect.arrayContaining(["claim", "proof", "length", "links", "questions"]));
  });

  test("DRYRUN: a live run drafts with the playbook too", async () => {
    writeFileSync(join(w.home, "workflows", w.outreach.id, "recipients.csv"), ["email,first_name,last_name,org,notes", "kim@harbourfund.vc,Kim,,Harbour Fund,", "jo@northlight.vc,Jo,,Northlight,"].join("\n") + "\n");
    updateWorkflow(w.home, w.outreach.id, (x) => {
      x.status = "active";
      x.activatedAt = NOW;
    }, NOW);
    const m = new StubModel();
    const batch = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: m, now: () => NOW });
    expect(batch.items).toHaveLength(2);
    for (const c of m.calls.filter((x) => x.role === "draft")) expect(c.prompt).toContain('<playbook untrusted="true">');
    for (const it of batch.items) expect(checkPlaybook(it.body, readPlaybook(w.home, w.outreach.id)!).verdict).toBe("yes");
  });

  test("DRYRUN: auto-run pins playbook.json once the workflow has one", async () => {
    expect(Object.keys(pinFiles(w.home, w.outreach))).toContain("playbook.json");
    const fresh = await world();
    try {
      expect(Object.keys(pinFiles(fresh.home, fresh.outreach))).not.toContain("playbook.json");
    } finally {
      fresh.cleanup();
    }
  });
});
