// Fix round 11 for PR #11 (independent review of bed5b7d): initials in a sign-off ("frank b.", "f. baker", "f.") are
// part of the name, and a bullet marker starts a sentence, so a capitalised verb after it stays. Each test failed
// before its fix.
import { describe, expect, test } from "bun:test";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { buildIdentity, emptyIdentity, maskContacts, maskedCore, maskText } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { StubModel } from "../../src/models/model.ts";
import { NOW } from "./setup.ts";

const id0 = emptyIdentity();
const NONE = new Set<string>();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (t: string, n: string) => new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, "u").test(t);
const msg = (i: number, tail: string): PlaybookMessage => ({
  id: `m${i}`, channel: "email", to: [`x${i}@corp${i}.com`], subject: `Payroll ${i}`,
  body: `Hi Sam,\n\nWe can start Monday. Would you take 15 minutes this week?\n\n${tail}`, sentAt: NOW - (10 - i) * 86_400_000,
});
const core = (tail: string) => {
  const m = msg(0, tail);
  return maskedCore(m, buildIdentity([m])).core;
};

const INITIALS: Array<[string, string[]]> = [
  ["Best,\nfrank b.", ["frank", "b."]],
  ["thx\nfrank b.", ["frank", "b."]],
  ["Thanks,\nf. baker", ["f.", "baker"]],
  ["Thanks,\nF. Baker", ["F.", "Baker"]],
  ["Best,\nf.", ["f."]],
  ["Cheers,\nF.", ["F."]],
];

describe("s19 fix 11: initials in sign-offs", () => {
  test("MASK: a sign-off with initials is masked whole, in the core and in raw text", () => {
    const bad = INITIALS.filter(([t, ns]) => ns.some((n) => has(core(t), n) || has(maskText(t, id0), n))).map(([t]) => [t, core(t), maskText(t, id0)]);
    expect(bad).toEqual([]);
    for (const [t] of INITIALS) expect([t, findTextLeaks(t, id0, NONE, "notes").length > 0]).toEqual([t, true]);
  });

  test("PLAYBOOK: no initial or name of these sign-offs reaches the prompt or the playbook", async () => {
    for (const [t, ns] of INITIALS) {
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: [0, 1, 2].map((i) => msg(i, t)), model: new StubModel(), now: NOW });
      const out = [JSON.stringify(r.playbook), ...r.prompts].join("\n");
      expect([t, ns.filter((n) => n.length > 2 && has(out, n))]).toEqual([t, []]);
    }
  });
});

describe("s19 fix 11: bullets start a sentence", () => {
  test("MASK: a capitalised verb after a bullet marker stays", () => {
    for (const t of ["- Send invoice\n- Confirm date\n- Call Tuesday", "- Review contract\n- Approve budget", "* Send invoice\n* Confirm date", "• Send invoice\n• Confirm date", "1. Send invoice\n2. Confirm date"]) {
      expect([t, maskText(t, id0)]).toEqual([t, maskContacts(t)]);
      expect([t, findTextLeaks(t, id0, new Set(["1", "2"]), "notes")]).toEqual([t, []]);
    }
  });

  test("MASK: a name after a bullet marker is still masked", () => {
    expect(maskText("- Frank will send it\n- Priya confirms", id0)).toBe("- [name] will send it\n- [name] confirms");
  });
});
