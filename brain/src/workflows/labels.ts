// Names taken from window titles (REVIEW-2 N8): the generic template's name ("Spreadsheet updates: <doc>") and the
// insight label. They are observed text, so they never sit in workflow.json: they are sealed in
// workflows/<id>/labels.json.enc under the capture day of the oldest instance they came from, and purged with it.
// Until then the app shows the observed name; afterwards the fixed template name.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isExpired, localDay, openText, sealText } from "../store/vault.ts";
import { readWorkflow, workflowDir, workflowExists, listWorkflowIds, writeWorkflow } from "./store.ts";
import type { TemplateId, WorkflowJson } from "./types.ts";

export const LABELS_FILE = "labels.json.enc";

/** Fixed names per template: never observed text. */
export const FIXED_NAMES: Record<TemplateId, string> = {
  investor_outreach: "Investor outreach emails",
  scheduling_reply: "Scheduling replies",
  generic: "Repeated task",
};

export interface WorkflowLabels {
  /** The display name drafted from the insight (observed for the generic template). */
  name: string;
  /** The insight's label name. */
  insightName: string;
}

const labelsPath = (home: string, id: string) => join(workflowDir(home, id), LABELS_FILE);

/** Seals the labels under `day` (the capture day of the oldest source instance). An expired day writes nothing. */
export function sealLabels(home: string, id: string, labels: WorkflowLabels, day: string, now: number): void {
  if (isExpired(day, now)) return;
  sealText(home, labelsPath(home, id), JSON.stringify(labels) + "\n", day);
}

export function readLabels(home: string, id: string, now: number): WorkflowLabels | null {
  const text = openText(home, labelsPath(home, id), now);
  if (text === null) return null;
  try {
    return JSON.parse(text) as WorkflowLabels;
  } catch {
    return null;
  }
}

/** The name to show: the sealed observed name while it is kept, else the workflow.json (fixed) name. */
export function displayName(home: string, wf: WorkflowJson, now: number): string {
  if (!existsSync(labelsPath(home, wf.id))) return wf.name;
  return readLabels(home, wf.id, now)?.name ?? wf.name;
}

/** Moves title-derived names out of workflow.json files written before s10b into the sealed store (dated by the
 * workflow's creation day, the best capture date known). Returns how many workflows were rewritten. */
export function migrateLabels(home: string, now: number): number {
  let n = 0;
  for (const id of listWorkflowIds(home)) {
    let wf: WorkflowJson | null;
    try {
      wf = readWorkflow(home, id);
    } catch {
      continue;
    }
    if (wf === null || !workflowExists(home, id)) continue;
    const fixed = FIXED_NAMES[wf.template] ?? FIXED_NAMES.generic;
    if (wf.name === fixed && wf.insight.name === "") continue;
    if (!existsSync(labelsPath(home, id))) sealLabels(home, id, { name: wf.name, insightName: wf.insight.name }, localDay(wf.createdAt), now);
    writeWorkflow(home, { ...wf, name: fixed, insight: { ...wf.insight, name: "" } });
    n += 1;
  }
  return n;
}
