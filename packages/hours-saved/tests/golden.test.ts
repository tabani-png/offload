import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evidence, recompute, report, type ReportInput } from "../src/index.ts";
import { apInvoices, outreach, recruiting } from "./fixtures/golden.ts";
import { prng, shuffle, validateAgainst, WF } from "./helpers.ts";

const FIX = join(import.meta.dir, "fixtures");
const expected = (name: string): string => readFileSync(join(FIX, `${name}.expected.json`), "utf8");
const bytes = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

const CASES: [string, () => ReportInput][] = [
  ["outreach", outreach],
  ["ap-invoices", apInvoices],
  ["recruiting", recruiting],
];

function shuffled(input: ReportInput, seed: number): ReportInput {
  const rand = prng(seed);
  return {
    ...input,
    runs: shuffle(input.runs, rand),
    reviews: shuffle(input.reviews, rand),
    samples: shuffle(input.samples, rand),
    estimates: shuffle(input.estimates, rand),
    workflows: shuffle(input.workflows, rand),
  };
}

for (const [name, make] of CASES) {
  test(`GOLDEN: ${name} report equals the hand-computed expected JSON byte for byte`, () => {
    expect(bytes(report(make()))).toBe(expected(`${name}.report`));
  });

  test(`GOLDEN: ${name} output is byte-identical across runs and input orders`, () => {
    const first = bytes(report(make()));
    for (let k = 0; k < 10; k++) expect(bytes(report(shuffled(make(), 1000 + k)))).toBe(first);
  });

  test(`GOLDEN: ${name} numbers ignore instance order inside a sample (the digest covers rows as stored)`, () => {
    const input = make();
    const rand = prng(5);
    const inner = { ...input, samples: input.samples.map((s) => ({ ...s, instances: shuffle(s.instances, rand) })) };
    expect({ ...report(inner), inputsDigest: "" }).toEqual({ ...report(input), inputsDigest: "" });
  });

  test(`GOLDEN: ${name} recomputes exactly and detects a tampered total`, () => {
    const input = make();
    const stored = JSON.parse(bytes(report(input)));
    expect(recompute(stored, shuffled(input, 77))).toBe(true);
    expect(recompute({ ...stored, final: true }, input)).toBe(true);
    const tampered = JSON.parse(JSON.stringify(stored));
    if (tampered.total.seconds !== undefined) tampered.total.seconds += 1;
    else tampered.inputsDigest = "0".repeat(64);
    expect(recompute(tampered, input)).toBe(false);
  });

  test(`GOLDEN: ${name} report validates against hours-saved-report.schema.json`, () => {
    expect(validateAgainst("hours-saved-report.schema.json", report(make()))).toEqual([]);
  });
}

test("GOLDEN: outreach evidence equals the hand-computed expected JSON", () => {
  const input = outreach();
  const ev = evidence({ ...input, workflowId: WF(101), version: 1 });
  expect(bytes(ev)).toBe(expected("outreach.evidence"));
  expect(validateAgainst("hours-saved-evidence.schema.json", ev)).toEqual([]);
});

test("GOLDEN: a changed input row changes the inputs digest", () => {
  const input = outreach();
  const a = report(input).inputsDigest;
  const first = input.reviews[0]!;
  const b = report({ ...input, reviews: [{ ...first, reviewSeconds: first.reviewSeconds + 1 }, ...input.reviews.slice(1)] }).inputsDigest;
  expect(a).not.toBe(b);
});

test("GOLDEN: evidence for a workflow with no baseline is the default baseline", () => {
  const ev = evidence({ ...outreach(), workflowId: WF(999), version: 1 });
  expect(ev.baseline).toEqual({ source: "default", n: 0, medianSeconds: 0, q1: 0, q3: 0, grade: null, samples: [] });
  expect(ev.runs).toEqual([]);
  expect(validateAgainst("hours-saved-evidence.schema.json", ev)).toEqual([]);
});
