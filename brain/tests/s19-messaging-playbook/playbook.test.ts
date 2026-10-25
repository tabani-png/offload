// OUTCOME: counts with sample sizes, "too few to say", never a rate. PLAYBOOK: playbook.json + PLAYBOOK.md.
// NUMBERS: every number is code. ROUTER: labels on Haiku 5.5, synthesis on Opus 5.5. LEAK: fail closed.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { StubModel, tagged, type ModelRequest } from "../../src/models/model.ts";
import { ModelBackend, ModelRouter, RoutedModel } from "../../src/models/router.ts";
import { buildPlaybook, type BuildPlaybookResult } from "../../src/playbook/build.ts";
import { assertDepersonalised, checkDepersonalised, PlaybookLeakError, type LeakKind } from "../../src/playbook/leak.ts";
import { renderPlaybookMd } from "../../src/playbook/render.ts";
import { playbookPath, readPlaybook, readPlaybookMd, writePlaybook } from "../../src/playbook/store.ts";
import { acceptWording, baselinePlaybook } from "../../src/playbook/synth.ts";
import { MIN_OUTCOME_SAMPLE, PLAYBOOK_SCHEMA, SLOTS, type Playbook, type PlaybookMessage } from "../../src/playbook/types.ts";
import { tempHome } from "../helpers.ts";
import { build, containsWord, founderPersona, NOW, PERSONAL, personas, recruiterPersona, supportPersona, type Persona } from "./setup.ts";

let all: Array<{ p: Persona; r: BuildPlaybookResult }>;
let fr: BuildPlaybookResult;
beforeAll(async () => {
  all = [];
  for (const p of await personas()) all.push({ p, r: await build(p) });
  fr = all[0]!.r;
});

/** The baseline wording as the synth model would echo it, with one change. */
function synthWith(change: (j: { message: string; rules: Array<{ id: string; text: string }>; skeletons: string[]; avoid: string[] }) => void) {
  return new StubModel({
    playbook: (req: ModelRequest) => {
      const j = JSON.parse(tagged(req.prompt, "baseline")!) as Parameters<typeof change>[0];
      change(j);
      return JSON.stringify(j);
    },
  });
}

describe("s19 outcomes", () => {
  test("OUTCOME: every pattern row is a count with its sample size; the parts add up", () => {
    for (const { r } of all) {
      const o = r.playbook.outcomes;
      expect(o.replied + o.noReply + o.unknown).toBe(o.messages);
      for (const p of o.byPattern) {
        expect(p.replied + p.noReply + p.unknown).toBe(p.sent);
        expect(p.enough).toBe(p.replied + p.noReply >= MIN_OUTCOME_SAMPLE);
      }
    }
  });

  test("OUTCOME: support thread state: 6 replied, 2 did not, 2 unknown", () => {
    expect(all[1]!.r.playbook.outcomes).toMatchObject({ messages: 10, replied: 6, noReply: 2, unknown: 2 });
  });

  test("OUTCOME: under the sample size a pattern reads 'too few to say'", async () => {
    const few = await build({ ...supportPersona(), messages: supportPersona().messages.slice(0, 4) });
    expect(few.playbook.outcomes.byPattern.every((p) => !p.enough)).toBe(true);
    const md = renderPlaybookMd(few.playbook);
    const section = md.slice(md.indexOf("## What got replies"), md.indexOf("## Counted patterns"));
    expect(section.match(/too few to say/g)?.length).toBe(few.playbook.outcomes.byPattern.length);
  });

  test("OUTCOME: no rate, percentage or share is written for outcomes", () => {
    for (const { r } of all) {
      const md = renderPlaybookMd(r.playbook);
      const section = md.slice(md.indexOf("## What got replies"), md.indexOf("## Counted patterns"));
      expect(section).not.toMatch(/%|rate|\b0\.\d/);
      expect(JSON.stringify(r.playbook.outcomes)).not.toMatch(/rate|share|percent/i);
    }
  });

  test("OUTCOME: a pattern that never got a reply in enough tries goes to avoid, with its count", async () => {
    const msgs: PlaybookMessage[] = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, channel: "dm", to: [`linkedin:person-${i}`], subject: "", body: `Hi there,\n\nTired of chasing invoices by hand? We automate the chasing.\n\nWould a short call help?\n\nSam`, sentAt: NOW + i, replied: false }));
    const r = await buildPlaybook({ workflowId: "wf_test", channel: "dm", messages: msgs, model: new StubModel(), now: NOW });
    expect(r.playbook.avoid).toContain('opener "problem first": no replies in 6 tries in this data.');
  });
});

describe("s19 playbook files", () => {
  test("PLAYBOOK: playbook.json carries the schema, version, message, rules, templates, skeletons, cadence, avoid and counts", () => {
    const pb = fr.playbook;
    expect(pb).toMatchObject({ schema: PLAYBOOK_SCHEMA, version: 1, workflowId: "wf_test", channel: "email", builtAt: NOW, sources: { messages: 24, threads: 18 }, notes: "", history: [{ version: 1, at: NOW, change: "built" }] });
    expect(pb.message.split(/(?<=[.!?])\s+/).length).toBeGreaterThanOrEqual(2);
    expect(pb.message.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3);
    expect(pb.rules.some((r) => r.kind === "do") && pb.rules.some((r) => r.kind === "dont")).toBe(true);
    expect(new Set(pb.rules.map((r) => r.id)).size).toBe(pb.rules.length);
    expect(pb.avoid.length).toBeGreaterThan(0);
  });

  test("PLAYBOOK: templates are slots in order, every slot explained", () => {
    for (const { r } of all)
      for (const t of r.playbook.templates) {
        const inText = (t.text.match(/\{[a-z_]+\}/g) ?? []).map((x) => x.slice(1, -1));
        expect(inText[0]).toBe("greeting");
        expect(inText.at(-1)).toBe("sign_off");
        for (const s of inText) expect(SLOTS as readonly string[]).toContain(s);
        expect(t.slots.map((s): string => s.slot)).toEqual(inText.filter((s, i) => inText.indexOf(s) === i));
      }
    expect(fr.playbook.templates.map((t) => t.id)).toEqual(["first_touch", "follow_up"]);
    expect(fr.playbook.templates[0]!.text).toBe("{greeting}\n\n{claim}\n\n{proof}\n\n{ask}\n\n{sign_off}");
  });

  test("PLAYBOOK: 3 to 5 de-personalised skeletons, padded when a workflow has fewer shapes", () => {
    for (const { r } of all) {
      expect(r.playbook.skeletons.length).toBeGreaterThanOrEqual(3);
      expect(r.playbook.skeletons.length).toBeLessThanOrEqual(5);
      for (const s of r.playbook.skeletons) expect(s).toMatch(/\{greeting\}[\s\S]*\{sign_off\}/);
    }
    expect(all[2]!.r.playbook.skeletons).toHaveLength(3);
  });

  test("PLAYBOOK: PLAYBOOK.md has every section and renders the same bytes from the same JSON", () => {
    const md = renderPlaybookMd(fr.playbook);
    for (const h of ["# Messaging playbook", "## The message", "## Do", "## Don't", "## Templates", "## Example skeletons", "## Cadence", "## Avoid", "## What got replies", "## Counted patterns", "## Notes"]) expect(md).toContain(`${h}\n`);
    expect(renderPlaybookMd(JSON.parse(JSON.stringify(fr.playbook)) as Playbook)).toBe(md);
  });

  test("PLAYBOOK: written 0600 next to the workflow and read back unchanged", () => {
    const { home, cleanup } = tempHome();
    try {
      mkdirSync(join(home, "workflows", "wf_test"), { recursive: true });
      writePlaybook(home, fr.playbook);
      expect(readPlaybook(home, "wf_test")).toEqual(fr.playbook);
      expect(readPlaybookMd(home, "wf_test")).toBe(renderPlaybookMd(fr.playbook));
      expect(statSync(playbookPath(home, "wf_test")).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  test("PLAYBOOK: a rebuild bumps the version, keeps the user's notes and appends history", async () => {
    const prev: Playbook = { ...fr.playbook, notes: "Keep the ask small.", version: 3, history: [{ version: 3, at: 1, change: "notes" }] };
    const r = await build(all[0]!.p, new StubModel(), { previous: prev, now: NOW + 1 });
    expect(r.playbook.version).toBe(4);
    expect(r.playbook.notes).toBe("Keep the ask small.");
    expect(r.playbook.history.map((h) => [h.version, h.change])).toEqual([[3, "notes"], [4, "built"]]);
  });

  test("PLAYBOOK: fewer than 3 messages is refused", async () => {
    await expect(build({ ...supportPersona(), messages: supportPersona().messages.slice(0, 2) })).rejects.toThrow(/at least 3/);
  });
});

describe("s19 numbers are code", () => {
  test("NUMBERS: the same messages give the same playbook, byte for byte", async () => {
    const again = await build(all[0]!.p);
    expect(JSON.stringify(again.playbook)).toBe(JSON.stringify(fr.playbook));
  });

  test("NUMBERS: counts match a hand count of the founder fixture", () => {
    const s = fr.playbook.stats;
    expect(s.messages).toBe(24);
    expect(s.byRole).toEqual([{ value: "first_touch", count: 18, share: 0.75 }, { value: "follow_up", count: 6, share: 0.25 }]);
    expect(s.messagesWithLinks).toBe(0);
    expect(s.messagesWithAttachments).toBe(5);
  });

  test("NUMBERS: a wording model that adds a figure is refused; the counts stay", async () => {
    const r = await build(all[0]!.p, synthWith((j) => (j.message += " About 90% of investors reply.")));
    expect(r.playbook.models.synthUsed).toBe(false);
    expect(r.playbook.warnings[0]).toMatch(/adds a number that is not one of the counts/);
    expect(r.playbook.message).toBe(fr.playbook.message);
    expect(r.playbook.stats).toEqual(fr.playbook.stats);
    expect(r.playbook.outcomes).toEqual(fr.playbook.outcomes);
  });

  test("NUMBERS: a wording model that only rewords is used, and the counts are those of the rules-only build", async () => {
    const r = await build(all[0]!.p, synthWith((j) => (j.message = j.message.replace("The goal is to get", "Aim: get"))));
    expect(r.playbook.models.synthUsed).toBe(true);
    expect(r.playbook.message.startsWith("Aim: get investors")).toBe(true);
    const rulesOnly = await build(all[0]!.p, null);
    expect(r.playbook.stats).toEqual(rulesOnly.playbook.stats);
    expect(r.playbook.cadence).toEqual(rulesOnly.playbook.cadence);
  });

  test("NUMBERS: a labeller that sends counts, lengths or outcomes changes none of them", async () => {
    const m = new StubModel({ playbook_label: (req) => JSON.stringify({ ...JSON.parse(tagged(req.prompt, "label_hint")!), words: 999, shape: { words: 999 }, outcome: "replied", replied: true, count: 50 }) });
    const r = await build(all[0]!.p, m);
    expect(r.playbook.stats).toEqual(fr.playbook.stats);
    expect(r.playbook.outcomes).toEqual(fr.playbook.outcomes);
  });

  test("NUMBERS: the rules' figures are the computed limits and counts", () => {
    const pb = fr.playbook;
    expect(pb.rules.find((r) => r.id === "length")!.text).toBe(`Keep it under ${pb.stats.limits.maxWords} words; most are about ${pb.stats.medianWords}.`);
    expect(pb.rules.find((r) => r.id === "proof")!.text).toBe("Back it with traction figures from your facts (18 of 18 messages do).");
  });
});

describe("s19 router", () => {
  test("ROUTER: per-message labels run on Haiku 5.5 (classify), the playbook wording on Opus 5.5 (understand)", async () => {
    const { home, cleanup } = tempHome();
    try {
      const router = new ModelRouter({ home, backend: new ModelBackend("stub", new StubModel()), now: () => NOW, monthlyBudgetUsd: null, env: {} });
      await build(all[1]!.p, new RoutedModel(router));
      const d = router.recentDecisions();
      expect(d.filter((x) => x.route === "classify").map((x) => x.model)).toEqual(Array(10).fill("claude-haiku-5-5"));
      expect(d.filter((x) => x.route === "understand").map((x) => x.model)).toEqual(["claude-opus-5-5"]);
    } finally {
      cleanup();
    }
  });

  test("ROUTER: a label reply that is not JSON climbs the ladder Haiku -> Sonnet with the reason kept", async () => {
    const { home, cleanup } = tempHome();
    try {
      const flaky = new StubModel({ playbook_label: (req) => (req.model === "claude-haiku-5-5" ? "sure, this is outreach" : tagged(req.prompt, "label_hint")!) });
      const router = new ModelRouter({ home, backend: new ModelBackend("stub", flaky), now: () => NOW, monthlyBudgetUsd: null, env: {} });
      const r = await build(all[1]!.p, new RoutedModel(router));
      const labels = router.recentDecisions().filter((x) => x.route === "classify");
      expect(labels.every((x) => x.tiers.join(">") === "haiku>sonnet" && x.escalations[0] === "haiku: the reply is not the label JSON")).toBe(true);
      expect(r.reads.every((x) => x.labelledBy === "model")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("s19 de-personalisation", () => {
  test("LEAK: the playbooks of all three personas pass the check", () => {
    for (const { r } of all) expect(checkDepersonalised(r.playbook, r.identity)).toEqual([]);
  });

  test("LEAK: no persona name, company, address or private figure in playbook.json or PLAYBOOK.md", () => {
    for (const { p, r } of all) {
      const text = `${JSON.stringify(r.playbook)}\n${renderPlaybookMd(r.playbook)}`;
      for (const w of PERSONAL[p.name]) expect(`${p.name}:${w}:${containsWord(text, w)}`).toBe(`${p.name}:${w}:false`);
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
  });

  test("LEAK: a name, email, phone, link, the author or the company anywhere fails closed, naming kind and field only", () => {
    const pb = fr.playbook;
    const cases: Array<[Playbook, LeakKind, string]> = [
      [{ ...pb, rules: pb.rules.map((r, i) => (i === 0 ? { ...r, text: `${r.text} Mention Spotify.` } : r)) }, "name", "rules[0].text"],
      [{ ...pb, skeletons: [...pb.skeletons.slice(0, 2), "{greeting}\nWrite to anna@northzone.com\n{sign_off}"] }, "email", "skeletons[2]"],
      [{ ...pb, avoid: [...pb.avoid, "Call +44 7700 900123 first."] }, "phone", `avoid[${pb.avoid.length}]`],
      [{ ...pb, message: `${pb.message} See offload.so.` }, "link", "message"],
      [{ ...pb, notes: "Sign as Muhammad." }, "author", "notes"],
      [{ ...pb, notes: "We are Offload." }, "company", "notes"],
      [{ ...pb, notes: "We raised 2.5M from Northzone." }, "number", "notes"],
    ];
    for (const [bad, kind, path] of cases) {
      const leaks = checkDepersonalised(bad, fr.identity);
      expect(leaks).toContainEqual({ kind, path });
      try {
        assertDepersonalised(bad, fr.identity);
        throw new Error("not refused");
      } catch (err) {
        expect(err).toBeInstanceOf(PlaybookLeakError);
        expect((err as Error).message).not.toMatch(/Spotify|anna@|7700|offload\.so|Muhammad|2\.5M/);
      }
    }
  });

  test("LEAK: a wording model that names someone is refused and the code baseline stands", async () => {
    const r = await build(all[0]!.p, synthWith((j) => (j.avoid = [...j.avoid, "Writing to Anna at Northzone the way Muhammad did."])));
    expect(r.playbook.models.synthUsed).toBe(false);
    expect(r.playbook.warnings[0]).toMatch(/kept a personal detail/);
    expect(checkDepersonalised(r.playbook, r.identity)).toEqual([]);
    expect(JSON.stringify(r.playbook)).not.toContain("Northzone");
  });

  test("LEAK: a build whose carried notes name someone fails closed", async () => {
    const prev: Playbook = { ...fr.playbook, notes: "Ask Anna for an intro first." };
    await expect(build(all[0]!.p, new StubModel(), { previous: prev })).rejects.toBeInstanceOf(PlaybookLeakError);
  });

  test("LEAK: the wording check refuses a dropped slot, a changed rule id or a wrong skeleton count", () => {
    const pb = fr.playbook;
    const b = baselinePlaybook(fr.reads, pb.stats, pb.outcomes, pb.cadence);
    const nums = new Set(["18"]);
    const ok = { message: b.message, rules: b.rules.map((r) => ({ id: r.id, text: r.text })), skeletons: b.skeletons, avoid: b.avoid };
    expect(acceptWording(JSON.stringify({ ...ok, skeletons: ok.skeletons.map((s) => s.replace("{sign_off}", "")) }), b, nums, fr.identity)).toMatchObject({ ok: false, reason: "a skeleton dropped a slot" });
    expect(acceptWording(JSON.stringify({ ...ok, rules: ok.rules.map((r, i) => (i === 0 ? { ...r, id: "new" } : r)) }), b, nums, fr.identity)).toMatchObject({ ok: false });
    expect(acceptWording(JSON.stringify({ ...ok, skeletons: ok.skeletons.slice(0, 2) }), b, nums, fr.identity)).toMatchObject({ ok: false, reason: "skeletons are not 3-5 strings" });
  });

  test("LEAK: the recruiter's employers and the support persona's customers never reach the playbook", async () => {
    const r = await build(recruiterPersona());
    const s = await build(supportPersona());
    expect(JSON.stringify(r.playbook)).not.toMatch(/Stripe|Algolia|Monzo|Figma|Hana|Taylor|Fernway/);
    expect(JSON.stringify(s.playbook)).not.toMatch(/Maria|Kwame|Leeds|Jordan|Brightcart/);
    void founderPersona;
  });
});
