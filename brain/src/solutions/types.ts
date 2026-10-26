// s22 solution designer: the shapes. A Solution set ranks five kinds of fix for one repeated task. Every number in
// here is computed in code (rules.ts, ADR 0005); a model may only reword the text fields (design.ts).
import type { Insight } from "../analyze.ts";

/** a workflow, b tool, c setup, d remove_step, e leave_alone (brain/API.md "Solutions (s22)"). */
export type SolutionKind = "workflow" | "tool" | "setup" | "remove_step" | "leave_alone";
export const SOLUTION_KINDS: readonly SolutionKind[] = ["workflow", "tool", "setup", "remove_step", "leave_alone"];

export type Effort = "none" | "low" | "medium" | "high";
export type ConfidenceLevel = "low" | "medium" | "high";

/** An insight, or a task the judge held back because a person is at the keyboard (analyze.ts heldBack). */
export type SolutionSubject = Omit<Insight, "rank"> & { rank?: number; heldBack?: { reason: string } };

/** Tags a part of a task can carry (signals.ts lexicon). */
export type PartTag = "messaging" | "publish" | "media_make" | "agent_watch" | "agent_prompt" | "approval_prompt" | "code_manual" | "data_entry" | "copy_between" | "reading";

/** One part of a task: a v2 understanding step, or the whole task for v1. */
export interface TaskPart {
  id: string;
  /** Plain words: "verb object on surface" (v2) or the task name (v1). Masked: no identifiers. */
  name: string;
  activeMs: number;
  spanIds: string[];
  tags: PartTag[];
}

/** What a builder gets: the spec of a tool, a setup change or a pipeline that removes a step. */
export interface BriefSpec {
  inputs: string[];
  outputs: string[];
  runsWhere: string;
  /** The Claude Code prompt for a builder. */
  builderPrompt: string;
  acceptance: string[];
}

export interface SolutionOption {
  kind: SolutionKind;
  /** One line: what to build (or why to leave it). */
  what: string;
  why: string;
  /** h/wk, code: min(observed, observed x share x factor); never above observedWeeklyHours. */
  weeklyHoursSaved: number;
  /** Share of the task's active time this option replaces, 0..1. */
  share: number;
  arithmetic: string;
  effort: { level: Effort; setupHours: number; paybackWeeks: number | null };
  confidence: { value: number; level: ConfidenceLevel; reasons: string[] };
  evidence: { spanIds: string[]; instanceIds: string[]; parts: string[] };
  /** workflow: the drafter that takes it from here; tool/setup/remove_step: the brief spec; leave_alone: none. */
  handoff: { to: "workflow_drafter"; insightId: string } | { to: "brief"; spec: BriefSpec } | { to: "none" };
  /** s24 (additive): the latest dry-run build of this option's brief, so hours saved can be shown against cost. */
  build?: { runId: string; outcome: "PASS" | "FAIL" | "CAP" | "TAMPER"; costUsd: number; tries: number; totalCostUsd: number };
}

export interface SolutionSet {
  version: 1;
  subjectId: string;
  taskId: string;
  name: string;
  heldBack: boolean;
  /** h/wk actually observed: activeMinutes / 60 x 7 / window days. */
  observedWeeklyHours: number;
  observedArithmetic: string;
  parts: TaskPart[];
  /** Ranked best first. Always all five kinds. */
  options: SolutionOption[];
  top: SolutionKind;
  designedBy: string;
}
