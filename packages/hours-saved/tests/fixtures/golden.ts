// Three hand-computed golden scenarios. The arithmetic for every expected number is written next to the input that
// produces it; tests/fixtures/<name>.expected.json holds the committed output (inputsDigest is the one machine value:
// sha256 is checked separately against FIPS vectors and node:crypto in digest.test.ts).

import type { ReportInput, ReviewEvent, RunInput } from "../../src/index.ts";
import { attributed, DEPT, estimate, PERSON, review, ROLE, run, sample, ulid, WF } from "../helpers.ts";

const at = (y: number, mo: number, d: number, h: number, mi = 0, s = 0): number => Date.UTC(y, mo - 1, d, h, mi, s);

// ------------------------------------------------------------------------------------------------- 1. outreach
// W1 "Outreach emails" v1. Samples: device 1 refs 1-6 = 240 300 260 280 250 270, device 2 resends ref 3 = 260.
// Distinct n = 6, sorted 240 250 260 270 280 300: median floor((260+270)/2) = 265, q1 = d[ceil(1.5)-1] = d[1] = 250,
// q3 = d[ceil(4.5)-1] = d[4] = 280, iqr 30, 2·30 = 60 ≤ 265 → A.
// R1 P1 10 sent, residual 300+120 = 420 → 2650 − 420 = 2230
// R2 P2  5 sent, residual 200+60  = 260 → 1325 − 260 = 1065
// R3 P3  4 sent, no review → 0 (not_reviewed_yet)
// R4 P4 failed → 0
// R5 P5  2 sent, residual 400+200 = 600 → max(0, 530 − 600) = 0
// R6 P1  8 sent, overnight policy commit on cloud, digest 45 s → 2120 − 45 = 2075 (policy_committed)
// R7 P2 ends 2026-11-01 00:30 EDT → outside October in New York.
// Total 2230 + 1065 + 2075 = 5370 s → 14.92 tenths → 1.5 h. cloud = overnight = 2075, mac = 3295. 5 people.
export function outreach(): ReportInput {
  const W1 = WF(101);
  const SALES = DEPT(1);
  const SDR = ROLE(1);
  const mk = (n: number, p: number, o: Partial<Parameters<typeof run>[0]>): RunInput =>
    attributed(run({ n, workflowId: W1, endedAt: at(2026, 10, 9 + n, 15), ...o }), PERSON(p), SALES, SDR);
  const runs = [
    mk(1, 1, { sent: 10 }),
    mk(2, 2, { sent: 5 }),
    mk(3, 3, { sent: 4 }),
    mk(4, 4, { sent: 0, outcome: "failed" }),
    mk(5, 5, { sent: 2 }),
    mk(6, 1, { sent: 8, policy: true, overnight: true, runtime: "cloud", endedAt: at(2026, 10, 15, 7) }),
    mk(7, 2, { sent: 3, endedAt: at(2026, 11, 1, 4, 30) }),
  ];
  const r = (i: number) => runs[i]!.run;
  const reviews: ReviewEvent[] = [
    review(r(0), { review: 300, edit: 120 }, { id: ulid(1101) }),
    review(r(1), { review: 200, fix: 60 }, { id: ulid(1102) }),
    review(r(4), { review: 400, edit: 200 }, { id: ulid(1105), decision: "approved_with_edits" }),
    review(r(5), { review: 45 }, { id: ulid(1106), surface: "web_digest" }),
    review(r(6), {}, { id: ulid(1107) }),
  ];
  return {
    runs,
    reviews,
    samples: [
      sample(W1, 1, [240, 300, 260, 280, 250, 270], { id: ulid(1001), refStart: 1 }),
      sample(W1, 1, [260], { id: ulid(1002), refs: [3] }),
    ],
    estimates: [],
    workflows: [{ id: W1, name: "Outreach emails", jobRoleId: SDR }],
    scope: { type: "company", id: null },
    children: [{ scope: { type: "department", id: SALES }, label: "Sales" }],
    period: { from: "2026-10-01", toExclusive: "2026-11-01" },
    timezone: "America/New_York",
  };
}

// ---------------------------------------------------------------------------------------------- 2. AP invoices
// Berlin, October 2026 (DST ends 2026-10-25 03:00 CEST → 02:00 CET).
// W2 "AP invoice entry" v2, observed 600 900 300 1200: sorted 300 600 900 1200, median floor((600+900)/2) = 750,
// q1 = d[0] = 300, q3 = d[2] = 900, iqr 600, n = 4 < 5 → B.
// W3 "Vendor statement match" v1, user estimate 420 s → C, n = 0 → small_baseline anomaly.
// Finance F1-F4 (W2):
//   A1 F1 3 sent, ends 2026-10-25 02:30 CET (repeated hour), residual 120+300 = 420 → 2250 − 420 = 1830
//   A2 F2 1 sent, residual 100+50 = 150 → 750 − 150 = 600
//   A3 F3 rejected → 0
//   A4 F4 2 sent, review 200 (sent twice, same id) + fix-up 300 = 500 → 1500 − 500 = 1000
//   A5 F1 ends 2026-09-30 23:30 CEST → outside
// Ops O1-O6 (W3): B1-B6 one each, 2 sent, residual 60 → 840 − 60 = 780 each = 4680 (B6 on cloud, 780)
//   B7 O1 capped → 0;  B8 O2 ends 2026-11-01 00:10 CET (still Oct 31 in UTC) → outside
// Total 1830 + 600 + 1000 + 4680 = 8110 s → 22.53 tenths → 2.3 h. B 3430, C 4680. cloud 780, mac 7330. 10 people.
// Children: Finance 4 people → suppressed; Ops is then the only other child → complementary suppression.
// topWorkflows: W3 (6 people) 4680 C; W2 has 4 people (< 5) → not listed.
export function apInvoices(): ReportInput {
  const W2 = WF(102);
  const W3 = WF(103);
  const FIN = DEPT(2);
  const OPS = DEPT(3);
  const AP = ROLE(2);
  const VS = ROLE(3);
  const a = (n: number, p: number, o: Partial<Parameters<typeof run>[0]>): RunInput =>
    attributed(run({ n, workflowId: W2, version: 2, endedAt: at(2026, 10, 6, 9), ...o }), PERSON(p), FIN, AP);
  const b = (n: number, p: number, o: Partial<Parameters<typeof run>[0]> = {}): RunInput =>
    attributed(run({ n, workflowId: W3, sent: 2, endedAt: at(2026, 10, 12 + (n % 10), 10), ...o }), PERSON(p), OPS, VS);
  const runs = [
    a(21, 11, { sent: 3, endedAt: at(2026, 10, 25, 1, 30) }),
    a(22, 12, { sent: 1 }),
    a(23, 13, { sent: 2, outcome: "rejected" }),
    a(24, 14, { sent: 2 }),
    a(25, 11, { sent: 1, endedAt: at(2026, 9, 30, 21, 30) }),
    b(31, 21),
    b(32, 22),
    b(33, 23),
    b(34, 24),
    b(35, 25),
    b(36, 26, { runtime: "cloud", endedAt: at(2026, 10, 31, 22, 30) }),
    b(37, 21, { outcome: "capped", sent: 0 }),
    b(38, 22, { sent: 5, endedAt: at(2026, 10, 31, 23, 10) }),
  ];
  const r = (i: number) => runs[i]!.run;
  const dup = review(r(3), { review: 200 }, { id: ulid(2104) });
  const reviews: ReviewEvent[] = [
    review(r(0), { review: 120, edit: 300 }, { id: ulid(2101), decision: "approved_with_edits" }),
    review(r(1), { review: 100, fix: 50 }, { id: ulid(2102) }),
    review(r(2), { review: 30 }, { id: ulid(2103), decision: "rejected" }),
    dup,
    dup,
    review(r(3), { fix: 300 }, { id: ulid(2114), surface: "mac_fixup" }),
    review(r(4), { review: 10 }, { id: ulid(2105) }),
    ...[5, 6, 7, 8, 9, 10].map((i) => review(r(i), { review: 60 }, { id: ulid(2200 + i) })),
    review(r(12), {}, { id: ulid(2212) }),
  ];
  return {
    runs,
    reviews,
    samples: [sample(W2, 2, [600, 900, 300, 1200], { id: ulid(2001), refStart: 100 })],
    estimates: [estimate(W3, 1, 420, 1)],
    workflows: [
      { id: W2, name: "AP invoice entry", jobRoleId: AP },
      { id: W3, name: "Vendor statement match", jobRoleId: VS },
    ],
    scope: { type: "company", id: null },
    children: [
      { scope: { type: "department", id: FIN }, label: "Finance" },
      { scope: { type: "department", id: OPS }, label: "Operations" },
    ],
    period: { from: "2026-10-01", toExclusive: "2026-11-01" },
    timezone: "Europe/Berlin",
  };
}

// ----------------------------------------------------------------------------------------------- 3. recruiting
// Los Angeles, 2026-11-01 only: the US fall-back day (25 hours, 07:00Z to 08:00Z next day). Scope: Recruiting dept.
// W4 "Candidate sourcing" v1 (job role Sourcer): 400 500 600 700 800 → median 600, q1 d[1] = 500, q3 d[3] = 700,
//   iqr 200, 400 ≤ 600, n = 5 → A.
// W5 "Interview scheduling" v1 (Coordinator): 300 360 → median 330, q1 300, q3 360 → B, n = 2 → small_baseline.
// W6 "Offer letters" v3 (Recruiting ops): 900 1000 1100 1200 1300 3000 → median floor((1100+1200)/2) = 1150,
//   q1 d[1] = 1000, q3 d[4] = 1300, iqr 300, 600 ≤ 1150 → A.
// W4: S1 R1 5 sent 01:30 PDT, residual 300 → 2700 | S2 R2 5 sent, residual 0 → 3000 | S3 R3 1 sent, 0 → 600
//     S4 R4 2 sent, no review → 0 | S5 R5 3 sent, 1000+800+500 = 2300 → max(0, 1800 − 2300) = 0
//     S6 R1 ends 2026-11-02 00:00 PST → outside | S7 R2 2 sent, 23:59:59 PST, cloud overnight, residual 0 → 1200
//     W4 = 7500
// W5: C1 R6 4 sent, residual 120 → 1320 − 120 = 1200 | C2 R7 cancelled → 0.  W5 = 1200
// W6: O1-O6 R1-R6 one each, residual 150 → 1000; O3 (R3) residual 0 → 1150; O6 device said failed, broker success.
//     W6 = 5·1000 + 1150 = 6150
// Total 7500 + 1200 + 6150 = 14850 s → 41.25 tenths → 4.1 h. A 13650, B 1200. cloud = overnight = 1200. 7 people.
// Children (job roles): Sourcer R1-R5 (5) 7500, Coordinator R6-R7 (2) suppressed, Recruiting ops R1-R6 (6) 6150.
//   Exactly one suppressed → the smallest other (Sourcer, 5 people) is suppressed too; Recruiting ops is shown:
//   6150 s → 17.08 tenths → 1.7 h, 6 successful runs, 6 people.
// topWorkflows: W4 7500 A (5 people), W6 6150 A (6 people); W5 has 2 people → not listed.
// Anomalies: outcome_disagreement W6 (1 run); residual_zero_share for R3 (S3 0, O3 0: 2 of 2); small_baseline W5.
//   R2 has 2 of 3 zero (S2, S7, O2 150) → 67%, not flagged.
export function recruiting(): ReportInput {
  const W4 = WF(104);
  const W5 = WF(105);
  const W6 = WF(106);
  const REC = DEPT(4);
  const SRC = ROLE(4);
  const CRD = ROLE(5);
  const OPS = ROLE(6);
  const mk = (wf: string, version: number, role: string) => (n: number, p: number, o: Partial<Parameters<typeof run>[0]>, device: "failed" | null = null): RunInput =>
    attributed(run({ n, workflowId: wf, version, endedAt: at(2026, 11, 1, 18), ...o }), PERSON(p), REC, role, device);
  const s = mk(W4, 1, SRC);
  const c = mk(W5, 1, CRD);
  const o = mk(W6, 3, OPS);
  const runs = [
    s(41, 31, { sent: 5, endedAt: at(2026, 11, 1, 8, 30) }),
    s(42, 32, { sent: 5 }),
    s(43, 33, { sent: 1 }),
    s(44, 34, { sent: 2 }),
    s(45, 35, { sent: 3 }),
    s(46, 31, { sent: 1, endedAt: at(2026, 11, 2, 8, 0) }),
    s(47, 32, { sent: 2, endedAt: at(2026, 11, 2, 7, 59, 59), runtime: "cloud", overnight: true }),
    c(51, 36, { sent: 4 }),
    c(52, 37, { sent: 1, outcome: "cancelled" }),
    o(61, 31, { sent: 1 }),
    o(62, 32, { sent: 1 }),
    o(63, 33, { sent: 1 }),
    o(64, 34, { sent: 1 }),
    o(65, 35, { sent: 1 }),
    o(66, 36, { sent: 1 }, "failed"),
  ];
  const r = (i: number) => runs[i]!.run;
  const reviews: ReviewEvent[] = [
    review(r(0), { review: 300 }, { id: ulid(3101) }),
    review(r(1), {}, { id: ulid(3102) }),
    review(r(2), {}, { id: ulid(3103) }),
    review(r(4), { review: 1000, edit: 800, fix: 500 }, { id: ulid(3105), decision: "approved_with_edits" }),
    review(r(5), {}, { id: ulid(3106) }),
    review(r(6), {}, { id: ulid(3107), surface: "web_digest" }),
    review(r(7), { review: 120 }, { id: ulid(3108) }),
    ...[9, 10, 12, 13, 14].map((i) => review(r(i), { review: 150 }, { id: ulid(3200 + i) })),
    review(r(11), {}, { id: ulid(3211) }),
  ];
  return {
    runs,
    reviews,
    samples: [
      sample(W4, 1, [400, 500, 600, 700, 800], { id: ulid(3001), refStart: 200 }),
      sample(W5, 1, [300, 360], { id: ulid(3002), refStart: 300 }),
      sample(W6, 3, [900, 1000, 1100, 1200, 1300, 3000], { id: ulid(3003), refStart: 400 }),
    ],
    estimates: [],
    workflows: [
      { id: W4, name: "Candidate sourcing", jobRoleId: SRC },
      { id: W5, name: "Interview scheduling", jobRoleId: CRD },
      { id: W6, name: "Offer letters", jobRoleId: OPS },
    ],
    scope: { type: "department", id: REC },
    children: [
      { scope: { type: "job_role", id: SRC }, label: "Sourcer" },
      { scope: { type: "job_role", id: CRD }, label: "Coordinator" },
      { scope: { type: "job_role", id: OPS }, label: "Recruiting ops" },
    ],
    period: { from: "2026-11-01", toExclusive: "2026-11-02" },
    timezone: "America/Los_Angeles",
  };
}
