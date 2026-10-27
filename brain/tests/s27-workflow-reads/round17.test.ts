// s27 review round 17 (PR #35): the dry run fills a past instance only from the source row that matches it on the
// recorded evidence (the values the person then typed on the commit screen). Exactly one matching row -> filled; none
// or several -> left unfilled, said plainly, and not counted toward savings. Never "the first row".
import { describe, expect, test } from "bun:test";
import { fillFromSource } from "../../src/plan/read-source.ts";
import { producesNothing } from "../../src/plan/dryrun.ts";
import type { ReadSourceDTO } from "../../src/api/s14-types.ts";

const SRC = {
  targetName: "PostHog",
  fields: [
    { label: "Week", sourceLabel: "Week", support: 3 },
    { label: "Signups", sourceLabel: "Signups", support: 3 },
  ],
} as unknown as ReadSourceDTO;
const O = { outputType: "rows" as const, verb: "update", object: "row" };
const SOURCE_TABLE = "Week | Signups\n41 | 340\n42 | 350";
const commit = (week: string, signups: string) => [`Week | Signups\n${week} | ${signups}`];

describe("s27 round 17: a past instance is filled from its own source row", () => {
  test("DRYRUN: the source shows weeks 41 and 42, the person typed week 42: week 42 is filled", () => {
    const b = fillFromSource(SRC, SOURCE_TABLE, commit("42", "350"), O);
    expect(b.ours.fields).toEqual([{ label: "Week", value: "42" }, { label: "Signups", value: "350" }]);
    expect(b.match.matched).toBe(2);
    expect(producesNothing("rows", b.ours)).toBe(false);
  });
  test("DRYRUN: the person typed week 41: week 41 is filled (never simply the first row)", () => {
    const b = fillFromSource(SRC, "Week | Signups\n42 | 350\n41 | 340", commit("41", "340"), O);
    expect(b.ours.fields).toEqual([{ label: "Week", value: "41" }, { label: "Signups", value: "340" }]);
  });
  test("DRYRUN: no source row matches what was typed: unfilled, said plainly, no saving", () => {
    const b = fillFromSource(SRC, SOURCE_TABLE, commit("43", "360"), O);
    expect(b.ours.fields.every((f) => f.value === null)).toBe(true);
    expect(b.warnings.join(" ")).toMatch(/could not match the source row/);
    expect(b.commit).toBeNull();
    expect(producesNothing("rows", b.ours)).toBe(true);
  });
  test("DRYRUN: two source rows match equally: unfilled (ambiguous), no saving", () => {
    const b = fillFromSource(SRC, "Week | Signups\n42 | 350\n42 | 350", commit("42", "350"), O);
    expect(b.ours.fields.every((f) => f.value === null)).toBe(true);
    expect(b.warnings.join(" ")).toMatch(/could not match the source row/);
  });
  test("DRYRUN: nothing recorded on the commit screen: no evidence, unfilled, no saving", () => {
    const b = fillFromSource(SRC, "Week 42\nSignups 350", [], O);
    expect(b.ours.fields.every((f) => f.value === null)).toBe(true);
    expect(producesNothing("rows", b.ours)).toBe(true);
  });
  test("DRYRUN: the commit screen shows several typed rows: the one source row matching any of them is filled", () => {
    const b = fillFromSource(SRC, "Week | Signups\n42 | 350", ["Week | Signups\n40 | 330\n42 | 350"], O);
    expect(b.ours.fields).toEqual([{ label: "Week", value: "42" }, { label: "Signups", value: "350" }]);
  });
});
