import { expect, test } from "bun:test";
import { baseline, HoursSavedInputError, savedForRun, type RunOutcomeKind } from "../src/index.ts";
import { estimate, prng, review, run, sample, shuffle, WF } from "./helpers.ts";

const W = WF(1);
const B300 = baseline([sample(W, 1, [300])]); // observed, median 300 s per item

test("RUN: success with a review saves baseline × items − residual", () => {
  const r = run({ n: 1, workflowId: W, sent: 4 });
  const s = savedForRun(r, B300, [review(r, { review: 100, edit: 50, fix: 30 })]);
  expect(s).toMatchObject({ saved: 1200 - 180, residual: 180, note: null, baselineSeconds: 300, itemsSucceeded: 4 });
});

test("RUN: only success counts; every other outcome saves 0", () => {
  for (const outcome of ["failed", "cancelled", "rejected", "capped"] as RunOutcomeKind[]) {
    const r = run({ n: 2, workflowId: W, sent: 3, outcome });
    const s = savedForRun(r, B300, [review(r, { review: 10 })]);
    expect(s.saved).toBe(0);
    expect(s.note).toBeNull();
  }
});

test("RUN: items multiplier uses items sent, not items total", () => {
  const base = run({ n: 3, workflowId: W, sent: 5 });
  const r = { ...base, items: { total: 9, sent: 5, failedBeforeSend: 2, unknown: 1, pending: 1 } };
  expect(savedForRun(r, B300, [review(r, {})]).saved).toBe(1500);
});

test("RUN: zero items sent on a success saves 0", () => {
  const r = run({ n: 4, workflowId: W, sent: 0 });
  expect(savedForRun(r, B300, [review(r, { review: 0 })]).saved).toBe(0);
});

test("RUN: residual subtraction sums review, edit and fix over all events of the run", () => {
  const r = run({ n: 5, workflowId: W, sent: 10 });
  const evs = [review(r, { review: 120 }), review(r, { fix: 300 }, { surface: "mac_fixup" }), review(r, { edit: 80 }, { surface: "web_digest" })];
  expect(savedForRun(r, B300, evs)).toMatchObject({ saved: 3000 - 500, residual: 500 });
});

test("RUN: max(0, …) when the residual exceeds the baseline", () => {
  const r = run({ n: 6, workflowId: W, sent: 1 });
  expect(savedForRun(r, B300, [review(r, { review: 200, edit: 200 })])).toMatchObject({ saved: 0, residual: 400, note: null });
});

test("RUN: missing review counts 0 and is noted not_reviewed_yet", () => {
  const r = run({ n: 7, workflowId: W, sent: 8 });
  expect(savedForRun(r, B300, [])).toMatchObject({ saved: 0, residual: null, note: "not_reviewed_yet" });
});

test("RUN: review events of other runs are ignored", () => {
  const r = run({ n: 8, workflowId: W, sent: 2 });
  const other = run({ n: 9, workflowId: W, sent: 2 });
  expect(savedForRun(r, B300, [review(other, { review: 50 })]).note).toBe("not_reviewed_yet");
});

test("RUN: duplicate review events (same id, resent by sync) count once", () => {
  const r = run({ n: 10, workflowId: W, sent: 2 });
  const ev = review(r, { review: 100 });
  expect(savedForRun(r, B300, [ev, ev, ev]).residual).toBe(100);
});

test("RUN: policy-committed residual from digest seconds", () => {
  const r = run({ n: 11, workflowId: W, sent: 6, policy: true, overnight: true, runtime: "cloud" });
  const digest = review(r, { review: 45 }, { surface: "web_digest", decision: "approved" });
  expect(savedForRun(r, B300, [digest])).toMatchObject({ saved: 1800 - 45, residual: 45, note: "policy_committed" });
});

test("RUN: policy-committed run the digest showed but nobody opened has residual 0", () => {
  const r = run({ n: 12, workflowId: W, sent: 6, policy: true });
  expect(savedForRun(r, B300, [])).toMatchObject({ saved: 1800, residual: 0, note: "policy_committed" });
});

test("RUN: a broker policy_committed review event marks the run policy committed", () => {
  const r = { ...run({ n: 13, workflowId: W, sent: 2 }), approverKind: null };
  const ev = review(r, {}, { surface: "broker", decision: "policy_committed" });
  expect(savedForRun(r, B300, [ev])).toMatchObject({ saved: 600, residual: 0, note: "policy_committed" });
});

test("RUN: user-estimate baseline is used per item", () => {
  const r = run({ n: 14, workflowId: W, sent: 3 });
  const b = baseline([], estimate(W, 1, 420));
  expect(savedForRun(r, b, [review(r, { review: 60 })]).saved).toBe(1260 - 60);
});

test("RUN: default baseline (no baseline) contributes 0", () => {
  const r = run({ n: 15, workflowId: W, sent: 3 });
  expect(savedForRun(r, baseline([]), [review(r, { review: 60 })]).saved).toBe(0);
});

test("RUN: results are integers and carry computation and a digest", () => {
  const r = run({ n: 16, workflowId: W, sent: 3 });
  const s = savedForRun(r, B300, [review(r, { review: 7 })]);
  expect(Number.isInteger(s.saved)).toBe(true);
  expect(s.computation).toBe("hs-1");
  expect(s.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
});

test("RUN: digest and result are independent of review order (shuffle invariance)", () => {
  const rand = prng(3);
  const r = run({ n: 17, workflowId: W, sent: 9 });
  const evs = Array.from({ length: 6 }, (_, i) => review(r, { review: i * 11, fix: i }));
  const first = savedForRun(r, B300, evs);
  for (let k = 0; k < 20; k++) expect(savedForRun(r, B300, shuffle(evs, rand))).toEqual(first);
});

test("RUN: digest changes when the residual changes", () => {
  const r = run({ n: 18, workflowId: W, sent: 2 });
  const a = savedForRun(r, B300, [review(r, { review: 1 }, { id: "01JC0000000000000000000777" })]);
  const b = savedForRun(r, B300, [review(r, { review: 2 }, { id: "01JC0000000000000000000777" })]);
  expect(a.inputsDigest).not.toBe(b.inputsDigest);
});

test("RUN: non-integer review seconds are rejected", () => {
  const r = run({ n: 19, workflowId: W, sent: 2 });
  expect(() => savedForRun(r, B300, [review(r, { review: 1.5 })])).toThrow(HoursSavedInputError);
});
