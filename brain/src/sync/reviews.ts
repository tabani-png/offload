// Measured review time per run (the hs-1 residual, ADR 0109 §3): seconds and counts only, keyed by the local batch
// hash. Written by the review surface (`recordReview`; the app's review sheet timer is wired in S2-13), read by the
// collector. $OFFLOAD_HOME/sync/reviews.json (0600); rows older than 7 days are dropped on write.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_DAYS } from "../store/vault.ts";
import type { ReviewDecision, ReviewSurface } from "./types.ts";

export interface ReviewRecord {
  workflowId: string;
  batchHash: string;
  at: number;
  reviewSeconds: number;
  editSeconds: number;
  fixSeconds: number;
  itemsEdited: number;
  decision: ReviewDecision;
  surface: ReviewSurface;
}

const path = (home: string) => join(home, "sync", "reviews.json");
const KEEP_MS = (KEEP_DAYS + 1) * 86_400_000;

export function readReviews(home: string): ReviewRecord[] {
  if (!existsSync(path(home))) return [];
  try {
    return JSON.parse(readFileSync(path(home), "utf8")) as ReviewRecord[];
  } catch {
    return [];
  }
}

const sec = (n: number) => Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;

/** Records (or replaces) the review of one batch run. */
export function recordReview(home: string, r: ReviewRecord, now: number): void {
  if (!/^[0-9a-f]{64}$/.test(r.batchHash)) throw new Error("batchHash must be a sha256 hex");
  const rows = readReviews(home).filter((x) => x.batchHash !== r.batchHash && now - x.at <= KEEP_MS);
  rows.push({ workflowId: r.workflowId, batchHash: r.batchHash, at: r.at, reviewSeconds: sec(r.reviewSeconds), editSeconds: sec(r.editSeconds), fixSeconds: sec(r.fixSeconds), itemsEdited: sec(r.itemsEdited), decision: r.decision, surface: r.surface });
  mkdirSync(join(home, "sync"), { recursive: true, mode: 0o700 });
  const tmp = `${path(home)}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rows) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path(home));
}
