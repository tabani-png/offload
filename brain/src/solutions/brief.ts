// s22 solution briefs: a tool, setup change or remove-step option written down for a builder, as a DRAFT the user
// approves. $OFFLOAD_HOME/solutions/<sol_id>/{brief.json, BRIEF.md, approval.json}, 0600 in 0700 folders.
// The approval follows the s05 gate's rules (ADR 0006): it names the exact content hash of the brief (sha256 of its
// canonical content), only a draft can be approved, and it mints a single-use hand-off token (only its sha256 is
// stored). The hand-off returns the builder prompt once; a stale hash, an edited file, a wrong or reused token is
// refused. Nothing here runs anything: a brief is text for a builder.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../sync/jcs.ts";
import { ensureDir, writePrivate } from "../workflows/store.ts";
import type { BriefSpec, SolutionKind, SolutionOption, SolutionSet } from "./types.ts";

export const BRIEF_ID_RE = /^sol_[a-z0-9]{6,40}$/;
export type BriefStatus = "draft" | "approved" | "handed_off";

export interface SolutionBrief {
  version: 1;
  id: string;
  subjectId: string;
  taskId: string;
  kind: Exclude<SolutionKind, "workflow" | "leave_alone">;
  name: string;
  what: string;
  why: string;
  spec: BriefSpec;
  figures: { weeklyHoursSaved: number; observedWeeklyHours: number; arithmetic: string; effort: SolutionOption["effort"]; confidence: SolutionOption["confidence"] };
  evidence: SolutionOption["evidence"];
  designedBy: string;
  createdAt: number;
  /** sha256 of the canonical content (everything above but createdAt). */
  hash: string;
  status: BriefStatus;
  approvedAt?: number;
  handedOffAt?: number;
}

interface ApprovalFile {
  briefHash: string;
  tokenSha256: string;
  approvedAt: number;
  usedAt: number | null;
}

export class BriefError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "forbidden" | "bad_request",
  ) {
    super(message);
  }
}

export const solutionsDir = (home: string) => join(home, "solutions");
function briefDir(home: string, id: string): string {
  if (!BRIEF_ID_RE.test(id)) throw new BriefError(`bad brief id ${id}`, "bad_request");
  return join(solutionsDir(home), id);
}

export const briefIdFor = (subjectId: string, kind: SolutionKind) => `sol_${createHash("sha256").update(`${subjectId}\u0000${kind}`).digest("hex").slice(0, 16)}`;

type Content = Omit<SolutionBrief, "hash" | "status" | "approvedAt" | "handedOffAt" | "createdAt">;
const contentOf = (b: SolutionBrief | (Content & { createdAt?: number })): Content => {
  const { hash: _h, status: _s, approvedAt: _a, handedOffAt: _o, createdAt: _c, ...rest } = b as SolutionBrief;
  return rest;
};
export const briefHash = (b: SolutionBrief | Content) => createHash("sha256").update(canonicalize(contentOf(b as SolutionBrief))).digest("hex");

export function renderBriefMd(b: SolutionBrief): string {
  const f = b.figures;
  return [
    `# Solution brief: ${b.what}`,
    "",
    `Status: ${b.status} (nothing runs until you approve this exact brief and hand it to a builder)`,
    `Task: ${b.name} · kind: ${b.kind} · designed by: ${b.designedBy}`,
    "",
    "## Why",
    b.why,
    "",
    "## Spec",
    `- Inputs: ${b.spec.inputs.join("; ")}`,
    `- Outputs: ${b.spec.outputs.join("; ")}`,
    `- Where it runs: ${b.spec.runsWhere}`,
    `- Effort: ${f.effort.level}, about ${f.effort.setupHours} h to set up${f.effort.paybackWeeks === null ? "" : `, pays back in ${f.effort.paybackWeeks} weeks`}`,
    "",
    "## Time (computed by Offload, not by a model)",
    `- Observed: ${f.observedWeeklyHours.toFixed(2)} h/wk`,
    `- Saves: ${f.weeklyHoursSaved.toFixed(2)} h/wk (${f.arithmetic})`,
    `- Confidence: ${f.confidence.level} (${f.confidence.value.toFixed(2)}): ${f.confidence.reasons.join("; ")}`,
    "",
    "## Prompt for the builder (Claude Code)",
    "```",
    b.spec.builderPrompt,
    "```",
    "",
    "## Acceptance checks",
    ...b.spec.acceptance.map((a) => `- [ ] ${a}`),
    "",
    "## Evidence",
    `- Spans: ${b.evidence.spanIds.length} (${b.evidence.spanIds.slice(0, 10).join(", ")}${b.evidence.spanIds.length > 10 ? ", …" : ""})`,
    `- Instances: ${b.evidence.instanceIds.length}`,
    "",
  ].join("\n");
}

export function readBrief(home: string, id: string): SolutionBrief | null {
  const p = join(briefDir(home, id), "brief.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SolutionBrief;
}

function saveBrief(home: string, b: SolutionBrief): void {
  const dir = briefDir(home, b.id);
  ensureDir(solutionsDir(home));
  ensureDir(dir);
  writePrivate(join(dir, "brief.json"), JSON.stringify(b, null, 2) + "\n");
  writePrivate(join(dir, "BRIEF.md"), renderBriefMd(b));
}

/** Writes the draft brief for one option. An approved or handed-off brief is kept as it is (created: false). */
export function writeBrief(home: string, set: SolutionSet, option: SolutionOption, now: number): { brief: SolutionBrief; created: boolean } {
  if (option.handoff.to !== "brief" || option.kind === "workflow" || option.kind === "leave_alone") throw new BriefError(`a ${option.kind} option has no brief`, "bad_request");
  const id = briefIdFor(set.subjectId, option.kind);
  const existing = readBrief(home, id);
  if (existing !== null && existing.status !== "draft") return { brief: existing, created: false };
  const content: Content = {
    version: 1,
    id,
    subjectId: set.subjectId,
    taskId: set.taskId,
    kind: option.kind,
    name: set.name,
    what: option.what,
    why: option.why,
    spec: option.handoff.spec,
    figures: { weeklyHoursSaved: option.weeklyHoursSaved, observedWeeklyHours: set.observedWeeklyHours, arithmetic: option.arithmetic, effort: option.effort, confidence: option.confidence },
    evidence: option.evidence,
    designedBy: set.designedBy,
  };
  const hash = briefHash(content);
  if (existing !== null && existing.hash === hash) return { brief: existing, created: false };
  const brief: SolutionBrief = { ...content, createdAt: now, hash, status: "draft" };
  saveBrief(home, brief);
  // A redrafted brief voids any approval of the old content.
  const ap = join(briefDir(home, id), "approval.json");
  if (existsSync(ap)) writePrivate(ap, JSON.stringify({ voided: true }) + "\n");
  return { brief, created: existing === null };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Approves the exact current brief. Returns the single-use hand-off token (shown once, stored as its sha256). */
export function approveBrief(home: string, id: string, hash: string, now: number): { brief: SolutionBrief; token: string } {
  const b = readBrief(home, id);
  if (b === null) throw new BriefError(`no brief ${id}`, "not_found");
  if (briefHash(b) !== b.hash) throw new BriefError("the brief file changed after it was drafted: draft it again", "conflict");
  if (typeof hash !== "string" || hash !== b.hash) throw new BriefError("that hash is not this brief's current content", "conflict");
  if (b.status !== "draft") throw new BriefError(`brief is ${b.status}, not a draft`, "conflict");
  const token = randomBytes(32).toString("base64url");
  const rec: ApprovalFile = { briefHash: b.hash, tokenSha256: sha(token), approvedAt: now, usedAt: null };
  writePrivate(join(briefDir(home, id), "approval.json"), JSON.stringify(rec, null, 2) + "\n");
  const approved: SolutionBrief = { ...b, status: "approved", approvedAt: now };
  saveBrief(home, approved);
  return { brief: approved, token };
}

/** Consumes the token once: the brief is handed to a builder (its prompt is returned). Nothing is executed here. */
export function handOffBrief(home: string, id: string, token: string, now: number): { brief: SolutionBrief; builderPrompt: string; briefMd: string } {
  const b = readBrief(home, id);
  if (b === null) throw new BriefError(`no brief ${id}`, "not_found");
  if (briefHash(b) !== b.hash) throw new BriefError("the brief file changed after it was approved: draft it again", "conflict");
  if (b.status !== "approved") throw new BriefError(`brief is ${b.status}, not approved`, "conflict");
  const ap = join(briefDir(home, id), "approval.json");
  const rec = existsSync(ap) ? (JSON.parse(readFileSync(ap, "utf8")) as Partial<ApprovalFile>) : null;
  if (rec === null || typeof rec.tokenSha256 !== "string" || rec.briefHash !== b.hash) throw new BriefError("no approval for this exact brief", "forbidden");
  if (rec.usedAt !== null && rec.usedAt !== undefined) throw new BriefError("this approval was already used", "conflict");
  const want = Buffer.from(rec.tokenSha256, "hex");
  const got = Buffer.from(sha(typeof token === "string" ? token : ""), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new BriefError("wrong hand-off token", "forbidden");
  writePrivate(ap, JSON.stringify({ ...rec, usedAt: now }, null, 2) + "\n");
  const done: SolutionBrief = { ...b, status: "handed_off", handedOffAt: now };
  saveBrief(home, done);
  return { brief: done, builderPrompt: done.spec.builderPrompt, briefMd: renderBriefMd(done) };
}
