// A batch = the exact set of messages the user reviews and approves at the gate. Its hash covers the workflow,
// the kind and every recipient, subject and body, so an approval names one exact batch and nothing else.
import { createHash } from "node:crypto";

export interface BatchItem {
  /** Stable key, the lowercased recipient address. */
  key: string;
  to: string;
  subject: string;
  body: string;
  /** For dry runs: the observed instance this draft stands in for. */
  sourceInstanceId?: string;
  /** Code checks on the draft (numbers not in the facts, gaps, sign-off). */
  warnings: string[];
}

export type BatchKind = "dry_run" | "live";
export type BatchState = "pending" | "approved" | "sending" | "sent" | "partial" | "failed";

/**
 * Durable per-item state, written BEFORE the tool call (REVIEW-1 H2):
 *   pending -> sending (journalled by the gate before it allows the send) -> sent (the tool reported success)
 *   pending -> failed_before_send (never called, or denied: provably not sent; eligible for a new batch)
 *   sending -> unknown (threw, crashed or no result: may have been sent; counts as contacted until you release it)
 */
export type ItemState = "pending" | "sending" | "sent" | "failed_before_send" | "unknown";

export interface ItemStateRecord {
  state: ItemState;
  at: number;
  tool?: string;
  error?: string;
  /** Set when the user released an unknown item (explicit action). */
  releasedAt?: number;
}

export interface BatchResult {
  key: string;
  tool: string;
  ok: boolean;
  at: number;
  error?: string;
}

export interface Batch {
  version: 1;
  workflowId: string;
  kind: BatchKind;
  hash: string;
  createdAt: number;
  state: BatchState;
  items: BatchItem[];
  approvedAt: number | null;
  results: BatchResult[];
  /** Live batches: state per item key. Missing = pending (batches written before s05b have none). */
  itemStates?: Record<string, ItemStateRecord>;
}

export function batchHash(workflowId: string, kind: BatchKind, items: readonly Pick<BatchItem, "to" | "subject" | "body">[]): string {
  const canonical = JSON.stringify({ v: 1, workflowId, kind, items: items.map((i) => [i.to.toLowerCase(), i.subject, i.body]) });
  return createHash("sha256").update(canonical).digest("hex");
}

export function makeBatch(workflowId: string, kind: BatchKind, items: readonly BatchItem[], createdAt: number): Batch {
  const copy = items.map((i) => ({ ...i, key: i.to.toLowerCase(), warnings: [...i.warnings] }));
  return { version: 1, workflowId, kind, hash: batchHash(workflowId, kind, copy), createdAt, state: "pending", items: copy, approvedAt: null, results: [] };
}

export const shortHash = (h: string) => h.slice(0, 12);
