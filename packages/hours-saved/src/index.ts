// @offload/hours-saved: the hs-1 engine (ADR 0109). Pure: no clock, no randomness, no I/O, no runtime dependencies.

export * from "./types.ts";
export { baseline, savedForRun, displayHours, median, nearestRank, gradeFor, isPolicyCommitted } from "./core.ts";
export {
  total,
  suppress,
  anomalies,
  buildRows,
  cellOf,
  selectRows,
  inScope,
  isSuppressed,
  SUPPRESSED,
  DEFAULT_GROUP_FLOOR,
  type BaselineEntry,
} from "./aggregate.ts";
export { inputsDigest, jcs, sha256Hex, sha256OfString, utf8 } from "./digest.ts";
export { localDay, inPeriod, dayStartUtc, periodBoundsUtc } from "./time.ts";
export { report, recompute, evidence, baselinesFor, reportInputsDigest, type ReportInput, type WorkflowMeta } from "./report.ts";
