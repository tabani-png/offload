// MASK: the identity set and masked text. READ: rule labels, the Haiku labeller within the vocabularies.
// KNOWN: known answers for the founder outreach, support reply and recruiter personas.
import { beforeAll, describe, expect, test } from "bun:test";
import { StubModel, type ModelRequest } from "../../src/models/model.ts";
import { buildIdentity, maskedCore, maskText } from "../../src/playbook/mask.ts";
import { mergeLabels, ruleRead, threadMessages } from "../../src/playbook/read.ts";
import type { BuildPlaybookResult } from "../../src/playbook/build.ts";
import { build, containsWord, founderPersona, PERSONAL, recruiterPersona, supportPersona, type Persona } from "./setup.ts";

let founder: Persona;
let fr: BuildPlaybookResult;
let sr: BuildPlaybookResult;
let rr: BuildPlaybookResult;
let calls: ModelRequest[];
beforeAll(async () => {
  founder = await founderPersona();
  const m = new StubModel();
  fr = await build(founder, m);
  calls = m.calls;
  sr = await build(supportPersona());
  rr = await build(recruiterPersona());
});

describe("s19 masking", () => {
  test("MASK: the identity set holds the author, their company, recipients and their organisations", () => {
    const id = fr.identity;
    expect([...id.author]).toContain("muhammad");
    expect([...id.company]).toContain("offload");
    expect([...id.people]).toEqual(expect.arrayContaining(["anna", "james", "chen", "priya"]));
    expect([...id.orgs]).toEqual(expect.arrayContaining(["northzone", "accel", "localglobe", "balderton"]));
    expect([...id.words]).toEqual(expect.arrayContaining(["spotify", "raycast"]));
  });

  test("MASK: the signature block names the author and the company even without facts", () => {
    const id = buildIdentity(supportPersona().messages);
    expect([...id.author]).toEqual(expect.arrayContaining(["jordan", "lee"]));
    expect([...id.company]).toContain("brightcart");
  });

  test("MASK: masked text has no address, name, organisation, figure or phone", () => {
    const id = fr.identity;
    const t = maskText("Anna, you backed Spotify early. Offload has 40 partners, raising $2.5M. Mail anna@northzone.com or +44 7700 900123, see offload.so", id, { first: "Anna", org: "northzone" });
    expect(t).toBe("{first}, you backed [name] early. {company} has [number] partners, raising [number]. Mail [email] or [phone], see [link]");
  });

  test("MASK: generic words, days and products stay; the recipient's organisation becomes {their_org}", () => {
    const id = fr.identity;
    expect(maskText("I can do Tuesday on Zoom; the Mac app helps Northzone.", id, { org: "northzone" })).toBe("I can do Tuesday on Zoom; the Mac app helps {their_org}.");
  });

  test("MASK: the support persona's street, depot, codes and order numbers are masked", () => {
    const p = supportPersona();
    const all = p.messages.map((m) => maskedCore(m, sr.identity).core).join("\n");
    for (const w of ["Elm", "Street", "Leeds", "SPRING15", "48213", "64.00", "Maria", "Jordan"]) expect(containsWord(all, w)).toBe(false);
    expect(all).toContain("[name] [name]?");
  });

  test("MASK: every prompt sent to a model is masked (no persona name, address or private figure)", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) for (const w of PERSONAL.founder) expect(containsWord(c.prompt, w)).toBe(false);
    for (const c of calls) expect(c.prompt).not.toMatch(/@[a-z]/);
  });
});

describe("s19 per-message read", () => {
  test("READ: threads put the opening message first and mark follow-ups and replies by thread state", () => {
    const t = threadMessages(founder.messages);
    const inThread = (pred: (k: string) => boolean) => t.filter((x) => pred(x.threadKey)).sort((a, b) => a.index - b.index);
    const anna = inThread((k) => k === "anna@northzone.com|offload seed round: northzone");
    expect(anna.map((x) => x.role)).toEqual(["first_touch", "reply"]);
    expect(anna[0]!.outcome).toBe("replied");
    const leo = inThread((k) => k.startsWith("leo@"));
    expect(leo.map((x) => x.role)).toEqual(["first_touch", "follow_up"]);
    expect(leo[0]!.outcome).toBe("no_reply");
  });

  test("READ: only the workflow's own messages and follow-ups in its threads are read, replies are thread state", () => {
    expect(fr.reads).toHaveLength(24);
    expect(new Set(fr.reads.map((r) => r.role))).toEqual(new Set(["first_touch", "follow_up"]));
  });

  test("READ: the rule read labels the shape of a message", () => {
    const r = ruleRead("You backed [name] early, so you know the problem. {company} is a Mac app that automates the repeat parts. [number] design partners, [number] paying.\n\nWorth [number] minutes next week? Deck attached.", { id: "x", threadKey: "k", role: "first_touch", outcome: "unknown", subject: "" });
    expect(r).toMatchObject({ opener: "personal_hook", cta: "meeting", ctaTimeBoxed: true, intent: "book_meeting", hooks: ["their_portfolio"], proof: ["traction"], moves: ["hook", "claim", "proof", "ask", "attachment"] });
    expect(r.coreClaim).toBe("{company} is a Mac app that automates the repeat parts.");
    expect(r.positioning).toBe("Mac app");
    expect(r.shape).toMatchObject({ questions: 1, links: 0, attachments: 1 });
  });

  const coreOf = (r: { id: string }) => maskedCore(founder.messages.find((m) => m.id === r.id)!, fr.identity).core;

  test("READ: the model may overrule a label within the vocabulary", () => {
    const rule = fr.reads[0]!;
    const merged = mergeLabels(rule, JSON.stringify({ intent: "get_reply", opener: "problem_first", cta: "reply", proof: ["momentum"] }), fr.identity, coreOf(rule));
    expect(merged).toMatchObject({ intent: "get_reply", opener: "problem_first", cta: "reply", proof: ["momentum"], labelledBy: "model" });
  });

  test("READ: off-vocabulary values and unparsable replies fall back to the rule labels", () => {
    const rule = fr.reads[0]!;
    const merged = mergeLabels(rule, JSON.stringify({ intent: "close_deal", cta: "wire_money", proof: ["traction", "made_up"], audience: "aliens" }), fr.identity, coreOf(rule));
    expect(merged.intent).toBe(rule.intent);
    expect(merged.cta).toBe(rule.cta);
    expect(merged.proof).toEqual(rule.proof);
    expect(merged.audience).toBe(rule.audience);
    expect(mergeLabels(rule, "I think this is outreach.", fr.identity, coreOf(rule))).toEqual(rule);
  });

  test("READ: a model's free-text label is masked again and kept only when it is text of the message", () => {
    const rule = fr.reads[0]!;
    const merge = (coreClaim: string) => mergeLabels(rule, JSON.stringify({ coreClaim }), fr.identity, coreOf(rule)).coreClaim;
    expect(merge("Offload is a Mac app that watches a week of your work")).toBe("{company} is a Mac app that watches a week of your work");
    expect(merge("You backed Spotify early")).toBe("You backed [name] early");
    expect(merge("Offload saves 9 hours")).toBe(rule.coreClaim);
  });

  test("READ: each message is labelled once through the classify route, Haiku 5.5, with the rule read as the hint", () => {
    const labels = calls.filter((c) => c.role === "playbook_label");
    expect(labels).toHaveLength(24);
    for (const c of labels) {
      expect(c.route).toBe("classify");
      expect(c.model).toBe("claude-haiku-5-5");
      expect(c.prompt).toContain("<label_hint>");
      expect(c.prompt).toContain('<message untrusted="true">');
      expect(typeof c.validate).toBe("function");
    }
  });
});

describe("s19 known answers", () => {
  test("KNOWN: founder outreach: book a meeting with investors, a time-boxed call in most messages", () => {
    const s = fr.playbook.stats;
    expect(s.intent[0]).toMatchObject({ value: "book_meeting", count: 18 });
    expect(s.audience[0]).toMatchObject({ value: "investors", count: 18 });
    expect(s.cta[0]).toMatchObject({ value: "meeting", count: 18 });
    expect(s.ctaTimeBoxed).toBeGreaterThanOrEqual(9);
  });

  test("KNOWN: founder outreach: the angle is automating the repeat parts of a week, proved by traction", () => {
    const s = fr.playbook.stats;
    expect(s.proof[0]).toMatchObject({ value: "traction", count: 18 });
    expect(fr.playbook.message).toMatch(/automates the parts that repeat/);
    expect(fr.playbook.message).toContain("{company}");
    expect(s.opener[0]!.value).toBe("direct_pitch");
    expect(s.hooks.map((h) => h.value)).toEqual(expect.arrayContaining(["their_portfolio", "their_writing", "their_expertise", "their_preference"]));
  });

  test("KNOWN: founder outreach: 12 openers got a reply, 6 got a follow-up instead", () => {
    expect(fr.playbook.outcomes).toMatchObject({ messages: 18, replied: 12, noReply: 6, unknown: 0 });
  });

  test("KNOWN: founder follow-ups add proof, add urgency, lower the ask or ask for feedback", () => {
    const moves = Object.fromEntries(fr.playbook.cadence.followUpMoves.map((m) => [m.value, m.count]));
    expect(moves).toMatchObject({ adds_new_proof: 3, adds_urgency: 2, lowers_the_ask: 1, asks_for_feedback: 1 });
    expect(fr.playbook.cadence).toMatchObject({ threads: 18, followUps: 6, threadsWithFollowUp: 6, maxFollowUps: 1 });
  });

  test("KNOWN: support replies: resolve the issue, acknowledge first, the fix and when, then confirm", () => {
    const s = sr.playbook.stats;
    expect(s.intent[0]).toMatchObject({ value: "resolve_issue", count: 10 });
    expect(s.audience[0]!.value).toBe("customers");
    expect(s.opener[0]).toMatchObject({ value: "acknowledge", count: 10 });
    expect(s.proof.map((p) => p.value).slice(0, 2)).toEqual(["specific_fix", "timeline"]);
    expect(s.cta.map((c) => c.value).sort()).toEqual(["confirm", "reply"]);
    expect(sr.playbook.templates[0]!.slots.map((x) => x.slot)).toEqual(["greeting", "apology", "fix", "next_step", "ask", "sign_off"]);
  });

  test("KNOWN: recruiter DMs: book a short call with candidates, hooked on their work, proved by role facts", () => {
    const s = rr.playbook.stats;
    expect(s.intent[0]).toMatchObject({ value: "book_meeting", count: 7 });
    expect(s.audience[0]!.value).toBe("candidates");
    expect(s.hooks[0]).toMatchObject({ value: "their_work_history", count: 7 });
    expect(s.proof[0]).toMatchObject({ value: "role_fact", count: 7 });
    expect(s.ctaTimeBoxed).toBe(7);
    expect(rr.playbook.message).toMatch(/\{company\} is hiring/);
  });

  test("KNOWN: recruiter follow-ups lower the ask about 4 days later", () => {
    expect(rr.playbook.cadence).toMatchObject({ followUps: 4, medianDaysToFollowUp: 4, maxFollowUps: 1 });
    expect(rr.playbook.cadence.followUpMoves[0]).toMatchObject({ value: "lowers_the_ask", count: 4 });
    expect(rr.playbook.rules.find((r) => r.id === "follow_up")!.text).toBe("If there is no reply, follow up once, about 4 days later, with a message that lowers the ask.");
  });
});
