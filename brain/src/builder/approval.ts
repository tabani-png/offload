// s24 build approval: the s05 / s22 gate rules (ADR 0006) for a build. Approval names the exact current brief content
// hash AND the exact current check-script sha256, both files intact; it mints a single-use token (only its sha256 is
// stored). A build consumes the token once, before any workspace exists. A redrafted brief or a rewritten check
// script makes the stored approval stale.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefHash, BriefError, readBrief, solutionsDir, type SolutionBrief } from "../solutions/brief.ts";
import { writePrivate } from "../workflows/store.ts";
import { checkSha, readChecks, type CheckSet } from "./checks.ts";

interface BuildApprovalFile {
  briefHash: string;
  checkHash: string;
  tokenSha256: string;
  approvedAt: number;
  usedAt: number | null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const approvalPath = (home: string, id: string) => join(solutionsDir(home), id, "build-approval.json");
/** Created with O_EXCL by the one consumer that wins: the cross-process single-use claim. */
const claimPath = (home: string, id: string) => join(solutionsDir(home), id, "build-approval.claim");

/** The brief and its frozen checks, both intact on disk, or a refusal. */
export function currentBuildInputs(home: string, id: string): { brief: SolutionBrief; checks: CheckSet; content: string } {
  const brief = readBrief(home, id);
  if (brief === null) throw new BriefError(`no brief ${id}`, "not_found");
  if (briefHash(brief) !== brief.hash) throw new BriefError("the brief file changed after it was drafted: draft it again", "conflict");
  const c = readChecks(home, id);
  if (c === null) throw new BriefError("no acceptance check script yet: write the checks first", "conflict");
  if (checkSha(c.content) !== c.set.sha256) throw new BriefError("the check script changed after it was written: write the checks again", "conflict");
  if (c.set.briefHash !== brief.hash) throw new BriefError("the check script was written for another version of the brief: write the checks again", "conflict");
  return { brief, checks: c.set, content: c.content };
}

export function approveBuild(home: string, id: string, briefHashIn: string, checkHash: string, now: number): { briefHash: string; checkHash: string; token: string } {
  const { brief, checks } = currentBuildInputs(home, id);
  if (typeof briefHashIn !== "string" || briefHashIn !== brief.hash) throw new BriefError("that hash is not this brief's current content", "conflict");
  if (typeof checkHash !== "string" || checkHash !== checks.sha256) throw new BriefError("that hash is not the current check script", "conflict");
  const token = randomBytes(32).toString("base64url");
  const rec: BuildApprovalFile = { briefHash: brief.hash, checkHash: checks.sha256, tokenSha256: sha(token), approvedAt: now, usedAt: null };
  writePrivate(approvalPath(home, id), JSON.stringify(rec, null, 2) + "\n");
  // A new approval starts unclaimed (the old token is void: its hash is no longer stored).
  rmSync(claimPath(home, id), { force: true });
  return { briefHash: brief.hash, checkHash: checks.sha256, token };
}

/** Verifies the build token for the exact brief + check hash WITHOUT using it (the runner checks first, sets up, and
 * claims last, so a setup failure does not burn the approval). */
export function peekBuildApproval(home: string, id: string, token: string): { brief: SolutionBrief; checks: CheckSet; content: string } {
  const cur = currentBuildInputs(home, id);
  const p = approvalPath(home, id);
  const rec = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Partial<BuildApprovalFile>) : null;
  if (rec === null || typeof rec.tokenSha256 !== "string") throw new BriefError("no build approval for this brief", "forbidden");
  if (rec.briefHash !== cur.brief.hash || rec.checkHash !== cur.checks.sha256) throw new BriefError("the approval is for another brief or check script: approve this exact one", "forbidden");
  if (rec.usedAt !== null && rec.usedAt !== undefined) throw new BriefError("this build approval was already used", "conflict");
  const want = Buffer.from(rec.tokenSha256, "hex");
  const got = Buffer.from(sha(typeof token === "string" ? token : ""), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new BriefError("wrong build token", "forbidden");
  if (existsSync(claimPath(home, id))) throw new BriefError("this build approval was already used", "conflict");
  return cur;
}

/** Uses the token: re-verifies, then claims it atomically (O_EXCL create; a second claimant, in any process, fails). */
export function claimBuildApproval(home: string, id: string, token: string, now: number): { brief: SolutionBrief; checks: CheckSet; content: string } {
  const cur = peekBuildApproval(home, id, token);
  try {
    writeFileSync(claimPath(home, id), `${sha(token)} ${now}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new BriefError("this build approval was already used", "conflict");
    throw err;
  }
  const p = approvalPath(home, id);
  writePrivate(p, JSON.stringify({ ...(JSON.parse(readFileSync(p, "utf8")) as BuildApprovalFile), usedAt: now }, null, 2) + "\n");
  return cur;
}

/** Consumes the build token once for the exact brief + check hash. Returns what the build may use. */
export function consumeBuildApproval(home: string, id: string, token: string, now: number): { brief: SolutionBrief; checks: CheckSet; content: string } {
  return claimBuildApproval(home, id, token, now);
}
