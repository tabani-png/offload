// Fix round 3 for PR #11 (Codex re-review): a word in brackets is only exempt from masking and the leak check when it
// is one of the defined placeholders, and playbook.json is validated field by field before drafting trusts it. Each
// test failed before its fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { checkDepersonalised, findTextLeaks, lowerWords } from "../../src/playbook/leak.ts";
import { buildIdentity, maskedCore, maskText, PLACEHOLDERS, startsUnmasked } from "../../src/playbook/mask.ts";
import { playbookForPromotion } from "../../src/playbook/promote.ts";
import { CORRUPT_PLAYBOOK_WARNING, playbookPath, readPlaybook, writePlaybook } from "../../src/playbook/store.ts";
import type { Playbook, PlaybookMessage } from "../../src/playbook/types.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { build, founderPersona, NOW, world, type World } from "./setup.ts";

const msg = (i: number, to: string, first: string, line: string): PlaybookMessage => ({
  id: `m${i}`,
  channel: "email",
  to: [to],
  subject: `Intro ${i}`,
  body: `Hi ${first},\n\n${line}\n\nBest,\nPriya`,
  sentAt: NOW - (10 - i) * 86_400_000,
});
const MAIL: PlaybookMessage[] = [
  msg(1, "anna@balderton.com", "Anna", "We are {northzone}, contact [priya]. Would you have 15 minutes?"),
  msg(2, "mark@accel.com", "Mark", "Happy to send the deck. Worth a call?"),
  msg(3, "grace@index.com", "Grace", "Hope you are well. Worth a call?"),
];
const ID = buildIdentity(MAIL, "sign: Priya\ncompany: Northzone");
const NONE = new Set<string>();

describe("s19 fix 3: only the defined placeholders are exempt", () => {
  test("MASK: a name or company in brackets is masked like any other word", () => {
    const out = maskText("We are {northzone}, contact [priya].", ID);
    expect(out).not.toMatch(/northzone|priya/i);
    expect(maskText("Ask [Anna] or {mark} at [balderton].", ID)).not.toMatch(/anna|mark|balderton/i);
    expect(maskText("Ping {Raycast} today.", ID)).not.toMatch(/raycast/i);
  });

  test("MASK: the defined placeholders pass through unchanged", () => {
    const t = "{greeting} {first} at {their_org}, from {sender} at {company}: [name] [number] [link] [email] [phone] [proof] [ask] [thanks] {sign_off}";
    expect(maskText(t, ID)).toBe(t);
    for (const p of ["[name]", "{company}", "{sender}", "{first}", "{their_org}", "{greeting}", "{sign_off}", "[number]"]) expect(PLACEHOLDERS.has(p)).toBe(true);
    expect(PLACEHOLDERS.has("[priya]")).toBe(false);
  });

  test("MASK: a bracketed name in a sent message never reaches the model", () => {
    const { core } = maskedCore(MAIL[0]!, ID);
    expect(core).not.toMatch(/northzone|priya/i);
  });

  test("MASK: a text that opens with a bracketed name counts as unmasked", () => {
    expect(startsUnmasked("[Priya] built their payments stack.")).toBe(true);
    expect(startsUnmasked("{company} builds a mac app.")).toBe(false);
  });

  test("LEAK: the author, the company or a name in brackets is a leak", () => {
    const kinds = findTextLeaks("We are {northzone}, contact [priya].", ID, NONE, "notes").map((l) => l.kind);
    expect(kinds).toContain("author");
    expect(kinds).toContain("company");
    expect(findTextLeaks("Write to [Anna] like this.", ID, NONE, "rules[0].text").map((l) => l.kind)).toContain("name");
    expect(findTextLeaks("Open with {Spotify}.", ID, NONE, "rules[0].text").map((l) => l.kind)).toContain("name");
  });

  test("LEAK: placeholders and skeleton brackets are not leaks", () => {
    expect(findTextLeaks("{greeting}\n[hook] [proof] [ask]\n{sign_off}", ID, NONE, "skeletons[0]")).toEqual([]);
    expect(findTextLeaks("Tell {first} at {their_org} what {company} does; [name] and [number] stay.", ID, NONE, "message")).toEqual([]);
  });

  test("LEAK: a bracketed lower-case word is vocabulary like any other", () => {
    // "[raycast]" in lower case does not make "Raycast" an ordinary word.
    expect(lowerWords(["try [raycast]"]).has("raycast")).toBe(true);
    expect(lowerWords(["{greeting} [name]"]).has("name")).toBe(false);
  });

  test("LEAK: a playbook with notes naming someone in brackets is refused", async () => {
    const fr = await build(await founderPersona());
    expect(checkDepersonalised(fr.playbook, fr.identity)).toEqual([]);
    for (const notes of ["Sign as [muhammad].", "Mention {offload} first.", "Write like the mail to [anna] at {northzone}."]) {
      const leaks = checkDepersonalised({ ...fr.playbook, notes }, fr.identity);
      expect(leaks.length).toBeGreaterThan(0);
      expect(leaks.every((l) => l.path === "notes")).toBe(true);
    }
  });
});

describe("s19 fix 3: playbook.json is validated before it is trusted", () => {
  let w: World;
  let good: Playbook;
  let path: string;
  beforeAll(async () => {
    w = await world();
    good = { ...(await build(await founderPersona())).playbook, workflowId: w.outreach.id };
    writePlaybook(w.home, good);
    path = playbookPath(w.home, w.outreach.id);
  });
  afterAll(() => w.cleanup());

  const bad = (): Array<[string, unknown]> => {
    const g = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    const t0 = (g.templates as Array<Record<string, unknown>>)[0]!;
    return [
      ["only the schema", { schema: "offload.playbook/1" }],
      ["templates not an array", { ...g, templates: "x" }],
      ["rules missing", { ...g, rules: undefined }],
      ["a rule without text", { ...g, rules: [{ id: "r1", kind: "do" }] }],
      ["a rule with an unknown check", { ...g, rules: [{ id: "r1", kind: "do", text: "x", check: { kind: "nope" } }] }],
      ["a template without slots", { ...g, templates: [{ ...t0, slots: undefined }] }],
      ["a slot that is not a slot", { ...g, templates: [{ ...t0, slots: [{ slot: "evil", says: "x" }] }] }],
      ["notes not a string", { ...g, notes: 3 }],
      ["skeletons with a number", { ...g, skeletons: [1] }],
      ["stats missing", { ...g, stats: undefined }],
      ["outcomes without byPattern", { ...g, outcomes: { ...(g.outcomes as object), byPattern: undefined } }],
      ["cadence without followUpMoves", { ...g, cadence: { ...(g.cadence as object), followUpMoves: null } }],
      ["version not a number", { ...g, version: "2" }],
      ["unknown channel", { ...g, channel: "fax" }],
      ["history not an array", { ...g, history: {} }],
      ["models missing", { ...g, models: undefined }],
    ];
  };

  test("PLAYBOOK: a playbook.json with the right schema but a missing or wrong field reads as no playbook, with the warning", () => {
    const saved = readFileSync(path, "utf8");
    try {
      for (const [what, v] of bad()) {
        writeFileSync(path, JSON.stringify(v));
        const warnings: string[] = [];
        expect([what, readPlaybook(w.home, w.outreach.id, warnings)]).toEqual([what, null]);
        expect([what, warnings]).toEqual([what, [CORRUPT_PLAYBOOK_WARNING]]);
      }
    } finally {
      writeFileSync(path, saved);
    }
    expect(readPlaybook(w.home, w.outreach.id)).toEqual(good);
  });

  test("DRYRUN: a schema-only playbook.json drafts without the playbook instead of throwing", async () => {
    const saved = readFileSync(path, "utf8");
    try {
      writeFileSync(path, JSON.stringify({ schema: "offload.playbook/1" }));
      const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
      expect(r.warnings).toContain(CORRUPT_PLAYBOOK_WARNING);
      expect(r.instances.length).toBeGreaterThan(0);
      for (const i of r.instances) expect(i.playbook).toBeUndefined();
    } finally {
      writeFileSync(path, saved);
    }
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, now: () => NOW });
    expect(r.instances.some((i) => i.playbook !== undefined)).toBe(true);
  });

  test("PLAYBOOK: promotion of a malformed playbook.json is nothing to promote, not a crash", () => {
    const saved = readFileSync(path, "utf8");
    try {
      writeFileSync(path, JSON.stringify({ schema: "offload.playbook/1", rules: [] }));
      expect(playbookForPromotion(w.home, w.outreach.id, NOW)).toBeNull();
    } finally {
      writeFileSync(path, saved);
    }
  });
});
