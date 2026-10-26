// Fix round 4 for PR #11 (Codex re-review): no heuristic may promote an ordinary word (a stopword, a word the playbook
// generator itself writes, a placeholder name, a number or a single letter) into the identity, so valid mail cannot make
// the build fail closed; real names stay masked. Each test failed before its fix.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { buildIdentity, emptyIdentity, maskText, ordinaryWord } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { NOW } from "./setup.ts";

const NONE = new Set<string>();
const mail = (subject: (i: number) => string, body: (i: number) => string, to = (i: number) => `buyer${i}@shop${i}.com`): PlaybookMessage[] =>
  [1, 2, 3].map((i) => ({ id: `m${i}`, channel: "email", to: [to(i)], subject: subject(i), body: body(i), sentAt: NOW - (10 - i) * 86_400_000 }));
const ORDER_BODY = () => `Hi Sam,\n\nThanks for the order. It ships on Monday and the tracking link follows.\n\nBest,\nDana`;
const build = (messages: PlaybookMessage[], facts = "") => buildPlaybook({ workflowId: "wf-r4", channel: "email", messages, facts, model: null, now: NOW });

describe("s19 fix 4: ordinary words never join the identity", () => {
  test("PLAYBOOK: three valid messages titled 'Your order' build without a model", async () => {
    const r = await build(mail(() => "Your order", ORDER_BODY));
    expect(r.identity.company.has("your")).toBe(false);
    expect(r.playbook.rules.length).toBeGreaterThan(0);
  });

  test("PLAYBOOK: Title Case subjects ('Your Order Has Shipped') build and add no company word", async () => {
    const r = await build(mail(() => "Your Order Has Shipped", ORDER_BODY));
    expect([...r.identity.company]).toEqual([]);
  });

  test("PLAYBOOK: facts and signatures made of ordinary words build and mask nothing ordinary", async () => {
    const body = () => `Hi Sam,\n\nThanks for the order. Your parcel ships on Monday.\n\nBest,\nThe Team\n--\nThe Team\nSent from my iPhone`;
    const r = await build(mail((i) => `Order ${i}`, body), "sign: The Team\ncompany: The Good Company");
    for (const w of ["the", "team", "good", "company", "sent", "from", "my"]) {
      expect(r.identity.author.has(w)).toBe(false);
      expect(r.identity.company.has(w)).toBe(false);
    }
  });

  test("MASK: a common word in the identity sets is not masked in lower case, real names still are", () => {
    const id = buildIdentity(mail(() => "Your order", ORDER_BODY), "sign: Dana Shah\ncompany: Northzone");
    expect(maskText("your order and the refund", id)).toBe("your order and the refund");
    expect(maskText("Dana Shah from Northzone wrote; northzone ships.", id)).toBe("{sender} {sender} from {company} wrote; {company} ships.");
  });

  test("MASK: an identity that already holds an ordinary word (an older digest) leaves it alone", () => {
    const id = { ...emptyIdentity(), company: new Set(["your", "progress"]), author: new Set(["the"]), people: new Set(["hook"]) };
    expect(maskText("the hook of your progress", id)).toBe("the hook of your progress");
  });

  test("LEAK: generator wording is never a leak, whatever the recipients are called", () => {
    // Real people and companies whose names are generator words: Tom Hook at Progress, Kim Stage at Data.
    const id = buildIdentity(mail(() => "Intro", () => `Hi Tom,\n\nWorth a call?\n\nBest,\nDana`, (i) => ["tom.hook@progress.com", "kim.stage@data.com", "lee.voice@issue.io"][i - 1]!));
    for (const t of ["Open with a line about them (a personal hook).", "Use recent progress as proof.", "Don't copy the original sender's voice.", "Short form of the first message: the details of their issue.", "Stage, team, location and data."]) {
      expect(findTextLeaks(t, id, NONE, "rules[0].text")).toEqual([]);
    }
    const old = { ...emptyIdentity(), company: new Set(["your"]), author: new Set(["the"]) };
    expect(findTextLeaks("Thank them for your reply and keep the tone.", old, NONE, "rules[0].text")).toEqual([]);
  });

  test("KNOWN: real names are still found (subject brand, honorific greeting, subdomain address, sign name)", () => {
    const id = buildIdentity(
      mail((i) => `Acme order ${i}`, () => `Dear Ms Kowalski,\n\nThanks for the order.\n\nBest,\nDana Shah`, () => "anna@app.northzone.com"),
    );
    expect(id.company.has("acme")).toBe(true);
    expect(id.people.has("kowalski")).toBe(true);
    expect(id.people.has("ms")).toBe(false);
    expect(id.orgs.has("northzone")).toBe(true);
    expect(id.orgs.has("app")).toBe(false);
    expect(id.author.has("dana") && id.author.has("shah")).toBe(true);
    expect(maskText("Acme sent it to Kowalski at northzone.", id, { org: "northzone" })).toBe("{company} sent it to [name] at {their_org}.");
  });

  test("KNOWN: a Title Case subject still masks a name that is never written in lower case", () => {
    const id = buildIdentity(mail(() => "Meeting With Priya", () => `Hi Sam,\n\nThanks for the meeting.\n\nBest,\nDana`));
    expect(maskText("Priya joined.", id)).toBe("[name] joined.");
  });

  test("KNOWN: no single letter, number or placeholder name becomes a person", () => {
    const id = buildIdentity(mail((i) => `Ref ${i}`, () => `Hi J,\n\nWorth a call?\n\nBest,\nDana`, () => "j.x@shop.com"), "sign: Dana 2\ncompany: [name] 42");
    for (const set of [id.people, id.author, id.company]) for (const w of set) expect([...w].length >= 2 && !/\d/.test(w) && !/[[\]{}]/.test(w) && w !== "name").toBe(true);
    expect(maskText("j and the name", id)).toBe("j and the name");
  });

  test("LEAK: every word the generator writes is an ordinary word (drift guard for synth.ts)", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/playbook/synth.ts"), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    const missing = new Set<string>();
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
      if (!/\s/.test(s)) continue;
      for (const w of s.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []) {
        // Code inside the prompt strings (camelCase keys, JS keywords, one- and two-letter names) is not wording.
        if (/^\p{Ll}+\p{Lu}/u.test(w) || [...w].length <= 2 || /^(?:undefined|null|json|JSON|object)$/.test(w)) continue;
        if (!ordinaryWord(w.toLowerCase().replace(/['’]s$/, ""))) missing.add(w.toLowerCase());
      }
    }
    expect([...missing]).toEqual([]);
  });
});
