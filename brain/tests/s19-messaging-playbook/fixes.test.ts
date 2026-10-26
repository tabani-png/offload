// Fix round for the wave-B review (slices/S2-review/REVIEW-wave-B.md, PR #11): sentence-initial and non-Latin names,
// a re-check identity that outlives the tone pack, model errors that keep the code baseline, a corrupt playbook.json,
// and the ADR number. Each test failed before its fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import { StubModel, type ModelRequest } from "../../src/models/model.ts";
import * as readMod from "../../src/playbook/read.ts";
import { PlaybookInputError } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { addressParts, buildIdentity, emptyIdentity, maskText } from "../../src/playbook/mask.ts";
import { playbookForPromotion } from "../../src/playbook/promote.ts";
import { ruleRead } from "../../src/playbook/read.ts";
import * as storeMod from "../../src/playbook/store.ts";
import { playbookPath, readPlaybook } from "../../src/playbook/store.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { FIXTURE_FACTS } from "../../fixtures/sent-mail.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { build, containsWord, founderPersona, NOW, world, writeFacts, type World } from "./setup.ts";

const { MAX_LABEL_CALLS } = readMod;
const { IDENTITY_FILE } = storeMod;

const msg = (i: number, to: string, first: string, line: string): PlaybookMessage => ({
  id: `m${i}`,
  channel: "email",
  to: [to],
  subject: `Engineer intro ${i}`,
  body: `Hi ${first},\n\n${line} Would you have 15 minutes for a call this week?\n\nBest,\nTaylor`,
  sentAt: NOW - (10 - i) * 86_400_000,
});
// The candidate is named at the start of a sentence only, never mid-sentence, in a greeting or in an address.
const INTRO: PlaybookMessage[] = [
  msg(1, "sam@hirefast.io", "Sam", "Priya is an engineer at Ramp. She built their payments stack."),
  msg(2, "alex@talentco.io", "Alex", "Priya is an engineer who led the payments team. She is open to a move."),
  msg(3, "kai@peoplefirst.io", "Kai", "Łukasz is an engineer at a fintech. Дмитрий worked with him for years."),
];

class FailingModel extends StubModel {
  constructor(private readonly fails: (req: ModelRequest, n: number) => boolean) {
    super();
  }
  private n = 0;
  override async complete(req: ModelRequest): Promise<string> {
    this.n += 1;
    if (this.fails(req, this.n)) {
      this.calls.push(req);
      throw new Error("model unavailable");
    }
    return super.complete(req);
  }
}

describe("s19 fix: sentence-initial and non-Latin names", () => {
  test("MASK: a sentence-initial name is masked (\"Priya is an engineer at Ramp.\")", () => {
    expect(maskText("Priya is an engineer at Ramp.", emptyIdentity())).toBe("[name] is an engineer at [name].");
  });

  test("MASK: Łukasz and a Cyrillic name are masked, at the start of a sentence and in the middle", () => {
    const t = maskText("Łukasz said yes. I met Łukasz and Дмитрий today. Дмитрий agreed.", emptyIdentity());
    for (const w of ["Łukasz", "Дмитрий", "ukasz"]) expect(t).not.toContain(w);
    expect(addressParts("łukasz.nowak@firma.pl").people).toEqual(["łukasz", "nowak"]);
    const id = buildIdentity([{ ...INTRO[0]!, body: "Hi Łukasz,\n\nWould you take a call?\n\nTaylor" }]);
    expect([...id.people]).toContain("łukasz");
  });

  test("MASK: common words that start a sentence stay", () => {
    const t = "Following up on my note. Thanks for the reply. Short one: we are hiring. Would Tuesday work?";
    expect(maskText(t, emptyIdentity())).toBe(t);
  });

  test("MASK: a sentence-initial name never reaches the model or the playbook", async () => {
    const m = new StubModel();
    const r = await build({ name: "recruiter", channel: "dm", messages: INTRO, facts: "" }, m);
    expect(m.calls.length).toBeGreaterThan(0);
    const out = [...m.calls.map((c) => c.prompt), JSON.stringify(r.playbook), JSON.stringify(r.reads)].join("\n");
    for (const w of ["Priya", "Ramp", "Łukasz", "Дмитрий"]) expect(containsWord(out, w)).toBe(false);
    expect(out).not.toContain("ukasz");
  });

  test("READ: coreClaim never starts with an unmasked capitalised word", () => {
    const r = ruleRead("Priya is an engineer at a fintech. We help teams hire.", "", { id: "x", threadKey: "x", role: "first_touch", outcome: "unknown", subject: "" });
    expect(r.coreClaim).toBe("We help teams hire.");
  });

  test("LEAK: a name the model adds that is in no identity set is caught", () => {
    const id = emptyIdentity();
    expect(findTextLeaks("Mention what you liked about Zara's work.", id, new Set(), "message")).toContainEqual({ kind: "name", path: "message" });
    expect(findTextLeaks("Zara replied first.", id, new Set(), "message")).toContainEqual({ kind: "name", path: "message" });
    expect(findTextLeaks("Дмитрий replied first.", id, new Set(), "message")).toContainEqual({ kind: "name", path: "message" });
    expect(findTextLeaks("Open with a line about them. Keep it short; ask for a call on Zoom.", id, new Set(), "message")).toEqual([]);
  });

  test("LEAK: a wording model that adds a name outside the identity set is refused; the baseline stands", async () => {
    const p = await founderPersona();
    class Namer extends StubModel {
      override async complete(req: ModelRequest): Promise<string> {
        const out = await super.complete(req);
        if (req.role !== "playbook") return out;
        const j = JSON.parse(out) as { avoid: string[] };
        j.avoid.push("Writing the way Zara Okonkwo did.");
        return JSON.stringify(j);
      }
    }
    const r = await build(p, new Namer());
    expect(r.playbook.models.synthUsed).toBe(false);
    expect(r.playbook.warnings.join(" ")).toMatch(/kept a personal detail \(name/);
    expect(JSON.stringify(r.playbook)).not.toContain("Zara");
  });
});

describe("s19 fix: model errors keep the code baseline", () => {
  test("READ: a labeller error on one message uses the rule read for it; the build still completes", async () => {
    const p = await founderPersona();
    const m = new FailingModel((req, n) => req.role === "playbook_label" && n === 2);
    const r = await build(p, m);
    expect(r.reads.filter((x) => x.labelledBy === "rules")).toHaveLength(1);
    expect(r.reads.filter((x) => x.labelledBy === "model").length).toBe(r.reads.length - 1);
    expect(r.playbook.warnings.join(" ")).toMatch(/1 message was read by the rules only: the labelling model failed/);
    const rulesOnly = await build(p, null);
    expect(r.playbook.stats).toEqual(rulesOnly.playbook.stats);
  });

  test("READ: per-message labeller calls are capped; the rest are read by the rules", async () => {
    expect(MAX_LABEL_CALLS).toBeGreaterThan(0);
    expect(MAX_LABEL_CALLS).toBeLessThanOrEqual(100);
    const p = await founderPersona();
    const m = new StubModel();
    const r = await build(p, m, { maxLabelCalls: 5 });
    expect(m.calls.filter((c) => c.role === "playbook_label")).toHaveLength(5);
    expect(r.reads.filter((x) => x.labelledBy === "model")).toHaveLength(5);
    expect(r.playbook.warnings.join(" ")).toMatch(/only the first 5 messages were labelled by the model/);
  });

  test("NUMBERS: an Opus failure keeps the code baseline with a warning", async () => {
    const p = await founderPersona();
    const r = await build(p, new FailingModel((req) => req.role === "playbook"));
    const baseline = await build(p, null);
    expect(r.playbook.models.synthUsed).toBe(false);
    expect(r.playbook.warnings).toContain("the model's wording was not used: the model call failed");
    expect(r.playbook.message).toBe(baseline.playbook.message);
    expect(r.playbook.rules).toEqual(baseline.playbook.rules);
    expect(r.playbook.stats).toEqual(baseline.playbook.stats);
  });
});

describe("s19 fix: re-checks after the tone pack is gone, corrupt playbook.json", () => {
  const TOKEN = "q".repeat(40);
  let w: World;
  let brain: ReturnType<typeof createBrain>;
  const call = async (path: string, method = "GET", body?: unknown) => {
    const r = await brain.handle(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  // Facts without `sign:` and `company:`: the author and the company are known only from the sent mail.
  const THIN_FACTS = FIXTURE_FACTS.replace(/^company: .*\n/m, "").replace(/^sign: .*\n/m, "");
  beforeAll(async () => {
    w = await world();
    brain = createBrain({ home: w.home, token: TOKEN, now: () => NOW, workflows: { model: new StubModel() } });
    writeFacts(w.home, w.outreach.id, THIN_FACTS);
    expect((await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "build" })).status).toBe(200);
    rmSync(join(w.home, "tone", "corpus.jsonl.enc"));
  });
  afterAll(() => w.cleanup());

  test("PLAYBOOK: the build keeps an identity digest beside the playbook: hashed words, no name in plain text", () => {
    const p = join(w.home, "workflows", w.outreach.id, IDENTITY_FILE);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const j = JSON.parse(readFileSync(p, "utf8")) as { salt: string; author: string[]; company: string[]; names: string[] };
    const hashes = [...j.author, ...j.company, ...j.names];
    expect(j.author.length).toBeGreaterThan(0);
    expect(j.company.length).toBeGreaterThan(0);
    expect(j.names.length).toBeGreaterThan(5);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const values = JSON.stringify({ ...j, schema: undefined }).toLowerCase();
    for (const n of ["muhammad", "offload", "anna", "northzone", "spotify"]) expect(values).not.toContain(n);
  });

  test("PLAYBOOK: with the tone pack gone, notes naming the author or the company are still refused", async () => {
    const before = readPlaybook(w.home, w.outreach.id)!.version;
    for (const notes of ["Sound like muhammad does.", "Say offload is the mac app.", "Write it the way you would to anna at northzone, Anna."]) {
      const r = await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "notes", notes });
      expect(r.status).toBe(400);
    }
    expect(readPlaybook(w.home, w.outreach.id)!.version).toBe(before);
    expect((await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "notes", notes: "Keep it under the word limit." })).status).toBe(200);
  });

  test("PLAYBOOK: with the tone pack gone, promotion re-checks against the digest", () => {
    const path = playbookPath(w.home, w.outreach.id);
    const saved = readFileSync(path, "utf8");
    const pb = JSON.parse(saved) as { avoid: string[] };
    writeFileSync(path, JSON.stringify({ ...pb, avoid: [...pb.avoid, "as offload does"] }));
    expect(() => playbookForPromotion(w.home, w.outreach.id, NOW)).toThrow(/company in avoid/);
    writeFileSync(path, saved);
    expect(playbookForPromotion(w.home, w.outreach.id, NOW)).not.toBeNull();
  });

  test("PLAYBOOK: with neither tone pack nor digest, notes and promotion are refused (409), not reported re-checked", async () => {
    const p = join(w.home, "workflows", w.outreach.id, IDENTITY_FILE);
    const saved = readFileSync(p, "utf8");
    rmSync(p);
    try {
      const r = await call(`/workflows/${w.outreach.id}/playbook`, "POST", { action: "notes", notes: "Keep it short." });
      expect(r.status).toBe(409);
      expect(String(r.body.message)).toMatch(/rebuild the playbook/);
      expect(() => playbookForPromotion(w.home, w.outreach.id, NOW)).toThrow(PlaybookInputError);
    } finally {
      writeFileSync(p, saved, { mode: 0o600 });
    }
  });

  test("PLAYBOOK: a corrupt playbook.json reads as no playbook with a warning; the dry run still runs", async () => {
    const path = playbookPath(w.home, w.outreach.id);
    const saved = readFileSync(path, "utf8");
    try {
      for (const bad of ["{not json", "null", "[1,2]"]) {
        writeFileSync(path, bad);
        const warnings: string[] = [];
        expect(readPlaybook(w.home, w.outreach.id, warnings)).toBeNull();
        expect(warnings).toEqual(["playbook.json could not be read; drafting without the playbook (rebuild it)"]);
      }
      writeFileSync(path, "{not json");
      const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
      expect(r.warnings).toContain("playbook.json could not be read; drafting without the playbook (rebuild it)");
      for (const i of r.instances) expect(i.playbook).toBeUndefined();
    } finally {
      writeFileSync(path, saved);
    }
  });
});

describe("s19 fix: ADR number", () => {
  test("API: the s19 decision record is ADR 0011 (s18 keeps 0010) and every reference says so", () => {
    const root = new URL("../../../", import.meta.url);
    expect(existsSync(new URL("plan/adr/0011-messaging-playbook.md", root))).toBe(true);
    expect(existsSync(new URL("plan/adr/0010-messaging-playbook.md", root))).toBe(false);
    for (const f of ["brain/API.md", "slices/s19-messaging-playbook/SPEC.md", "slices/s19-messaging-playbook/verify.sh", "plan/stage-2/adr/0112-playbook-on-promotion.md"]) {
      const t = readFileSync(new URL(f, root), "utf8");
      expect(t).not.toContain("0010-messaging-playbook");
      expect(t).toContain("0011");
    }
    expect(readFileSync(new URL("brain/API.md", root), "utf8")).toContain("## s19: messaging playbook (additive, ADR 0011)");
  });
});
