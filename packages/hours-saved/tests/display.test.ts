import { expect, test } from "bun:test";
import { displayHours, HoursSavedInputError } from "../src/index.ts";
import { prng } from "./helpers.ts";

test("DISPLAY: 180 s = 0.05 h rounds half to even → 0.0", () => {
  expect(displayHours(180)).toBe(0);
});

test("DISPLAY: 540 s = 0.15 h → 0.2", () => {
  expect(displayHours(540)).toBe(0.2);
});

test("DISPLAY: 900 s = 0.25 h → 0.2", () => {
  expect(displayHours(900)).toBe(0.2);
});

test("DISPLAY: 1260 s = 0.35 h → 0.4", () => {
  expect(displayHours(1260)).toBe(0.4);
});

test("DISPLAY: just off the half rounds to nearest", () => {
  expect(displayHours(179)).toBe(0);
  expect(displayHours(181)).toBe(0.1);
  expect(displayHours(899)).toBe(0.2);
  expect(displayHours(901)).toBe(0.3);
  expect(displayHours(0)).toBe(0);
  expect(displayHours(3600)).toBe(1);
});

test("DISPLAY: large sums stay exact", () => {
  expect(displayHours(3600 * 1_000_000)).toBe(1_000_000);
  expect(displayHours(3600 * 1_000_000 + 180)).toBe(1_000_000); // …00.05 → even
  expect(displayHours(3600 * 1_000_000 + 540)).toBe(1_000_000.2); // …00.15 → .2
  expect(displayHours(Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % 360))).toBe(
    (Number.MAX_SAFE_INTEGER - (Number.MAX_SAFE_INTEGER % 360)) / 360 / 10,
  );
});

test("DISPLAY: matches an independent BigInt round-half-even reference", () => {
  const rand = prng(1);
  for (let k = 0; k < 2000; k++) {
    const s = Math.floor(rand() * 50_000_000);
    const q = BigInt(s) / 360n;
    const r = BigInt(s) % 360n;
    const t = 2n * r > 360n || (2n * r === 360n && q % 2n === 1n) ? q + 1n : q;
    expect(displayHours(s)).toBe(Number(t) / 10);
  }
});

test("DISPLAY: rejects fractions and negatives", () => {
  expect(() => displayHours(1.5)).toThrow(HoursSavedInputError);
  expect(() => displayHours(-360)).toThrow(HoursSavedInputError);
});
