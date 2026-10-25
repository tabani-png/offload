import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dark, duration, easing, ink, light, radius, size, space, tokenCss, type } from "../src/design/tokens.ts";

const swift = readFileSync(join(import.meta.dir, "../../app/Sources/Core/Tokens.swift"), "utf8");

/** `static let name: Double = value` lines inside `enum <name> { ... }` (first level only). */
function swiftEnum(name: string): Record<string, number> {
  const start = swift.indexOf(`enum ${name} {`);
  if (start < 0) throw new Error(`enum ${name} not found in Tokens.swift`);
  let depth = 0;
  let end = start;
  for (let i = swift.indexOf("{", start); i < swift.length; i++) {
    if (swift[i] === "{") depth++;
    if (swift[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const out: Record<string, number> = {};
  for (const m of swift.slice(start, end).matchAll(/static let (\w+): Double = ([\d.]+)/g)) out[m[1]!] = Number(m[2]);
  return out;
}

describe("tokens parity with Tokens.swift", () => {
  test("TOKENS: radii equal Tokens.Radius", () => {
    const r = swiftEnum("Radius");
    expect(Object.keys(r).length).toBeGreaterThan(5);
    for (const [k, v] of Object.entries(r)) expect(Number(radius[k as keyof typeof radius])).toBe(v);
    expect([radius.card, radius.well, radius.row]).toEqual([24, 16, 12]);
  });

  test("TOKENS: spacing equals Tokens.Space (4-pt grid)", () => {
    const s = swiftEnum("Space");
    for (const [k, v] of Object.entries(s)) {
      if (k === "nudge") continue;
      expect(Number(space[k as keyof typeof space])).toBe(v);
    }
    for (const v of Object.values(space)) expect(v % 4).toBe(0);
  });

  test("TOKENS: easing equals CubicBezier.outExpo and .standard", () => {
    const m = /outExpo = CubicBezier\(x1: ([\d.]+), y1: ([\d.]+), x2: ([\d.]+), y2: ([\d.]+)\)/.exec(swift);
    expect(m).not.toBeNull();
    expect(String(easing.outExpo)).toBe(`cubic-bezier(${m![1]}, ${m![2]}, ${m![3]}, ${m![4]})`);
    expect(easing.outExpo).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    const s = /standard = CubicBezier\(x1: ([\d.]+), y1: ([\d.]+), x2: ([\d.]+), y2: ([\d.]+)\)/.exec(swift);
    expect(String(easing.standard)).toBe(`cubic-bezier(${s![1]}, ${s![2]}, ${s![3]}, ${s![4]})`);
  });

  test("TOKENS: durations equal Tokens.Duration and stay within 150-300 ms for transitions", () => {
    const d = swiftEnum("Duration");
    for (const [k, v] of Object.entries(d)) expect(Number(duration[k as keyof typeof duration])).toBe(v);
    for (const k of ["fast", "base", "slow"] as const) {
      expect(duration[k]).toBeGreaterThanOrEqual(0.15);
      expect(duration[k]).toBeLessThanOrEqual(0.3);
    }
  });

  test("TOKENS: sizes and ink ladder equal Tokens.Size and Tokens.Ink", () => {
    for (const [k, v] of Object.entries(swiftEnum("Size"))) expect(Number(size[k as keyof typeof size])).toBe(v);
    for (const [k, v] of Object.entries(swiftEnum("Ink"))) expect(Number(ink[k as keyof typeof ink])).toBe(v);
  });

  test("TOKENS: type scale sizes match TypeScale and use weights 400/500 only", () => {
    for (const m of swift.matchAll(/static let (\w+) = TypeStyle\(name: "\w+", size: ([\d.]+), weight: (\d+)/g)) {
      const t = type[m[1] as keyof typeof type];
      if (!t) continue; // keyWord and badge have no web use
      expect(Number(t.size)).toBe(Number(m[2]));
    }
    for (const t of Object.values(type)) expect([400, 500]).toContain(t.weight);
  });

  test("TOKENS: status hues match Theme.swift (colour means state)", () => {
    expect(dark.status).toMatchObject({ working: "#4C9DFF", needsYou: "#FFC75C", done: "#30D158", recording: "#FF453A" });
    expect(light.statusInk).toMatchObject({ working: "#0058C4", needsYou: "#6E4500", done: "#1A7A3A", recording: "#C4241B" });
    expect(dark.primaryFill).toBe("#FFFFFF");
  });

  test("TOKENS: tokenCss exposes radii, easing and reduced motion", () => {
    const css = tokenCss();
    expect(css).toContain("--radius-card: 24px;");
    expect(css).toContain("--radius-well: 16px;");
    expect(css).toContain("--radius-row: 12px;");
    expect(css).toContain("--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);");
    expect(css).toContain("--dur-base: 200ms;");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
