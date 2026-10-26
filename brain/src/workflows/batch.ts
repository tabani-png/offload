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
  /** s10b N1, live batches: sha256 of the recipients.csv row this draft was written from (autorun.ts rowHash). */
  sourceRowHash?: string;
  /** s13: the commit a non-email item approves (computer use / any app): the verb of the control and the form values,
   * as [label, value] pairs. Part of the batch hash when present. */
  commit?: ItemCommit;
}

export interface ItemCommit {
  verb: string;
  fields: Array<[string, string]>;
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
  /** s10b N3: the day the batch is sealed under (dry runs: capture day of the oldest observed instance). Default: the
   * local day of createdAt. */
  sealDay?: string;
  /** s10b N1: sha256 of facts.md, the tone card and SKILL.md as they were when this batch was drafted. */
  draftedWith?: Record<string, string>;
  /** s27: where a plan workflow's live items came from (its read source, or the person's list). Not hashed: the items'
   * commits carry the exact values. */
  source?: { kind: "read" | "list"; name: string; via: string | null; message: string; skipped?: Array<{ missing: string[]; ambiguous?: string[]; reason?: string }> };
  /** s10b N1: why auto-run did not send this pending batch on its own. */
  review?: { newRecipients: number; changedRecipients: number; changedFiles: string[]; unfilledNames?: number };
}

export function batchHash(workflowId: string, kind: BatchKind, items: readonly (Pick<BatchItem, "to" | "subject" | "body"> & { commit?: ItemCommit })[]): string {
  // An item without `commit` hashes exactly as before s13, so existing batch hashes and approvals stay valid.
  const row = (i: Pick<BatchItem, "to" | "subject" | "body"> & { commit?: ItemCommit }) =>
    i.commit === undefined ? [i.to.toLowerCase(), i.subject, i.body] : [i.to.toLowerCase(), i.subject, i.body, { verb: i.commit.verb, fields: i.commit.fields.map(([l, v]) => [l, v]) }];
  const canonical = JSON.stringify({ v: 1, workflowId, kind, items: items.map(row) });
  return createHash("sha256").update(canonical).digest("hex");
}

export function makeBatch(workflowId: string, kind: BatchKind, items: readonly BatchItem[], createdAt: number): Batch {
  const copy = items.map((i) => ({ ...i, key: i.to.toLowerCase(), warnings: [...i.warnings], ...(i.commit === undefined ? {} : { commit: { verb: i.commit.verb, fields: i.commit.fields.map(([l, v]) => [l, v] as [string, string]) } }) }));
  return { version: 1, workflowId, kind, hash: batchHash(workflowId, kind, copy), createdAt, state: "pending", items: copy, approvedAt: null, results: [] };
}

export const shortHash = (h: string) => h.slice(0, 12);
