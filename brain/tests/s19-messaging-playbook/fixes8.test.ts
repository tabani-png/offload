// Fix round 8 for PR #11 (independent review of be859cf): a given or family name of the s18 lexicon (ambiguous or
// not) is a name when capitalised anywhere, or in lower case next to another name or after/before a cue word; a
// spelled-out address ("priya at acme dot com") is masked whole. Same decision in findTextLeaks. Model prompts and the
// saved playbook must hold none of these names. Each test failed before its fix.
import { describe, expect, test } from "bun:test";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { emptyIdentity, maskText } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { StubModel } from "../../src/models/model.ts";
import { AMBIGUOUS_GIVEN } from "../../src/privacy/lexicon.ts";
import { NOW } from "./setup.ts";

const id0 = emptyIdentity();
const NONE = new Set<string>();
const mk = (i: number, body: string): PlaybookMessage => ({
  id: `m${i}`, channel: "email", to: [`x${i}@corp${i}.com`], subject: `Payroll ${i}`, body: `Hi Sam,\n\n${body}\n\nBest,\nMuhammad Ali`, sentAt: NOW - (10 - i) * 86_400_000,
});
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const survives = (out: string, names: readonly string[]) => names.filter((n) => new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, "iu").test(out));

const CASES: Array<[string, string[]]> = [
  ["I spoke with frank baker yesterday.", ["frank", "baker"]],
  ["We met dean chase at the fair.", ["dean", "chase"]],
  ["I met king young at the fair.", ["king", "young"]],
  ["thanks rose, that helps.", ["rose"]],
  ["Hi frank, quick one.", ["frank"]],
  ["Please loop in june on this.", ["june"]],
  ["ask sue or pat about it.", ["sue", "pat"]],
  ["Thanks to hunter and mason for the intro.", ["hunter", "mason"]],
  ["my colleague frank from baker street sent it.", ["frank", "baker"]],
  ["parker said yes.", ["parker"]],
  ["Frank called me and suggested you.", ["Frank"]],
  ["Rose is my cofounder.", ["Rose"]],
  ["Hunter will send it.", ["Hunter"]],
  ["Mark and Grace joined.", ["Mark", "Grace"]],
  ["Write to priya at acme dot com today.", ["priya", "acme", "com"]],
  ["Write to priya (at) acme (dot) com today.", ["priya", "acme"]],
  ["Ask john at acme.", ["john", "acme"]],
];

describe("s19 fix 8: lexicon names in any case, cues and spelled-out addresses", () => {
  test("MASK: the reviewer's inputs keep none of the names", () => {
    const bad = CASES.map(([t, n]) => [t, maskText(t, id0), survives(maskText(t, id0), n)] as const).filter(([, , s]) => s.length > 0);
    expect(bad).toEqual([]);
  });

  test("LEAK: the reviewer's inputs are leaks", () => {
    const bad = CASES.filter(([t]) => findTextLeaks(t, id0, NONE, "notes").length === 0).map(([t]) => t);
    expect(bad).toEqual([]);
  });

  test("MASK: plain wording with these words as ordinary words is kept", () => {
    for (const t of ["We will send the deck this week.", "please bill me later.", "It may help to note the date.", "Thanks for the order."]) {
      expect([t, findTextLeaks(t, id0, NONE, "notes")]).toEqual([t, []]);
    }
  });

  test("PLAYBOOK: the reviewer's build keeps no name in the model prompts or the saved playbook", async () => {
    const bodies = [
      "Frank Baker at the bank said yes, so can we talk? Rose is my cofounder. Hunter will send the deck.",
      "I spoke with frank baker yesterday and thanks to hunter and mason. Ask sue or pat. Would you take 15 minutes this week?",
      "Frank called me and suggested you. Rose and Hunter are on cc. Would you take 15 minutes this week?",
    ];
    const names = ["frank", "baker", "rose", "hunter", "mason", "sue", "pat"];
    for (const model of [null, new StubModel()]) {
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: bodies.map((b, i) => mk(i, b)), model, now: NOW });
      expect(survives(JSON.stringify(r.playbook), names)).toEqual([]);
      for (const p of r.prompts) expect(survives(p, names)).toEqual([]);
    }
  });

  test("KNOWN: fuzz, every ambiguous s18 name x cue template x case never reaches a prompt or the playbook", async () => {
    const templates = [
      (n: string) => `Hi ${n}, thanks for the call.`,
      (n: string) => `thanks ${n}, that helps.`,
      (n: string) => `Please loop in ${n} on this.`,
      (n: string) => `I spoke with ${n} baker yesterday.`,
      (n: string) => `my colleague ${n} sent it over.`,
      (n: string) => `${n} said yes to the pilot.`,
      (n: string) => `${n} is my cofounder.`,
      (n: string) => `ask sue or ${n} about it.`,
      (n: string) => `Thanks to hunter and ${n} for the intro.`,
    ];
    const cases = [(n: string) => n, (n: string) => n[0]!.toUpperCase() + n.slice(1)];
    const names = [...AMBIGUOUS_GIVEN].filter((n) => n !== "will" && n !== "may");
    const bad: string[] = [];
    let k = 0;
    for (const n of names) {
      const bodies = [0, 1, 2].map((i) => `${templates[(k + i) % templates.length]!(cases[(k + i) % 2]!(n))} Would you have 15 minutes?`);
      k++;
      // The same mail with an unknown name stands in as the control: the generator's own text ("Don't", "max") counts
      // there too, so only an occurrence beyond the control is a survivor.
      const count = (t: string) => (t.match(new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, "giu")) ?? []).length;
      const run = async (bs: string[]) => {
        const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: bs.map((b, i) => mk(i, b)), model: new StubModel(), now: NOW });
        return [JSON.stringify(r.playbook), ...r.prompts].join("\n");
      };
      try {
        const out = await run(bodies);
        const control = await run(bodies.map((b) => b.replace(new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, "giu"), "Zorblax")));
        if (count(out) > count(control)) bad.push(`${n}: ${bodies.join(" / ")}`);
      } catch (e) {
        bad.push(`${n}: build failed ${(e as Error).message}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
