// SKILL.md edits from the app (s05c, GET/PUT /workflows/:id/skill). SKILL.md is rendered from workflow.json and is
// display text: the gate and runner read the typed steps (type, connector, sideEffect, tool) and the catalog
// allowlist, never SKILL.md. A PUT may change only the description and each existing step's title and detail. It can
// never add, remove or reorder steps, change a type, connector, tool, script or side-effect flag, turn auto-run on,
// or touch the approval gate. Anything else in the body is refused as a whole (nothing is written).
import { join } from "node:path";
import { API_VERSION, type SkillDTO, type SkillUpdate } from "../api/types.ts";
import { renderSkillMd } from "./drafter.ts";
import { readText, readWorkflow, updateWorkflow, workflowDir, writePrivate } from "./store.ts";
import type { WorkflowJson } from "./types.ts";

export const SKILL_LIMITS = { descriptionChars: 1000, titleChars: 120, detailChars: 600 } as const;

export class SkillEditError extends Error {}

const BODY_KEYS = new Set(["description", "steps"]);
const STEP_KEYS = new Set(["id", "title", "detail"]);
// Control characters other than newline and tab.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

function text(value: unknown, name: string, max: number, multiline: boolean): string {
  if (typeof value !== "string") throw new SkillEditError(`${name} must be a string`);
  const t = value.trim();
  if (t === "") throw new SkillEditError(`${name} must not be blank`);
  if (t.length > max) throw new SkillEditError(`${name} is longer than ${max} characters`);
  if (CONTROL_RE.test(t)) throw new SkillEditError(`${name} has control characters`);
  if (!multiline && /[\r\n]/.test(t)) throw new SkillEditError(`${name} must be one line`);
  // SKILL.md structure (frontmatter fences, headings) stays the template's.
  for (const line of t.split(/\r?\n/)) if (/^\s*(#|---|```)/.test(line)) throw new SkillEditError(`${name} cannot contain headings, --- or code fences`);
  return t;
}

/** The validated edit, or a SkillEditError naming the first problem. Nothing is written here. */
export function validateSkillUpdate(wf: WorkflowJson, body: Record<string, unknown>): SkillUpdate {
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) throw new SkillEditError(`${k} cannot be edited here: only the description and each step's title and detail text`);
  const out: SkillUpdate = {};
  if (body.description !== undefined) out.description = text(body.description, "description", SKILL_LIMITS.descriptionChars, true);
  if (body.steps !== undefined) {
    if (!Array.isArray(body.steps)) throw new SkillEditError("steps must be an array of { id, title?, detail? }");
    const ids = new Set(wf.steps.map((s) => s.id));
    const seen = new Set<string>();
    out.steps = body.steps.map((raw: unknown, i) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SkillEditError(`steps[${i}] must be an object`);
      const s = raw as Record<string, unknown>;
      for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) throw new SkillEditError(`steps[${i}].${k} cannot be edited: a step's type, connector, tool and gate are fixed`);
      if (typeof s.id !== "string" || !ids.has(s.id)) throw new SkillEditError(`steps[${i}].id must name an existing step (steps cannot be added)`);
      if (seen.has(s.id)) throw new SkillEditError(`step ${s.id} is listed twice`);
      seen.add(s.id);
      return {
        id: s.id,
        ...(s.title === undefined ? {} : { title: text(s.title, `steps[${i}].title`, SKILL_LIMITS.titleChars, false) }),
        ...(s.detail === undefined ? {} : { detail: text(s.detail, `steps[${i}].detail`, SKILL_LIMITS.detailChars, false) }),
      };
    });
  }
  return out;
}

export function skillDTO(home: string, wf: WorkflowJson): SkillDTO {
  return {
    version: API_VERSION,
    workflowId: wf.id,
    skillMd: readText(home, wf.id, "SKILL.md") ?? "",
    description: wf.description,
    steps: wf.steps.map((s) => ({ id: s.id, type: s.type, title: s.title, detail: s.detail, connector: s.connector, sideEffect: s.sideEffect })),
    gates: wf.steps.filter((s) => s.type === "approval_gate").map((s) => s.id),
    limits: { ...SKILL_LIMITS },
  };
}

/** Applies a validated edit to the text fields only and re-renders SKILL.md. */
export function applySkillUpdate(home: string, id: string, body: Record<string, unknown>, now: number): SkillDTO {
  const wf = readWorkflow(home, id);
  if (wf === null) throw new SkillEditError(`no workflow ${id}`);
  const edit = validateSkillUpdate(wf, body);
  const updated = updateWorkflow(home, id, (w) => {
    if (edit.description !== undefined) w.description = edit.description;
    for (const e of edit.steps ?? []) {
      const step = w.steps.find((s) => s.id === e.id)!;
      if (e.title !== undefined) step.title = e.title;
      if (e.detail !== undefined) step.detail = e.detail;
    }
  }, now);
  writePrivate(join(workflowDir(home, id), "SKILL.md"), renderSkillMd(updated));
  return skillDTO(home, updated);
}
