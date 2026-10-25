import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const SRC = join(import.meta.dir, "../src");
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const read = (f: string): string => readFileSync(join(SRC, f), "utf8");
const code = (f: string): string =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

test("PURE: src imports only relative files inside the package", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const specs = [...code(f).matchAll(/(?:import|export)[^"';]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const s of specs) {
      expect(s.startsWith("./")).toBe(true);
      expect(files).toContain(s.slice(2));
    }
    expect(code(f)).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  }
});

test("PURE: no clock, randomness, network or runtime globals in src", () => {
  for (const f of files) {
    const c = code(f);
    for (const re of [/\bDate\b/, /Math\.random/, /\bfetch\b/, /\bBun\./, /\bprocess\./, /\bperformance\./, /\bcrypto\b/, /setTimeout|setInterval/, /\bconsole\./]) {
      expect({ file: f, hit: re.test(c) }).toEqual({ file: f, hit: false });
    }
  }
});

test("PURE: package has no runtime dependencies", () => {
  expect("dependencies" in pkg).toBe(false);
  expect("peerDependencies" in pkg).toBe(false);
});

test("PURE: repeated calls give byte-identical output (no hidden state)", async () => {
  const mod = await import("../src/index.ts");
  const a = JSON.stringify([mod.displayHours(1260), mod.jcs({ b: 1, a: 2 }), mod.localDay(1_790_000_000_000, "Europe/Berlin")]);
  const b = JSON.stringify([mod.displayHours(1260), mod.jcs({ b: 1, a: 2 }), mod.localDay(1_790_000_000_000, "Europe/Berlin")]);
  expect(a).toBe(b);
});
