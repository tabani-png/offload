// Fix round 9 for PR #11 (independent review of 1111dce): a lower-case sign-off name ("Best,\nfrank") is stripped
// from the core with its sign-off, and identityHit reads a short line after a closing word, a lone short final line
// and the first part of a "name | title | company" line as a name, in any case. Each test failed before its fix.
import { describe, expect, test } from "bun:test";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { buildIdentity, emptyIdentity, maskedCore, maskText } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { StubModel } from "../../src/models/model.ts";
import { NOW } from "./setup.ts";

const id0 = emptyIdentity();
const NONE = new Set<string>();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (t: string, n: string) => (t.match(new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, "giu")) ?? []).length;
const msg = (i: number, body: string): PlaybookMessage => ({ id: `m${i}`, channel: "email", to: [`x${i}@corp${i}.com`], subject: `Payroll ${i}`, body, sentAt: NOW - (10 - i) * 86_400_000 });

const SIGNOFFS: Array<[string, string]> = [
  ["Hi Sam,\n\nWe can start Monday.\n\nBest,\nfrank", "frank"],
  ["Hi Sam,\n\nWe can start Monday.\n\nThanks!\n\nfrank", "frank"],
  ["Hi Sam,\n\nWe can start Monday.\n\nBest,\nfrank\nSent from my iPhone", "frank"],
  ["Hi Sam,\n\nWe can start Monday.\n\nBest,\nfrank\n\n--\nfrank | CEO\nZentrix", "frank"],
  ["Hi Sam,\n\nWe can start Monday.\n\nBest,\nrose", "rose"],
  ["Hi Sam,\n\nWe can start Monday.\n\nThanks,\nmark", "mark"],
  ["Hi Sam,\n\nWe can start Monday.\n\n- frank", "frank"],
  ["Hi Sam,\n\nWe can start Monday.\n\nBest,\nfrank\nCEO", "frank"],
];

describe("s19 fix 9: lower-case sign-off names", () => {
  test("MASK: the core of each reviewer message holds no sign-off name", () => {
    const bad = SIGNOFFS.map(([b, n], i) => [b, maskedCore(msg(i, b), buildIdentity([msg(i, b)])).core, n] as const).filter(([, core, n]) => count(core, n) > 0);
    expect(bad).toEqual([]);
  });

  test("MASK: the raw sign-off text is masked and is a leak (identityHit cue, any case)", () => {
    for (const [b, n] of SIGNOFFS) {
      expect([b, count(maskText(b, id0), n)]).toEqual([b, 0]);
      expect([b, findTextLeaks(b, id0, NONE, "notes").length > 0]).toEqual([b, true]);
    }
    expect(count(maskText("frank smith | CEO | Zentrix", id0), "smith")).toBe(0);
  });

  test("MASK: ordinary last lines and closings are not names", () => {
    for (const t of ["We can start Monday.\n\nThanks!", "Keep it short.\n\nBe brief.", "Worth a call?\n\nCheers", "Be brief"]) {
      expect([t, findTextLeaks(t, id0, NONE, "notes")]).toEqual([t, []]);
    }
  });

  test("PLAYBOOK: no sign-off name reaches the model prompt or the saved playbook", async () => {
    for (const [b, n] of SIGNOFFS) {
      const body = b.replace("We can start Monday.", "We can start Monday. Would you take 15 minutes this week?");
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: [0, 1, 2].map((i) => msg(i, body)), model: new StubModel(), now: NOW });
      const out = [JSON.stringify(r.playbook), ...r.prompts].join("\n");
      expect([b, count(out, n)]).toEqual([b, 0]);
    }
  });

  test("KNOWN: fuzz, sign-off templates x names x case never reach a prompt or the playbook", async () => {
    const names = ["frank", "rose", "mark", "grace", "hunter", "dean", "priya", "will"];
    const closes = ["Best,", "Thanks,", "Thanks!", "Cheers,", "Kind regards,", "Thank you,", "Talk soon,", "Sincerely,"];
    const tails = [(n: string) => n, (n: string) => `${n}\nSent from my iPhone`, (n: string) => `${n}\nCEO`, (n: string) => `${n}\n\n--\n${n} | CEO\nZentrix`];
    const bad: string[] = [];
    let k = 0;
    for (const n of names) {
      for (const cap of [false, true]) {
        const nm = cap ? n[0]!.toUpperCase() + n.slice(1) : n;
        const bodies = [0, 1, 2].map((i) => `Hi Sam,\n\nWe can start Monday. Would you take 15 minutes this week?\n\n${closes[(k + i) % closes.length]}\n${tails[(k + i) % tails.length]!(nm)}`);
        const lone = `Hi Sam,\n\nWe can start Monday. Would you take 15 minutes this week?\n\n- ${nm}`;
        k++;
        const run = async (bs: string[]) => {
          const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: bs.map((b, i) => msg(i, b)), model: new StubModel(), now: NOW });
          return [JSON.stringify(r.playbook), ...r.prompts].join("\n");
        };
        try {
          const out = await run([...bodies.slice(0, 2), lone]);
          const control = await run([...bodies.slice(0, 2), lone].map((b) => b.replace(new RegExp(`(?<!\\p{L})${esc(nm)}(?!\\p{L})`, "gu"), "Zorblax")));
          if (count(out, n) > count(control, n)) bad.push(`${nm}: ${bodies[0]!.split("\n").slice(-3).join(" / ")}`);
        } catch (e) {
          bad.push(`${nm}: build failed ${(e as Error).message}`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
