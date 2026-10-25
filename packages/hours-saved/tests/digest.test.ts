import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { anomalies, baseline, buildRows, inputsDigest, jcs, sha256OfString } from "../src/index.ts";
import { attributed, DEPT, PERSON, prng, review, ROLE, run, sample, shuffle, WF } from "./helpers.ts";

const nodeSha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

test("PURE: sha256 known answers (FIPS 180-4 vectors)", () => {
  expect(sha256OfString("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256OfString("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256OfString("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("PURE: sha256 matches node:crypto on random strings incl. non-ASCII and block edges", () => {
  const rand = prng(17);
  const alphabet = "aZ09 é€😀\n\"\\";
  for (let len = 0; len < 140; len++) {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
    expect(sha256OfString(s)).toBe(nodeSha(s));
  }
});

test("PURE: JCS sorts keys, drops whitespace and is stable", () => {
  expect(jcs({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  expect(jcs({ "é": 1, e: 2, E: 3 })).toBe('{"E":3,"e":2,"é":1}');
  expect(() => jcs({ x: Number.NaN })).toThrow();
});

test("PURE: inputsDigest sorts rows by id so order never matters", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}`, v: i * 7 }));
  const want = inputsDigest(rows);
  expect(want).toBe(nodeSha(jcs(rows)));
  const rand = prng(23);
  for (let k = 0; k < 20; k++) expect(inputsDigest(shuffle(rows, rand))).toBe(want);
  expect(inputsDigest([...rows.slice(1), { id: "r000", v: 1 }])).not.toBe(want);
});

test("PURE: anomalies flag residual 0 on more than 90% of a person's month", () => {
  const W = WF(1);
  const b = baseline([sample(W, 1, [100, 100, 100])]);
  const runs = Array.from({ length: 10 }, (_, i) => run({ n: i, workflowId: W, endedAt: Date.UTC(2026, 9, 1 + i) }));
  const zeros = runs.map((r) => review(r, {}));
  const flagged = anomalies(buildRows(runs.map((r) => attributed(r, PERSON(1), DEPT(1), ROLE(1))), zeros, [{ workflowId: W, version: 1, baseline: b }]), "UTC");
  expect(flagged.map((a) => a.code)).toEqual(["residual_zero_share"]);
  expect(flagged[0]!.workflowId).toBeNull();
  // exactly 90% (9 of 10) is not more than 90%
  const nine = [...zeros.slice(0, 9), review(runs[9]!, { review: 5 })];
  expect(anomalies(buildRows(runs.map((r) => attributed(r, PERSON(1), DEPT(1), ROLE(1))), nine, [{ workflowId: W, version: 1, baseline: b }]), "UTC")).toEqual([]);
});

test("PURE: anomalies flag small baselines and outcome disagreement", () => {
  const W1 = WF(1), W2 = WF(2);
  const r1 = run({ n: 1, workflowId: W1 });
  const r2 = run({ n: 2, workflowId: W2 });
  const rows = buildRows(
    [attributed(r1, PERSON(1), null, null), attributed(r2, PERSON(2), null, null, "failed")],
    [review(r1, { review: 9 }), review(r2, { review: 9 })],
    [
      { workflowId: W1, version: 1, baseline: baseline([sample(W1, 1, [10, 20])]) },
      { workflowId: W2, version: 1, baseline: baseline([sample(W2, 1, [1, 2, 3])]) },
    ],
  );
  expect(anomalies(rows, "UTC").map((a) => [a.code, a.workflowId])).toEqual([
    ["outcome_disagreement", W2],
    ["small_baseline", W1],
  ]);
});
