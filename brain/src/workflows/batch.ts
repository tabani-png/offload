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
