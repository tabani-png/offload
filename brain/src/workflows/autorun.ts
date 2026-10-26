// Auto-run pin (REVIEW-2 N1). Turning auto-run on pins what the user agreed to: every row of the recipient list
// (by sha256 of the address and of the row) and the sha256 of facts.md, the workflow's tone card and SKILL.md. Auto-run
// then sends on its own ONLY to recipients whose row is pinned and unchanged, drafted from exactly the pinned files,
// in a batch drafted after the pin. Anyone new or changed is split into a pending batch that waits for review; a
// changed file holds the whole batch. Turning auto-run on again re-pins; turning it off drops the pin. workflow.json
// keeps hashes only, never addresses.
import { createHash } from "node:crypto";
import type { AutoRunPinDTO } from "../api/types.ts";
import { readStyleCard } from "../tone/pack.ts";
import type { Batch, BatchItem } from "./batch.ts";
import { readRecipients, type RecipientRow } from "./scripts/recipients.ts";
import { readText, updateWorkflow } from "./store.ts";
import type { AutoRunPin, WorkflowJson } from "./types.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 of an address, keyed per workflow (workflow.json never holds the address itself). */
export const addressHash = (workflowId: string, email: string) => sha(`${workflowId}\u0000${email.trim().toLowerCase()}`);
/** sha256 of every field of a recipient row: a change to notes or org is a change. */
export const rowHash = (r: RecipientRow) => sha(JSON.stringify([r.email.toLowerCase(), r.firstName, r.lastName, r.org, r.notes]));

/** The pinned files, in display order: name -> how to read it. */
export function pinFiles(home: string, wf: WorkflowJson): Record<string, string> {
  const card = readStyleCard(home, wf.bucket);
  // s19: playbook.json only when the workflow has one, so pins taken before a playbook existed stay valid. A pinned
  // playbook.json that is gone later is a changed file (changedFiles compares pinned and current names).
  const playbook = readText(home, wf.id, "playbook.json");
  return {
    "facts.md": sha(readText(home, wf.id, "facts.md") ?? ""),
    [`tone/${wf.bucket}.md`]: sha(card.text ?? ""),
    "SKILL.md": sha(readText(home, wf.id, "SKILL.md") ?? ""),
    ...(playbook === null ? {} : { "playbook.json": sha(playbook) }),
  };
}

/** Rows of the recipient list; an unreadable list counts as empty here (the run itself reports it). */
function currentRows(home: string, wf: WorkflowJson): RecipientRow[] {
  try {
    return readRecipients(readText(home, wf.id, wf.inputs.list) ?? "");
  } catch {
    return [];
  }
}

export function computePin(home: string, wf: WorkflowJson, now: number): AutoRunPin {
  const rows: Record<string, string> = {};
  for (const r of currentRows(home, wf)) rows[addressHash(wf.id, r.email)] = rowHash(r);
  return { at: now, rows, files: pinFiles(home, wf) };
}

/** Turns auto-run on and (re-)pins. */
export function enableAutoRun(home: string, id: string, now: number): WorkflowJson {
  return updateWorkflow(home, id, (w) => {
    w.autoRun = true;
    w.autoRunPin = computePin(home, w, now);
  }, now);
}

/** Turns auto-run off and drops the pin. */
export function disableAutoRun(home: string, id: string, now: number): WorkflowJson {
  return updateWorkflow(home, id, (w) => {
    w.autoRun = false;
    w.autoRunPin = null;
  }, now);
}

/** Pinned and current file names, in display order (a pinned file that is gone is still listed). */
const fileNames = (pin: AutoRunPin | null | undefined, files: Record<string, string>) => [...new Set([...Object.keys(files), ...Object.keys(pin?.files ?? {})])];

/** Files whose hash differs from the pin, including a pinned file that is gone (all of them when there is no pin). */
export function changedFiles(pin: AutoRunPin | null | undefined, files: Record<string, string>): string[] {
  return fileNames(pin, files).filter((f) => pin?.files[f] !== files[f]);
}

export interface AutoPartition {
  /** Items auto-run may send: pinned, unchanged row. */
  eligible: BatchItem[];
  newItems: BatchItem[];
  changedItems: BatchItem[];
  /** Pinned files that changed since the pin (now, or when the batch was drafted). Non-empty = hold everything. */
  changedFiles: string[];
  /** Drafted before the pin: hold everything. */
  stale: boolean;
}

/** Splits a live batch into what auto-run may send and what needs review. */
export function partitionForAuto(home: string, wf: WorkflowJson, batch: Batch): AutoPartition {
  const pin = wf.autoRunPin ?? null;
  const now = pinFiles(home, wf);
  const files = new Set(changedFiles(pin, now));
  if (batch.draftedWith !== undefined) for (const f of changedFiles(pin, batch.draftedWith)) files.add(f);
  else for (const f of fileNames(pin, now)) files.add(f); // drafted before s10b: nothing to compare with.
  const out: AutoPartition = { eligible: [], newItems: [], changedItems: [], changedFiles: fileNames(pin, now).filter((f) => files.has(f)), stale: pin === null || batch.createdAt < pin.at };
  for (const i of batch.items) {
    const pinned = pin?.rows[addressHash(wf.id, i.key)];
    if (pinned === undefined) out.newItems.push(i);
    else if (i.sourceRowHash === undefined || pinned !== i.sourceRowHash) out.changedItems.push(i);
    else out.eligible.push(i);
  }
  return out;
}

/** True when auto-run may send every item of this batch on its own. */
export function autoSendable(home: string, wf: WorkflowJson, batch: Batch): boolean {
  if (!wf.autoRun) return false;
  const p = partitionForAuto(home, wf, batch);
  return !p.stale && p.changedFiles.length === 0 && p.newItems.length === 0 && p.changedItems.length === 0;
}

/** What is pinned, for the app: shown when auto-run is turned on, and on every summary while it is on. */
export function autoRunPinDTO(home: string, wf: WorkflowJson): AutoRunPinDTO | null {
  const pin = wf.autoRunPin ?? null;
  if (!wf.autoRun || pin === null) return null;
  const rows = currentRows(home, wf);
  const pinnedRecipients: string[] = [];
  let newRecipients = 0;
  let changedRecipients = 0;
  const present = new Set<string>();
  for (const r of rows) {
    const h = addressHash(wf.id, r.email);
    present.add(h);
    const p = pin.rows[h];
    if (p === undefined) newRecipients += 1;
    else if (p !== rowHash(r)) changedRecipients += 1;
    else pinnedRecipients.push(r.email);
  }
  const files = pinFiles(home, wf);
  return {
    pinnedAt: pin.at,
    recipients: Object.keys(pin.rows).length,
    pinnedRecipients: pinnedRecipients.sort(),
    newRecipients,
    changedRecipients,
    removedRecipients: Object.keys(pin.rows).filter((h) => !present.has(h)).length,
    files: Object.entries(pin.files).map(([file, sha256]) => ({ file, sha256, changed: files[file] !== sha256 })),
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The needs-you sentence for a batch auto-run held back, or null for an ordinary pending batch. */
export function reviewSentence(b: Batch): string | null {
  const r = b.review;
  if (r === undefined) return null;
  if (r.changedFiles.length > 0) {
    const names = r.changedFiles.map((f) => (f.startsWith("tone/") ? "the tone card" : f));
    const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
    const text = `${list} changed since you turned on auto-run, so this batch of ${b.items.length} waits for your review.`;
    return text.startsWith("the ") ? `T${text.slice(1)}` : text;
  }
  const n = r.newRecipients + r.changedRecipients;
  if (n === 0) return null;
  const what = r.changedRecipients === 0 ? "new" : r.newRecipients === 0 ? "changed" : "new or changed";
  return `${n} ${what} ${plural(n, "recipient needs", "recipients need")} your review.`;
}
