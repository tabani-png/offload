// Fix round 3 for PR #11 (Codex re-review): a word in brackets is only exempt from masking and the leak check when it
// is one of the defined placeholders, and playbook.json is validated field by field before drafting trusts it. Each
// test failed before its fix.
import { describe, expect, test } from "bun:test";
import { checkDepersonalised, findTextLeaks, lowerWords } from "../../src/playbook/leak.ts";
import { buildIdentity, maskedCore, maskText, PLACEHOLDERS, startsUnmasked } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { build, founderPersona, NOW } from "./setup.ts";

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
