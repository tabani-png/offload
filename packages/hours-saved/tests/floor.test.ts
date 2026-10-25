import { expect, test } from "bun:test";
import { HoursSavedInputError, isSuppressed, suppress, type Cell, type CellTree } from "../src/index.ts";
import { DEPT, prng } from "./helpers.ts";

function cell(people: number, seconds = people * 1000): Cell {
  return {
    seconds,
    hours: 0,
    byGrade: { A: seconds, B: 0, C: 0 },
    bySource: { observed: seconds, user_estimate: 0 },
    byRuntime: { mac: seconds, cloud: 0 },
    overnightSeconds: 0,
    runs: { success: people, failed: 0, cancelled: 0, rejected: 0, capped: 0 },
    people,
  };
}
const node = (label: string, value: Cell, children: CellTree[] = [], n = 0): CellTree => ({
  scope: { type: "department", id: DEPT(n) },
  label,
  value,
  children,
});
const root = (children: CellTree[], people = 100): CellTree => ({ scope: { type: "company", id: null }, label: "total", value: cell(people), children });

const NUMERIC_KEYS = ["seconds", "hours", "byGrade", "bySource", "byRuntime", "overnightSeconds", "runs", "people"];
function hasNoNumbers(v: unknown): boolean {
  if (typeof v === "number") return false;
  if (typeof v !== "object" || v === null) return true;
  return Object.entries(v).every(([k, x]) => !NUMERIC_KEYS.includes(k) && hasNoNumbers(x));
}

test("FLOOR: 4 people is suppressed", () => {
  const t = suppress(node("x", cell(4)));
  expect(t.value).toEqual({ suppressed: true, reason: "group_floor" });
});

test("FLOOR: 5 people is shown", () => {
  const t = suppress(node("x", cell(5)));
  expect(t.value).toEqual(cell(5));
});

test("FLOOR: complementary suppression when exactly one sibling is suppressed", () => {
  const t = suppress(root([node("a", cell(4), [], 1), node("b", cell(9), [], 2), node("c", cell(6), [], 3)]));
  expect(t.children.map((c) => isSuppressed(c.value))).toEqual([true, false, true]); // c (6) is the smallest other
  expect(isSuppressed(t.value)).toBe(false);
});

test("FLOOR: two suppressed siblings need no complement", () => {
  const t = suppress(root([node("a", cell(4), [], 1), node("b", cell(2), [], 2), node("c", cell(6), [], 3)]));
  expect(t.children.map((c) => isSuppressed(c.value))).toEqual([true, true, false]);
});

test("FLOOR: no suppression when every child meets the floor", () => {
  const t = suppress(root([node("a", cell(5), [], 1), node("b", cell(5), [], 2)]));
  expect(t.children.every((c) => !isSuppressed(c.value))).toBe(true);
});

test("FLOOR: complement tie on people breaks by seconds, then label", () => {
  const t = suppress(root([node("a", cell(3), [], 1), node("b", cell(7, 900), [], 2), node("c", cell(7, 800), [], 3)]));
  expect(t.children.map((c) => isSuppressed(c.value))).toEqual([true, false, true]);
  const u = suppress(root([node("a", cell(3), [], 1), node("z", cell(7, 800), [], 2), node("m", cell(7, 800), [], 3)]));
  expect(u.children.map((c) => isSuppressed(c.value))).toEqual([true, false, true]); // "m" < "z"
});

test("FLOOR: complement choice does not depend on child order", () => {
  const kids = [node("a", cell(2), [], 1), node("b", cell(11), [], 2), node("c", cell(8), [], 3), node("d", cell(20), [], 4)];
  const rand = prng(5);
  for (let k = 0; k < 20; k++) {
    const order = [...kids].sort(() => rand() - 0.5);
    const t = suppress(root(order));
    const hidden = t.children.filter((c) => isSuppressed(c.value)).map((c) => c.label).sort();
    expect(hidden).toEqual(["a", "c"]);
  }
});

test("FLOOR: the only child under the floor with no sibling stays the only suppressed cell", () => {
  const t = suppress(root([node("a", cell(3), [], 1)], 12));
  expect(isSuppressed(t.children[0]!.value)).toBe(true);
  expect(isSuppressed(t.value)).toBe(false);
});

test("FLOOR: a suppressed parent suppresses its whole subtree", () => {
  const t = suppress(root([node("a", cell(4), [node("a1", cell(4), [], 5)], 1), node("b", cell(30), [], 2)]));
  expect(isSuppressed(t.children[0]!.children[0]!.value)).toBe(true);
});

test("FLOOR: a complement-suppressed cell hides its children so they cannot rebuild it", () => {
  const t = suppress(root([node("a", cell(2), [], 1), node("b", cell(10), [node("b1", cell(5), [], 6), node("b2", cell(5), [], 7)], 2), node("c", cell(40), [], 3)]));
  const b = t.children[1]!;
  expect(isSuppressed(b.value)).toBe(true);
  expect(b.children.every((c) => isSuppressed(c.value))).toBe(true);
});

test("FLOOR: rules apply recursively below a visible parent", () => {
  const t = suppress(root([node("a", cell(20), [node("a1", cell(3), [], 5), node("a2", cell(17), [], 6)], 1), node("b", cell(30), [], 2)]));
  expect(isSuppressed(t.children[0]!.value)).toBe(false);
  expect(t.children[0]!.children.map((c) => isSuppressed(c.value))).toEqual([true, true]);
});

test("FLOOR: no numeric field present in a suppressed cell", () => {
  const t = suppress(root([node("a", cell(1), [], 1), node("b", cell(6), [], 2)], 3));
  const all: CellTree[] = [];
  const walk = (n: CellTree): void => {
    all.push(n);
    n.children.forEach(walk);
  };
  walk(t);
  const hidden = all.filter((n) => isSuppressed(n.value));
  expect(hidden.length).toBe(3);
  for (const h of hidden) {
    expect(Object.keys(h.value).sort()).toEqual(["reason", "suppressed"]);
    expect(hasNoNumbers(h.value)).toBe(true);
    expect(JSON.stringify(h.value)).not.toMatch(/[0-9]/);
  }
});

test("FLOOR: a root under the floor is suppressed with every child", () => {
  const t = suppress(root([node("a", cell(2), [], 1), node("b", cell(2), [], 2)], 4));
  expect(isSuppressed(t.value)).toBe(true);
  expect(t.children.every((c) => isSuppressed(c.value))).toBe(true);
});

test("FLOOR: person-scoped roots (self-view) are not floored", () => {
  const t = suppress({ scope: { type: "person", id: DEPT(1) }, label: "me", value: cell(1), children: [] });
  expect(isSuppressed(t.value)).toBe(false);
});

test("FLOOR: the floor is configurable upward only", () => {
  expect(isSuppressed(suppress(node("x", cell(7)), 8).value)).toBe(true);
  expect(isSuppressed(suppress(node("x", cell(8)), 8).value)).toBe(false);
  expect(() => suppress(node("x", cell(7)), 4)).toThrow(HoursSavedInputError);
  expect(() => suppress(node("x", cell(7)), 5.5)).toThrow(HoursSavedInputError);
});

test("FLOOR: suppress does not mutate its input", () => {
  const t = root([node("a", cell(1), [], 1), node("b", cell(9), [], 2)]);
  const before = JSON.stringify(t);
  suppress(t);
  expect(JSON.stringify(t)).toBe(before);
});
