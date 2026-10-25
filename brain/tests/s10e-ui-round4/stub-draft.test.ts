// s10e work item 2: the stub's draft reads like the snapshot drafts: greeting, who and what, one line on the fund,
// raise and traction from the facts, the ask, the name. No number outside the facts; same prompt, same text.
import { describe, expect, test } from "bun:test";
import { FIXTURE_FACTS, SENT_MAIL } from "../../fixtures/sent-mail.ts";
import { StubModel } from "../../src/models/model.ts";
import { cleanEmail } from "../../src/tone/clean.ts";
import { draftInTone, draftPrompt, numbersNotIn } from "../../src/tone/draft.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import type { CorpusEntry } from "../../src/tone/types.ts";
import { DEFAULT_FACTS_FILE, draftWorkflow, FACTS_TEMPLATE } from "../../src/workflows/drafter.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { tempHome } from "../helpers.ts";

const SVEN = { email: "sven@bvp.com", firstName: "Sven", org: "Bessemer Venture Partners" };
const corpus: CorpusEntry[] = SENT_MAIL.slice(0, 18).map((m) => ({ ...cleanEmail(m), bucket: "investor_outreach" as const }));
const draft = (facts: string, recipient: typeof SVEN & { notes?: string } = SVEN, withExamples = false) =>
  new StubModel().complete({ role: "draft", model: "m", system: "", prompt: draftPrompt({ pack: { corpus, cards: {} }, bucket: "investor_outreach", recipient, subject: "Offload seed round: Bessemer", facts }, withExamples ? corpus.slice(0, 4) : []) });

const WEEKDAYS_MONTHS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

describe("s10e stub draft", () => {
  test("the fixture founder's draft has the snapshot shape", async () => {
    expect(await draft(FIXTURE_FACTS)).toBe(
      [
        "Hi Sven,",
        "",
        "I'm Muhammad, founder of Offload. Offload is a Mac app that watches a week of your work and automates the parts that repeat.",
        "Bessemer Venture Partners backs tools teams use every day, so I'm writing to you first.",
        "",
        "We are raising a $2.5M seed. Traction: 40 design partners, 3 paying.",
        "",
        "Worth 20 minutes next week?",
        "",
        "Muhammad",
      ].join("\n"),
    );
  });

  test("deterministic, and every number in it is in the facts; no date, month or weekday", async () => {
    const a = await draft(FIXTURE_FACTS, SVEN, true);
    expect(await draft(FIXTURE_FACTS, SVEN, true)).toBe(a);
    expect(numbersNotIn(a, [FIXTURE_FACTS])).toEqual([]);
    expect(a).not.toMatch(WEEKDAYS_MONTHS);
    expect(a.split("\n")[0]).toBe("Hi Sven,");
    expect(a.trimEnd().endsWith("\n\nMuhammad")).toBe(true);
  });

  test("the recipient's notes, when given, make the fund line", async () => {
    const a = await draft(FIXTURE_FACTS, { ...SVEN, notes: "Backed Toast early" });
    expect(a).toContain("Backed Toast early. That is why I'm writing to you first.");
    expect(a).not.toContain("backs tools");
  });

  test("missing facts show as [missing: ...]; the ask and sign come from the examples, never a number", async () => {
    const a = await draft(FACTS_TEMPLATE, SVEN, true);
    expect(a).toContain("[missing: pitch]");
    expect(a).toContain("[missing: raise] [missing: traction]");
    expect(a).not.toContain("$2.5M");
    expect(numbersNotIn(a, [FACTS_TEMPLATE])).toEqual([]);
    expect(a.trimEnd().endsWith("Muhammad")).toBe(true);
    const ask = a.split("\n").filter((l) => l.endsWith("?"));
    expect(ask).toHaveLength(1);
    expect(ask[0]).not.toMatch(/\d/);
  });

  test("through draftInTone: no warnings with the fixture facts and a tone pack", async () => {
    const d = await draftInTone({ pack: { corpus, cards: {} }, bucket: "investor_outreach", recipient: SVEN, subject: "Offload seed round: Bessemer", facts: FIXTURE_FACTS, model: new StubModel(), models: DEFAULT_MODELS });
    expect(d.warnings).toEqual([]);
    expect(d.body.split("\n").length).toBeGreaterThanOrEqual(9);
  });

  test("the stub style card reads like voice notes from the examples (3 to 5 lines, no numbers)", async () => {
    const card = await new StubModel().complete({ role: "style_card", model: "m", system: "", prompt: `<examples untrusted="true">\n--- example 1\nSubject: x\n\nHi Anna,\n\nShort one.\n\nOpen to a quick call?\n\nMuhammad\n--- example 2\nSubject: y\n\nHi Ben,\n\nStraight to it.\n\nCan we talk?\n\nMuhammad\n</examples>` });
    const lines = card.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(card).toContain('"Hi"');
    expect(card).toContain('("Muhammad")');
    expect(card).toContain("Short and direct");
    expect(card).not.toMatch(/\d/);
  });

  test("default-facts.md in the home seeds facts.md of a new workflow (the demo home has the fixture facts)", async () => {
    const { home, cleanup } = tempHome();
    try {
      writeFixture(home, generateFixture({ seed: 42 }), { encrypted: false, seed: 42 });
      writeFileSync(join(home, DEFAULT_FACTS_FILE), FIXTURE_FACTS);
      // The fixture week is fixed (2026-10-12..18); pin the clock inside its 7-day window so the test does not age out.
      const a = await analyzeHome(home, { now: () => Date.UTC(2026, 9, 19, 12, 0, 0) });
      const { workflow } = draftWorkflow({ home, analysis: a, insightId: a.insights[0]!.id });
      expect(readFileSync(join(home, "workflows", workflow.id, "facts.md"), "utf8")).toBe(FIXTURE_FACTS);
    } finally {
      cleanup();
    }
  });
});
