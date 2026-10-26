// Fix round 10 for PR #11 (independent review of 8581c6c): never delete content to protect privacy, mask it. After a
// closing line only the next one or two name-like lines are masked; questions, requests and P.S. paragraphs stay as
// content. Closings outside English and informal ones are recognised, and a name-like lone last line is masked
// without any closing. Each test failed before its fix.
import { describe, expect, test } from "bun:test";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { buildIdentity, maskedCore } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { StubModel } from "../../src/models/model.ts";
import { NOW } from "./setup.ts";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (t: string, n: string) => (t.match(new RegExp(`(?<!\\p{L})${esc(n)}(?!\\p{L})`, "giu")) ?? []).length;
const msg = (i: number, tail: string): PlaybookMessage => ({
  id: `m${i}`, channel: "email", to: [`x${i}@corp${i}.com`], subject: `Payroll ${i}`,
  body: `Hi Sam,\n\nWe can start Monday. Would you take 15 minutes this week?\n\n${tail}`, sentAt: NOW - (10 - i) * 86_400_000,
});
const core = (tail: string) => {
  const m = msg(0, tail);
  return maskedCore(m, buildIdentity([m])).core;
};

const KEPT: Array<[string, string]> = [
  ["Thanks\n\nCall me.", "Call me."],
  ["Thanks!\nCould you send the invoice?", "Could you send the invoice?"],
  ["Speak soon\nPlease confirm.", "Please confirm."],
  ["Best\n\nAny update?\nPlease reply today.\nWe are waiting.", "We are waiting."],
  ["Thanks,\nfrank\n\nP.S. Would Tuesday work?", "P.S. Would Tuesday work?"],
  ["Thanks\n\nWill do.", "Will do."],
  ["Talk then.\n\nASAP", "ASAP"],
];
const LEAKS: Array<[string, string]> = [
  ["Cheers mate,\nfrank", "frank"],
  ["xo\nrose", "rose"],
  ["Saludos,\nfrank", "frank"],
  ["Mit freundlichen Grüßen\nfrank", "frank"],
  ["Thanks,\nfrank\n\nP.S. Would Tuesday work?", "frank"],
  ["Un saludo,\nmark", "mark"],
  ["Cordialement,\nrose", "rose"],
  ["Ok then,\nhunter", "hunter"],
];

describe("s19 fix 10: mask sign-offs, never delete content", () => {
  test("MASK: requests, questions and P.S. after a closing stay in the masked core", () => {
    const lost = KEPT.filter(([t, keep]) => !core(t).includes(keep)).map(([t]) => [t, core(t)]);
    expect(lost).toEqual([]);
  });

  test("MASK: names after informal and non-English closings are masked in the core", () => {
    const bad = LEAKS.filter(([t, n]) => count(core(t), n) > 0).map(([t]) => [t, core(t)]);
    expect(bad).toEqual([]);
  });

  test("PLAYBOOK: no sign-off name reaches the model prompt or the playbook; the content does", async () => {
    for (const [t, n] of LEAKS) {
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: [0, 1, 2].map((i) => msg(i, t)), model: new StubModel(), now: NOW });
      const out = [JSON.stringify(r.playbook), ...r.prompts].join("\n");
      expect([t, count(out, n)]).toEqual([t, 0]);
    }
    const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: [0, 1, 2].map((i) => msg(i, KEPT[4]![0])), model: new StubModel(), now: NOW });
    expect(r.prompts.join("\n")).toContain("Would Tuesday work?");
  });
});
