// Fix round 6 for PR #11 (independent review of fda41c2): default-deny masking. A capitalised word that is not at the
// start of a sentence is a name unless it is on a small allow list (weekdays, months in a date, languages, common
// acronyms), so a person or company named like an ordinary word ("Will Smith at Open") never survives; notes accept
// plain wording and small numbers, and a refused note names the word. Each test failed before its fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { buildIdentity, emptyIdentity, maskedCore, maskText } from "../../src/playbook/mask.ts";
import { setPlaybookNotes, writePlaybook } from "../../src/playbook/store.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { StubModel } from "../../src/models/model.ts";
import { build, founderPersona, NOW, world, type World } from "./setup.ts";

const mk = (i: number, body: string, subject = "Payroll for startups"): PlaybookMessage => ({
  id: `m${i}`, channel: "email", to: [`x${i}@corp${i}.com`], subject, body: `Hi Sam,\n\n${body}\n\nBest,\nMuhammad Ali`, sentAt: NOW - (10 - i) * 86_400_000,
});
const REVIEW_BODY = "We build payroll tooling with Will Smith at Open and May Chen. Would you take 15 minutes this week?";
const SURVIVOR = /\b(?:Will|Smith|Open|May|Chen)\b/;

describe("s19 fix 6: default-deny masking of capitalised words", () => {
  test("MASK: a person or company named like an ordinary word in the body is masked (reviewer repro)", () => {
    const id = buildIdentity([0, 1, 2, 3].map((i) => mk(i, REVIEW_BODY)));
    expect(maskText(REVIEW_BODY, id)).not.toMatch(SURVIVOR);
  });

  test("PLAYBOOK: the reviewer's four messages build and the playbook keeps none of the names", async () => {
    for (const model of [null, new StubModel()]) {
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: [0, 1, 2, 3].map((i) => mk(i, REVIEW_BODY)), model, now: NOW });
      expect(JSON.stringify(r.playbook)).not.toMatch(SURVIVOR);
      for (const p of r.prompts) expect(p).not.toMatch(SURVIVOR);
    }
  });

  test("MASK: the allow list keeps weekdays, dated months, languages and acronyms", () => {
    const id = emptyIdentity();
    for (const t of ["Prefer Tuesday mornings in plain English.", "We start in April and ship by May 5.", "Mention the CTA, our CRM and the ROI.", "Ask about their Series A."]) {
      expect([t, maskText(t, id)]).toEqual([t, t]);
      expect([t, findTextLeaks(t, id, new Set(["5"]), "notes")]).toEqual([t, []]);
    }
  });

  test("MASK: a sentence-initial word next to another capitalised word is masked; a lone ordinary opener is not", () => {
    const id = emptyIdentity();
    expect(maskText("Will Smith joined us. Open with a hook.", id)).toBe("[name] [name] joined us. Open with a hook.");
    expect(maskText("Hope Lee said yes.", id)).toBe("[name] [name] said yes.");
  });

  test("KNOWN: fuzz, capitalised ordinary-word names next to surnames and companies never survive", async () => {
    const firsts = ["Will", "May", "Hope", "April", "Open", "Progress", "Reach", "Grace", "Lead", "Order"];
    const lasts = ["Smith", "Chen", "Okafor", "Lindqvist", "Patel"];
    const shapes = [
      (f: string, l: string, c: string) => `We work with ${f} ${l} at ${c} on payroll.`,
      (f: string, l: string, c: string) => `${f} ${l} from ${c} asked me to write.`,
      (f: string, _l: string, c: string) => `Our pilot with ${c} went well, and ${f} liked it.`,
      (f: string, l: string, c: string) => `I met ${f} ${l} last week. ${c} backs us.`.replace(`. ${c} backs`, `, and ${c} backs`),
    ];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const survivors: string[] = [];
    for (let k = 0; k < 200; k++) {
      const names: string[] = [];
      const bodies = [0, 1, 2].map(() => {
        const f = firsts[rnd(firsts.length)]!, l = lasts[rnd(lasts.length)]!, c = firsts[rnd(firsts.length)]!;
        names.push(f, l, c);
        return `${shapes[rnd(shapes.length)]!(f, l, c)} Would you have 15 minutes?`;
      });
      const msgs = bodies.map((b, i) => mk(i, b, `Payroll ${i}`));
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: msgs, model: null, now: NOW });
      const out = [JSON.stringify(r.playbook), ...msgs.map((m) => maskedCore(m, r.identity).core)].join("\n");
      for (const n of new Set(names)) if (new RegExp(`\\b${n}\\b`).test(out)) survivors.push(`${n} in ${bodies.join(" / ")}`);
    }
    expect(survivors.slice(0, 8)).toEqual([]);
  });
});

describe("s19 fix 6: notes", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    writePlaybook(w.home, { ...(await build(await founderPersona())).playbook, workflowId: w.outreach.id });
  });
  afterAll(() => w.cleanup());
  const id = () => buildIdentity([mk(0, "Worth a call?")]);

  test("PLAYBOOK: plain notes with weekdays, languages and small numbers are accepted", () => {
    for (const n of ["Use plain English.", "Prefer Tuesday mornings.", "Keep it under 100 words.", "Always mention our Series A.", "Say thanks. Mention the free trial."]) {
      expect(setPlaybookNotes(w.home, w.outreach.id, n, id(), NOW).notes).toBe(n);
    }
  });

  test("LEAK: a note naming a product or company is refused, and the error names the word and says to reword", () => {
    let msg = "";
    try {
      setPlaybookNotes(w.home, w.outreach.id, "Prefer Tuesday mornings, never cold-call Spotify users.", id(), NOW);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("Spotify");
    expect(msg).toMatch(/reword/i);
  });

  test("NUMBERS: phone- and id-shaped numbers in notes are still refused", () => {
    for (const n of ["Call them on +44 20 7946 0958.", "Quote ticket #4821 first.", "Mention order A-123."]) {
      expect(() => setPlaybookNotes(w.home, w.outreach.id, n, id(), NOW)).toThrow();
    }
  });
});
