// s26: live batches for general plan workflows (s14), the step between "the dry run is approved" and "Offload does the
// work". Before this, prepareLiveBatch refused every non-email workflow ("not built yet").
//
// Scope (slices/s26-automation-e2e/SPEC.md, fix 1):
//   - field outputs only (rows, form_fields, record, stage_change) whose commit is a UI commit (computer use, the
//     legacy send step's `method: "computer"`); text outputs and commits through a tool's own schema refuse plainly;
//   - the items are the rows of the workflow's own list (`inputs.list`, items.csv): header = field labels, one row per
//     item. The person fills it (or exports it). Reading new source data through a connector is not wired yet;
//   - next `batchSize` rows not done yet (done log, live batches that are not provably unsent, the contacted ledger);
//   - each item carries its exact commit `{ verb, fields }` (part of the batch hash, s13), so the gate binds the click to
//     the approved values; values are copied by code from the list (ADR 0005); no model call.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OutputType } from "../api/s14-types.ts";
import { commitVerbOf } from "../connectors/computer/actions.ts";
import { chosenVariant } from "../plan/build.ts";
import { addressHash } from "./autorun.ts";
import type { BatchItem } from "./batch.ts";
import { CRM_HEADER } from "./scripts/crm-log.ts";
import { parseCsv } from "./scripts/recipients.ts";
import { readText, workflowDir, writePrivate } from "./store.ts";
import type { WorkflowJson } from "./types.ts";

export const LIVE_FIELD_OUTPUTS: ReadonlySet<OutputType> = new Set(["rows", "form_fields", "record", "stage_change"]);
const MAX_FIELDS = 40;
const MAX_LABEL = 60;
const MAX_VALUE = 2000;

export class PlanLiveError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "bad_request",
  ) {
    super(message);
  }
}

/** A general plan workflow (s14) rather than one of the email templates. */
export const isPlanWorkflow = (wf: WorkflowJson): boolean => wf.template === "generic" && wf.plan !== undefined;

/** The UI verb an approved item commits with: the plan's commit verb when a control can carry it, else "save". */
export function liveCommitVerb(wf: WorkflowJson): string {
  const commit = wf.plan === undefined ? undefined : chosenVariant(wf.plan).steps.find((s) => s.type === "commit");
  const word = (commit?.capability?.need ?? commit?.title ?? "").trim().split(/\s+/)[0] ?? "";
  return commitVerbOf({ title: word }) ?? "save";
}

/** Why this plan workflow cannot have live batches yet, in plain words, or null when it can. */
export function liveUnsupported(wf: WorkflowJson): string | null {
  const out = wf.plan?.outputType;
  if (out === undefined) return "this workflow has no plan";
  if (!LIVE_FIELD_OUTPUTS.has(out)) return `live batches that draft text (${out.replace("_", " ")}) are not built yet for this kind of workflow; the dry run shows what it would write`;
  const send = wf.steps.find((s) => s.type === "send" && s.sideEffect);
  if (send === undefined) return "this workflow has no step that saves anything";
  if (send.method !== "computer") return `live batches that save through ${send.connector ?? "a tool"}'s own fields are not built yet; only on-screen saves are`;
  return null;
}

export interface ItemRow {
  line: number;
  fields: Array<[string, string]>;
}

/** Parses the person's list: a header of unique field labels, then one row per item. Plain-words errors. */
export function readItemRows(text: string, file: string): { labels: string[]; rows: ItemRow[] } {
  const all = parseCsv(text.replace(/^﻿/, ""));
  const header = (all[0] ?? []).map((l) => l.normalize("NFC").trim());
  const fill = `add the rows to do to ${file} in the workflow folder: a first line with the field names, then one line per item`;
  if (header.length === 0 || header.every((l) => l === "")) throw new PlanLiveError(`no rows to do yet: ${fill}`, "conflict");
  if (header.length > MAX_FIELDS) throw new PlanLiveError(`${file} has ${header.length} columns; at most ${MAX_FIELDS}`, "conflict");
  const seen = new Set<string>();
  for (const l of header) {
    if (l === "" || l.length > MAX_LABEL) throw new PlanLiveError(`every column of ${file} needs a name of 1 to ${MAX_LABEL} characters`, "conflict");
    if (seen.has(l.toLowerCase())) throw new PlanLiveError(`${file} names the column "${l}" twice`, "conflict");
    seen.add(l.toLowerCase());
  }
  const rows: ItemRow[] = [];
  for (let i = 1; i < all.length; i++) {
    const cells = all[i]!.map((c) => c.normalize("NFC").replace(/\r\n?/g, "\n").trim());
    if (cells.every((c) => c === "")) continue;
    if (cells.length !== header.length) throw new PlanLiveError(`line ${i + 1} of ${file} has ${cells.length} values for ${header.length} columns`, "conflict");
    if (cells.some((c) => c.length > MAX_VALUE)) throw new PlanLiveError(`line ${i + 1} of ${file} has a value over ${MAX_VALUE} characters`, "conflict");
    rows.push({ line: i + 1, fields: header.map((l, k) => [l, cells[k]!] as [string, string]) });
  }
  if (rows.length === 0) throw new PlanLiveError(`no rows to do yet: ${fill}`, "conflict");
  return { labels: header, rows };
}

/** Stable key of one row of one workflow: the same values are the same item, whatever line they are on. */
export function rowKey(workflowId: string, fields: ReadonlyArray<readonly [string, string]>): string {
  return `row-${createHash("sha256").update(JSON.stringify({ workflowId, fields })).digest("hex").slice(0, 16)}`;
}

/**
 * The next live items of a plan workflow, or a PlanLiveError. `done` = keys that must not be done again (done log
 * and live batches); the contacted ledger is read here (it outlives purged batches).
 */
export function planLiveItems(o: { home: string; wf: WorkflowJson; done: ReadonlySet<string>; ledger: ReadonlySet<string> }): BatchItem[] {
  const why = liveUnsupported(o.wf);
  if (why !== null) throw new PlanLiveError(why, "bad_request");
  const file = o.wf.inputs.list;
  const { rows } = readItemRows(readText(o.home, o.wf.id, file) ?? "", file);
  const verb = liveCommitVerb(o.wf);
  const items: BatchItem[] = [];
  const keys = new Set<string>();
  for (const r of rows) {
    const key = rowKey(o.wf.id, r.fields);
    if (keys.has(key) || o.done.has(key) || o.ledger.has(addressHash(o.wf.id, key))) continue;
    keys.add(key);
    const shown = r.fields.filter(([, v]) => v !== "");
    items.push({
      key,
      to: key,
      subject: `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${shown.map(([l, v]) => `${l} ${v}`).join(", ")}`.slice(0, 300),
      body: r.fields.map(([l, v]) => `${l}: ${v === "" ? "(empty)" : v}`).join("\n"),
      warnings: r.fields.some(([, v]) => v === "") ? ["some fields are empty in your list; they stay empty"] : [],
      commit: { verb, fields: r.fields.map(([l, v]) => [l, v] as [string, string]) },
    });
    if (items.length >= o.wf.batchSize) break;
  }
  if (items.length === 0) throw new PlanLiveError(`every row in ${file} is done; add new rows to do more`, "conflict");
  // The done log starts with its header, so its first entry is read back as an entry.
  const log = join(workflowDir(o.home, o.wf.id), o.wf.inputs.crmLog);
  if (!existsSync(log)) writePrivate(log, CRM_HEADER + "\n");
  return items;
}
