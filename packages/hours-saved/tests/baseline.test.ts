import { expect, test } from "bun:test";
import { baseline, gradeFor, HoursSavedInputError, median, nearestRank } from "../src/index.ts";
import { estimate, prng, sample, shuffle, WF } from "./helpers.ts";

const W = WF(1);

test("MEDIAN: odd n takes the middle value", () => {
  const b = baseline([sample(W, 1, [300, 100, 200])]);
  expect(b.n).toBe(3);
  expect(b.median).toBe(200);
});

test("MEDIAN: even n takes the floor of the mean of the two middle values", () => {
  expect(baseline([sample(W, 1, [100, 201, 400, 50])]).median).toBe(150); // (100 + 201) / 2 = 150.5 → 150
  expect(baseline([sample(W, 1, [100, 200])]).median).toBe(150);
  expect(baseline([sample(W, 1, [1, 2])]).median).toBe(1);
});

test("MEDIAN: n = 1 gives that value for median, q1 and q3", () => {
  const b = baseline([sample(W, 1, [437])]);
  expect([b.n, b.median, b.q1, b.q3, b.iqr]).toEqual([1, 437, 437, 437, 0]);
});

test("MEDIAN: duplicates by instanceRef across devices are removed", () => {
  const dev1 = sample(W, 1, [100, 200, 300], { refs: [1, 2, 3] });
  const dev2 = sample(W, 1, [200, 300, 900], { refs: [2, 3, 4] });
  const b = baseline([dev1, dev2]);
  expect(b.n).toBe(4); // refs 1, 2, 3, 4
  expect(b.median).toBe(250);
  expect(b.samples.map((s) => s.activeSeconds)).toEqual([100, 200, 300, 900]);
});

test("MEDIAN: equal durations with distinct refs are kept (multiset, not set)", () => {
  const b = baseline([sample(W, 1, [60, 60, 60, 60])]);
  expect(b.n).toBe(4);
  expect(b.median).toBe(60);
});

test("MEDIAN: conflicting seconds for one ref keep the smaller, whatever the order", () => {
  const a = sample(W, 1, [500], { refs: [7] });
  const c = sample(W, 1, [450], { refs: [7] });
  expect(baseline([a, c]).median).toBe(450);
  expect(baseline([c, a]).median).toBe(450);
});

test("MEDIAN: nearest-rank quartiles d[ceil(p·n) − 1]", () => {
  const d = [10, 20, 30, 40, 50, 60, 70, 80];
  expect(nearestRank(d, 1, 4)).toBe(20); // ceil(2) − 1 = 1
  expect(nearestRank(d, 3, 4)).toBe(60); // ceil(6) − 1 = 5
  const e = [10, 20, 30, 40, 50];
  expect(nearestRank(e, 1, 4)).toBe(20); // ceil(1.25) − 1 = 1
  expect(nearestRank(e, 3, 4)).toBe(40); // ceil(3.75) − 1 = 3
  expect(nearestRank([5, 9], 1, 4)).toBe(5);
  expect(nearestRank([5, 9], 3, 4)).toBe(9);
});

test("MEDIAN: median() and nearestRank() reject an empty multiset", () => {
  expect(() => median([])).toThrow(HoursSavedInputError);
  expect(() => nearestRank([], 1, 4)).toThrow(HoursSavedInputError);
});

test("MEDIAN: shuffle invariance over 200 random multisets", () => {
  const rand = prng(42);
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(rand() * 40);
    const secs = Array.from({ length: n }, () => Math.floor(rand() * 5000));
    const ordered = baseline([sample(W, 1, secs, { refStart: 1 })]);
    const pairs = secs.map((s, i) => ({ s, r: i + 1 }));
    const sh = shuffle(pairs, rand);
    const mixed = baseline([sample(W, 1, sh.map((p) => p.s), { refs: sh.map((p) => p.r) })]);
    expect({ ...mixed, inputsDigest: "" }).toEqual({ ...ordered, inputsDigest: "" });
  }
});

test("MEDIAN: results are integers for random inputs", () => {
  const rand = prng(7);
  for (let k = 0; k < 100; k++) {
    const secs = Array.from({ length: 2 + Math.floor(rand() * 20) }, () => Math.floor(rand() * 10_000));
    const b = baseline([sample(W, 1, secs)]);
    for (const v of [b.median, b.q1, b.q3, b.iqr]) expect(Number.isInteger(v)).toBe(true);
    expect(b.q1 <= b.median && b.median <= b.q3).toBe(true);
  }
});

test("MEDIAN: non-integer or negative seconds are rejected", () => {
  expect(() => baseline([sample(W, 1, [1.5])])).toThrow(HoursSavedInputError);
  expect(() => baseline([sample(W, 1, [-1])])).toThrow(HoursSavedInputError);
});

test("MEDIAN: samples of different versions cannot be mixed", () => {
  expect(() => baseline([sample(W, 1, [1]), sample(W, 2, [1])])).toThrow(HoursSavedInputError);
});

test("GRADE: A boundary, n = 5 and 2·iqr = median is A", () => {
  // sorted 100 300 400 500 500: median d[2] = 400, q1 = d[ceil(1.25) − 1] = d[1] = 300, q3 = d[ceil(3.75) − 1] = d[3] = 500
  const b = baseline([sample(W, 1, [500, 100, 400, 300, 500])]);
  expect([b.n, b.median, b.q1, b.q3, b.iqr]).toEqual([5, 400, 300, 500, 200]);
  expect(2 * b.iqr).toBe(b.median);
  expect(b.grade).toBe("A");
});

test("GRADE: one second more of spread at the A boundary is B", () => {
  // q1 one second lower: iqr 201, 2·iqr = 402 > 400
  const lower = baseline([sample(W, 1, [500, 100, 400, 299, 500])]);
  expect([lower.median, lower.iqr, lower.grade]).toEqual([400, 201, "B"]);
  // q3 one second higher: sorted 100 300 400 501 501
  const higher = baseline([sample(W, 1, [501, 100, 400, 300, 501])]);
  expect([higher.median, higher.iqr, higher.grade]).toEqual([400, 201, "B"]);
});

test("GRADE: n = 4 at the same spread is B (n ≥ 5 required)", () => {
  // sorted 300 400 500 500: median 450, q1 300, q3 500, iqr 200, 2·iqr = 400 ≤ 450 but n = 4
  const b = baseline([sample(W, 1, [300, 400, 500, 500])]);
  expect([b.median, b.iqr, b.grade]).toEqual([450, 200, "B"]);
});

test("GRADE: n = 4 with zero spread is B (too few instances)", () => {
  expect(baseline([sample(W, 1, [300, 300, 300, 300])]).grade).toBe("B");
});

test("GRADE: n = 5 with a tight spread is A", () => {
  expect(baseline([sample(W, 1, [300, 300, 300, 300, 300])]).grade).toBe("A");
});

test("GRADE: wide spread with many instances is B", () => {
  const b = baseline([sample(W, 1, [60, 120, 600, 900, 1200, 3000, 4000, 5000])]);
  expect(b.source).toBe("observed");
  expect(b.grade).toBe("B");
});

test("GRADE: C for a user estimate when nothing was observed", () => {
  const b = baseline([], estimate(W, 1, 420));
  expect([b.source, b.n, b.median, b.grade]).toEqual(["user_estimate", 0, 420, "C"]);
});

test("GRADE: observed samples beat a user estimate", () => {
  const b = baseline([sample(W, 1, [100])], estimate(W, 1, 999));
  expect([b.source, b.median, b.grade]).toEqual(["observed", 100, "B"]);
});

test("GRADE: default (no samples, no estimate) has no baseline and no grade", () => {
  const b = baseline([]);
  expect([b.source, b.n, b.median, b.grade]).toEqual(["default", 0, 0, null]);
});

test("GRADE: gradeFor is the ADR formula without division", () => {
  expect(gradeFor("observed", 5, 0, 0)).toBe("A");
  expect(gradeFor("observed", 5, 1, 1)).toBe("B");
  expect(gradeFor("observed", 100, 50, 100)).toBe("A");
  expect(gradeFor("user_estimate", 0, 0, 10)).toBe("C");
  expect(gradeFor("default", 0, 0, 0)).toBeNull();
});

test("GRADE: baseline carries computation and an order-independent inputs digest", () => {
  const s1 = sample(W, 1, [10, 20], { id: "01JC0000000000000000000001" });
  const s2 = sample(W, 1, [30], { id: "01JC0000000000000000000002", refStart: 50 });
  const a = baseline([s1, s2]);
  const b = baseline([s2, s1]);
  expect(a.computation).toBe("hs-1");
  expect(a.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(a.inputsDigest).toBe(b.inputsDigest);
  expect(baseline([s1]).inputsDigest).not.toBe(a.inputsDigest);
});
