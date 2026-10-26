// Fix round 7 for PR #11 (independent review of 9437da5): vocabulary default-deny. A word of mail is kept only when it
// is a common English word (bundled list), a word the generator writes, or an allowed acronym or weekday; handles,
// snake_case names and link paths are masked; a month is kept only in a date; a word next to a masked name goes with
// it. Builds never fail because of masking. Each test failed before its fix.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlaybook } from "../../src/playbook/build.ts";
import { findTextLeaks } from "../../src/playbook/leak.ts";
import { buildIdentity, emptyIdentity, maskedCore, maskText } from "../../src/playbook/mask.ts";
import type { PlaybookMessage } from "../../src/playbook/types.ts";
import { StubModel } from "../../src/models/model.ts";
import { NOW } from "./setup.ts";

const mk = (i: number, body: string): PlaybookMessage => ({
  id: `m${i}`, channel: "email", to: [`x${i}@corp${i}.com`], subject: `Payroll ${i}`, body: `Hi Sam,\n\n${body}\n\nBest,\nMuhammad Ali`, sentAt: NOW - (10 - i) * 86_400_000,
});
const NONE = new Set<string>();
const id0 = emptyIdentity();
const survives = (out: string, names: readonly string[]) => names.filter((n) => new RegExp(`(?<![\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(out));

describe("s19 fix 7: vocabulary default-deny", () => {
  test("MASK: lower-case names are masked (reviewer repro: priya raman, o'brien)", () => {
    for (const t of ["We build payroll tooling with priya raman.", "We met o'brien at the fair."]) {
      expect([t, survives(maskText(t, id0), ["priya", "raman", "o'brien", "brien"])]).toEqual([t, []]);
      expect([t, findTextLeaks(t, id0, NONE, "message").map((l) => l.kind)]).toEqual([t, ["name"]]);
    }
  });

  test("PLAYBOOK: lower-case names never reach the playbook or the model prompt", async () => {
    const msgs = [0, 1, 2].map((i) => mk(i, "We build payroll tooling with priya raman. Would you take 15 minutes this week?"));
    for (const model of [null, new StubModel()]) {
      const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: msgs, model, now: NOW });
      expect(survives(JSON.stringify(r.playbook), ["priya", "raman"])).toEqual([]);
      for (const p of r.prompts) expect(survives(p, ["priya", "raman"])).toEqual([]);
    }
  });

  test("MASK: handles, snake_case names and link paths are masked and are leaks", () => {
    for (const [t, names] of [
      ["Ping @priyaraman about it.", ["priyaraman"]],
      ["Ask priya_raman on slack.", ["priya_raman", "priya", "raman"]],
      ["Her profile: linkedin.com/in/priya-raman is great.", ["priya-raman", "priya", "raman"]],
      ["Follow @bluebird for news.", ["bluebird"]],
      ["Ask blue_bird first.", ["blue_bird"]],
    ] as Array<[string, string[]]>) {
      expect([t, survives(maskText(t, id0), names)]).toEqual([t, []]);
      expect([t, findTextLeaks(t, id0, NONE, "message").length > 0]).toEqual([t, true]);
    }
    expect(findTextLeaks("See [link]/in/priya-raman for more.", id0, NONE, "message").length).toBeGreaterThan(0);
  });

  test("MASK: a month is kept only in a date", () => {
    for (const [t, names] of [
      ["We met in April Smith's office.", ["April", "Smith"]],
      ["We talked on May Chen's call.", ["May", "Chen"]],
      ["Send it by June Lee.", ["June", "Lee"]],
      ["April said yes.", ["April"]],
    ] as Array<[string, string[]]>) {
      expect([t, survives(maskText(t, id0), names)]).toEqual([t, []]);
    }
    expect(maskText("We start in April and ship by May 5.", id0)).toBe("We start in April and ship by May [number].");
  });

  test("MASK: a common word next to a masked name goes with it", () => {
    expect(survives(maskText("We met grace raman last week.", id0), ["grace", "raman"])).toEqual([]);
    expect(survives(maskText("We met Raman Will last week.", id0), ["Raman", "Will"])).toEqual([]);
  });

  test("MASK: ordinary wording of mail and of the generator is kept", () => {
    for (const t of ["We build payroll software for startups; would you take a short call this week?", "Thanks for the order. It ships on Monday and the tracking link follows.", "Keep it under the usual length, and end with one time-boxed ask."]) {
      expect([t, maskText(t, id0)]).toEqual([t, t]);
      expect([t, findTextLeaks(t, id0, NONE, "message")]).toEqual([t, []]);
    }
  });

  test("KNOWN: fuzz, lower-case names, handles, link paths and months never survive, and every build succeeds", async () => {
    const lower = ["priya", "raman", "okafor", "lindqvist", "nguyen", "o'brien", "njeri", "wambugu", "zorblax"];
    const months = ["April", "May", "June", "August"];
    const surnames = ["Smith", "Chen", "Okafor", "Lee"];
    const shapes = [
      (a: string, b: string) => `We work with ${a} ${b} on payroll.`,
      (a: string) => `Ping @${a} about the pilot.`,
      (a: string, b: string) => `Ask ${a}_${b} for the deck.`,
      (a: string, b: string) => `See linkedin.com/in/${a}-${b} for her work.`,
      (_a: string, _b: string, m: string, s: string) => `We met in ${m} ${s}'s office.`,
      (_a: string, _b: string, m: string, s: string) => `${m} ${s} liked the demo.`,
      (_a: string, _b: string, m: string) => `${m} said yes.`,
    ];
    let seed = 99;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const bad: string[] = [];
    for (let k = 0; k < 150; k++) {
      const used: string[] = [];
      const bodies = [0, 1, 2].map(() => {
        const a = lower[rnd(lower.length)]!, b = lower[rnd(lower.length)]!, m = months[rnd(months.length)]!, s = surnames[rnd(surnames.length)]!;
        const shape = rnd(shapes.length);
        used.push(...(shape <= 3 ? [a, ...(shape === 1 ? [] : [b])] : shape === 6 ? [m] : [m, s]));
        return `${shapes[shape]!(a, b, m, s)} Would you have 15 minutes?`;
      });
      const msgs = bodies.map((b, i) => mk(i, b));
      try {
        const r = await buildPlaybook({ workflowId: "w", channel: "email", messages: msgs, model: null, now: NOW });
        const out = [JSON.stringify(r.playbook), ...msgs.map((m) => maskedCore(m, r.identity).core)].join("\n");
        const s = survives(out, [...new Set(used)]);
        if (s.length > 0) bad.push(`${s.join(",")} in ${bodies.join(" / ")}`);
      } catch (e) {
        bad.push(`build failed: ${(e as Error).message} for ${bodies.join(" / ")}`);
      }
    }
    expect(bad.slice(0, 8)).toEqual([]);
  });

  test("MASK: the bundled word list records its source and licence", () => {
    const dir = join(import.meta.dir, "../../src/playbook/wordlist");
    expect(existsSync(join(dir, "SCOWL-Copyright.txt"))).toBe(true);
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toMatch(/SCOWL/);
    expect(readme).toMatch(/size 50/i);
    expect(buildIdentity([mk(0, "x")]).author.size).toBeGreaterThan(0);
  });
});
