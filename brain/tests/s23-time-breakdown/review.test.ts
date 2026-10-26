// s23 PR #29 review (P3): honest savings never returns NaN; two tasks with one label and no template stay apart.
import { describe, expect, test } from "bun:test";
import { honestFreed, taskNames } from "../../src/time/breakdown.ts";

describe("s23 review fixes", () => {
  test("FREED: honestFreed never returns NaN or Infinity; a non-finite share or estimate frees nothing", () => {
    for (const [obs, est, pct] of [[1.3, 1, Number.NaN], [1.3, Number.NaN, 0.8], [1.3, 1, Number.POSITIVE_INFINITY], [Number.NaN, 1, 0.8], [1.3, Number.POSITIVE_INFINITY, Number.NaN]]) {
      const f = honestFreed(obs!, est!, pct!);
      expect({ obs, est, pct, finite: Number.isFinite(f.hours) }).toEqual({ obs, est, pct, finite: true });
      expect(f.hours).toBe(0);
      expect(f.leftDisplay).toMatch(/^\d+\.\d h$/);
    }
    expect(honestFreed(1.3, 2, 0.8).hours).toBeCloseTo(1.04, 9);
  });

  test("SUMS: two tasks with one label and an empty template get a short disambiguator, never one name twice", () => {
    const task = (id: string, name: string, template: string) => ({ id, label: { kind: "other", name, description: "" }, profile: { template } }) as any;
    const names = taskNames([task("t_a", "Finder", ""), task("t_b", "Finder", ""), task("t_c", "Finder", "  "), task("t_d", "Notes", "")]);
    expect(names.get("t_a")).toBe("Finder");
    expect(names.get("t_b")).toBe("Finder · 2");
    expect(names.get("t_c")).toBe("Finder · 3");
    expect(names.get("t_d")).toBe("Notes");
    const templated = taskNames([task("t_x", "Calls", "Meet - Design review"), task("t_y", "Calls", "Meet - Sprint planning")]);
    expect(templated.get("t_x")).toBe("Calls · Meet - Design review");
    expect(templated.get("t_y")).toBe("Calls · Meet - Sprint planning");
    expect(new Set(templated.values()).size).toBe(2);
  });
});
