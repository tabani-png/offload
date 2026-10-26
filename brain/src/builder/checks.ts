// s24 checks first, frozen: before any build a separate model call (role build_checks -> router route "draft",
// Sonnet) turns the brief's acceptance lines into ONE executable check script, accept.py (python3) or accept.test.ts
// (bun test). The script is stored with its sha256 next to the brief and shown in BUILD.md for approval; the builder
// never gets write access to it and the runner verifies the hash after every try (runner.ts).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { BriefError, readBrief, renderBriefMd, solutionsDir, type SolutionBrief } from "../solutions/brief.ts";
import { ensureDir, writePrivate } from "../workflows/store.ts";

export const CHECK_FILES = ["accept.py", "accept.test.ts"] as const;
export type CheckFile = (typeof CHECK_FILES)[number];
export const MAX_CHECK_BYTES = 32 * 1024;

export interface CheckSet {
  version: 1;
  briefId: string;
  briefHash: string;
  file: CheckFile;
  /** sha256 of the script's exact bytes. */
  sha256: string;
  /** The check writer: the router's model, or "stub". */
  model: string;
  createdAt: number;
}

/** Text that goes to a model. TODO(s18): s18 name masking is not on this base; the hook is identity until it lands. */
export type Mask = (text: string) => string;
export const identityMask: Mask = (t) => t;

export const CHECK_WRITER_SYSTEM = [
  "You write the acceptance check for a small tool before anyone builds it. The check decides done, not the builder.",
  "You get the brief: what it is, its inputs, outputs, where it runs, and the acceptance lines.",
  "Write ONE self-contained check script that runs from the workspace root and exits 0 only when every acceptance line holds. Print one line per check: PASS or FAIL and the reason.",
  "Use python3 with the standard library only (file accept.py), or bun test (file accept.test.ts). No network, no package installs, no reading outside the workspace. Make fixtures inside a temporary folder.",
  "Never import or require the built code into the check: run it as a subprocess from the workspace root (python3: subprocess.run([sys.executable, 'tool.py', ...]); bun: Bun.spawnSync([process.execPath, 'run', 'tool.ts', ...])) and check its output and files. Imports of workspace code are refused.",
  'Reply with JSON only: {"file":"accept.py","content":"..."}.',
].join("\n");

export const checkSha = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

/** A deterministic check for the stub model: the build must leave at least one file next to accept/. */
export const FALLBACK_CHECK = [
  "import os, sys",
  "files = [f for f in os.listdir('.') if f != 'accept' and not f.startswith('.')]",
  "print(('PASS' if files else 'FAIL') + ' workspace has build output: ' + ', '.join(sorted(files)))",
  "sys.exit(0 if files else 1)",
  "",
].join("\n");

export function checkWriterPrompt(b: SolutionBrief, mask: Mask = identityMask): string {
  const s = b.spec;
  const body = [`what: ${b.what}`, `kind: ${b.kind}`, `runs where: ${s.runsWhere}`, "inputs:", ...s.inputs.map((x) => `- ${x}`), "outputs:", ...s.outputs.map((x) => `- ${x}`), "acceptance:", ...s.acceptance.map((x) => `- ${x}`)].join("\n");
  return ["<brief>", mask(body), "</brief>", "<fallback>", JSON.stringify({ file: "accept.py", content: FALLBACK_CHECK }), "</fallback>"].join("\n");
}

/** {file, content} from the reply, or a reason it is refused. A fenced ```json block is accepted. */
export function parseCheckReply(reply: string): { file: CheckFile; content: string } | { reason: string } {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(reply);
  let v: unknown;
  try {
    v = JSON.parse((fenced?.[1] ?? reply).trim());
  } catch {
    return { reason: "the check writer did not reply with JSON" };
  }
  if (typeof v !== "object" || v === null) return { reason: "the reply is not an object" };
  const { file, content } = v as Record<string, unknown>;
  if (typeof file !== "string" || !(CHECK_FILES as readonly string[]).includes(file)) return { reason: `file must be one of ${CHECK_FILES.join(", ")}` };
  if (typeof content !== "string" || content.trim() === "") return { reason: "the check script is empty" };
  if (Buffer.byteLength(content, "utf8") > MAX_CHECK_BYTES) return { reason: `the check script is over ${MAX_CHECK_BYTES} bytes` };
  if (content.includes("\u0000")) return { reason: "the check script has a NUL byte" };
  return { file: file as CheckFile, content };
}

export const checksDir = (home: string, briefId: string) => join(solutionsDir(home), briefId, "checks");

export function readChecks(home: string, briefId: string): { set: CheckSet; content: string } | null {
  const p = join(checksDir(home, briefId), "checks.json");
  if (!existsSync(p)) return null;
  const set = JSON.parse(readFileSync(p, "utf8")) as CheckSet;
  const sp = join(checksDir(home, briefId), set.file);
  return existsSync(sp) ? { set, content: readFileSync(sp, "utf8") } : null;
}

export function renderBuildMd(b: SolutionBrief, set: CheckSet, content: string): string {
  return [
    renderBriefMd(b),
    "## Acceptance check script (frozen before the build)",
    `File: ${set.file} · sha256: ${set.sha256} · written by: ${set.model}`,
    `Approve the build for brief ${b.hash} and check ${set.sha256}. The builder cannot change this file; a change fails the run.`,
    "",
    "```" + (set.file.endsWith(".py") ? "python" : "ts"),
    content.trimEnd(),
    "```",
    "",
  ].join("\n");
}

/** Writes the check script for a brief (replacing an earlier one, which voids any build approval of it). */
export async function writeChecks(o: { home: string; briefId: string; model: Model; models: ModelConfig; modelLabel: string; mask?: Mask; now: number }): Promise<{ set: CheckSet; content: string; buildMd: string }> {
  const b = readBrief(o.home, o.briefId);
  if (b === null) throw new BriefError(`no brief ${o.briefId}`, "not_found");
  const reply = await o.model.complete({ role: "build_checks", model: modelFor("build_checks", o.models), system: CHECK_WRITER_SYSTEM, prompt: checkWriterPrompt(b, o.mask), maxTokens: 6000 });
  const parsed = parseCheckReply(reply);
  if ("reason" in parsed) throw new BriefError(`check script refused: ${parsed.reason}`, "conflict");
  const set: CheckSet = { version: 1, briefId: b.id, briefHash: b.hash, file: parsed.file, sha256: checkSha(parsed.content), model: o.modelLabel, createdAt: o.now };
  const dir = checksDir(o.home, b.id);
  ensureDir(dir);
  for (const f of CHECK_FILES) if (f !== set.file && existsSync(join(dir, f))) writePrivate(join(dir, f), "");
  writePrivate(join(dir, set.file), parsed.content);
  writePrivate(join(dir, "checks.json"), JSON.stringify(set, null, 2) + "\n");
  const buildMd = renderBuildMd(b, set, parsed.content);
  writePrivate(join(solutionsDir(o.home), b.id, "BUILD.md"), buildMd);
  return { set, content: parsed.content, buildMd };
}
