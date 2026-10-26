// Fix round 5 for PR #11 (Codex re-review of adcba7b): a known contact whose name is also an ordinary word ("Will",
// "Hope") is still a leak when capitalised, and masking and the leak check make ONE decision per word, so they can never
// disagree: whatever maskText would mask, findTextLeaks reports, and the other way round. Each test failed before its fix.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { checkDepersonalised, findTextLeaks, lowerWords } from "../../src/playbook/leak.ts";
import { buildIdentity, maskContacts, maskText } from "../../src/playbook/mask.ts";
import { PlaybookLeakError } from "../../src/playbook/leak.ts";
import { setPlaybookNotes, writePlaybook } from "../../src/playbook/store.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { build, founderPersona, NOW, world, type World } from "./setup.ts";

const NONE = new Set<string>();
const MAIL: PlaybookMessage[] = [
  ["will@example.com", "Will", "Happy to send the deck. Worth a call?"],
  ["hope.smith@acme-ventures.com", "Hope", "Hope you are well. Worth a call?"],
  ["tom.hook@progress.com", "Tom", "We help founders with payments. Would you have 15 minutes?"],
].map(([to, first, line], i) => ({ id: `m${i}`, channel: "email", to: [to!], subject: `Intro ${i}`, body: `Hi ${first},\n\n${line}\n\nBest,\nDana`, sentAt: NOW - (10 - i) * 86_400_000 }));
const ID = buildIdentity(MAIL, "sign: Dana Shah\ncompany: Northzone");
const identityLeaks = (t: string, vocab: ReadonlySet<string>) => findTextLeaks(t, ID, NONE, "notes", vocab).filter((l) => ["author", "company", "name"].includes(l.kind));

describe("s19 fix 5: masking and the leak check agree", () => {
  test("LEAK: a capitalised known contact named like an ordinary word is a leak", () => {
    for (const t of ["Ask Will for an introduction.", "Write to Hope like this.", "Thank Hook for the call."]) {
      expect([t, findTextLeaks(t, ID, NONE, "notes").map((l) => l.kind)]).toEqual([t, ["name"]]);
    }
    // The same words as ordinary lower-case wording stay clean.
    expect(findTextLeaks("We will hope for a hook.", ID, NONE, "notes")).toEqual([]);
  });

  test("MASK: the same capitalised contacts are masked, the lower-case words are not", () => {
    expect(maskText("Ask Will for an introduction.", ID)).toBe("Ask [name] for an introduction.");
    expect(maskText("We will hope for a hook.", ID)).toBe("We will hope for a hook.");
  });

  test("LEAK: a notes edit naming a capitalised contact is refused", async () => {
    const fr = await build(await founderPersona());
    const id = buildIdentity([...MAIL], "sign: Dana Shah");
    expect(checkDepersonalised({ ...fr.playbook, notes: "Keep it short." }, { ...fr.identity, people: new Set([...fr.identity.people, ...id.people]) })).toEqual([]);
    const leaks = checkDepersonalised({ ...fr.playbook, notes: "Ask Will for an introduction." }, { ...fr.identity, people: new Set([...fr.identity.people, ...id.people]) });
    expect(leaks.map((l) => [l.kind, l.path])).toEqual([["name", "notes"]]);
  });

  test("MASK: maskText and findTextLeaks make the same call on every generated text (property test)", () => {
    const pool = [
      "will", "hope", "hook", "tom", "dana", "shah", "northzone", "acme", "progress", "payments", "founders", "the", "your",
      "order", "data", "pricing", "stripe", "priya", "monday", "first", "message", "ask", "a", "j", "smith", "example",
    ];
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const disagreements: string[] = [];
    for (let k = 0; k < 4000; k++) {
      const words = Array.from({ length: 1 + rnd(4) }, () => {
        const w = pool[rnd(pool.length)]!;
        return rnd(2) === 0 ? w : w[0]!.toUpperCase() + w.slice(1);
      });
      const t = words.map((w, i) => (i > 0 && rnd(4) === 0 ? `. ${w}` : i > 0 ? ` ${w}` : w)).join("") + ".";
      // One vocabulary for both: the lower-case words of this text plus a fixed set (what the playbook writes in lower case).
      const vocab = new Set([...lowerWords([t]), "payments", "pricing"]);
      const masked = maskText(t, ID, {}, vocab) !== maskContacts(t);
      const leaked = identityLeaks(t, vocab).length > 0;
      if (masked !== leaked) disagreements.push(`${t} masked=${masked} leaked=${leaked}`);
      // Masked text is never a leak (idempotent with the check).
      const m = maskText(t, ID, {}, vocab);
      if (identityLeaks(m, new Set([...lowerWords([m]), ...vocab])).length > 0) disagreements.push(`${t} -> ${m} still leaks`);
    }
    expect(disagreements.slice(0, 10)).toEqual([]);
  });
});

describe("s19 fix 5: generator openers", () => {
  test("LEAK: a contact named like a generator opener is a leak except where the generator writes the word", () => {
    const id = buildIdentity([{ ...MAIL[0]!, to: ["ann.short@balderton.com"], body: "Hi Ann,\n\nWorth a call?\n\nBest,\nDana" }, MAIL[1]!, MAIL[2]!]);
    expect(findTextLeaks("Short form of the first message.", id, NONE, "templates[0].text")).toEqual([]);
    expect(findTextLeaks("Ask Short for an intro.", id, NONE, "notes").map((l) => l.kind)).toEqual(["name"]);
    expect(maskText("Ask Short for an intro.", id)).toBe("Ask [name] for an intro.");
  });

  test("LEAK: every word synth.ts writes capitalised at a sentence start is a known opener (drift guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { GENERATOR_OPENERS } = await import("../../src/playbook/mask.ts");
    const src = readFileSync(join(import.meta.dir, "../../src/playbook/synth.ts"), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");
    const missing = new Set<string>();
    for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
      if (!/\s/.test(s)) continue;
      for (const o of s.matchAll(/(?:^|[.!?:]\s+)(\p{Lu}[\p{L}'’-]*)/gu)) {
        const w = o[1]!.toLowerCase();
        if (!GENERATOR_OPENERS.has(w) && !/^(?:json|i)$/.test(w)) missing.add(w);
      }
    }
    expect([...missing]).toEqual([]);
  });
});

describe("s19 fix 5: call sites", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(() => w.cleanup());

  test("LEAK: setPlaybookNotes refuses a capitalised contact named like an ordinary word", async () => {
    const pb = { ...(await build(await founderPersona())).playbook, workflowId: w.outreach.id };
    writePlaybook(w.home, pb);
    expect(() => setPlaybookNotes(w.home, w.outreach.id, "Ask Will for an introduction.", ID, NOW)).toThrow(PlaybookLeakError);
    expect(setPlaybookNotes(w.home, w.outreach.id, "We will keep it short.", ID, NOW).notes).toBe("We will keep it short.");
  });
});
