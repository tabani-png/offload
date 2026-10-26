// $OFFLOAD_HOME/workflows/<id>/playbook.json + PLAYBOOK.md (0600). Plain files: a playbook holds no mail text and no
// personal detail (leak.ts checks every write). Notes are the user's; every write bumps the version.
// playbook-identity.json (0600) keeps the build's identity set as salted hashes, so a notes edit or a promotion after
// the tone pack is gone is still checked against the names of the build. It never leaves the device.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, workflowDir, writePrivate } from "../workflows/store.ts";
import { assertDepersonalised } from "./leak.ts";
import { hashWord, type Identity, type IdentityDigest } from "./mask.ts";
import { renderPlaybookMd } from "./render.ts";
import { MAX_NOTES_CHARS, PLAYBOOK_SCHEMA, type Playbook } from "./types.ts";

export const PLAYBOOK_FILE = "playbook.json";
export const PLAYBOOK_MD = "PLAYBOOK.md";
export const IDENTITY_FILE = "playbook-identity.json";
const IDENTITY_SCHEMA = "offload.playbook-identity.v1";
export const CORRUPT_PLAYBOOK_WARNING = "playbook.json could not be read; drafting without the playbook (rebuild it)";
export const playbookPath = (home: string, id: string) => join(workflowDir(home, id), PLAYBOOK_FILE);

export class PlaybookNotesError extends Error {}

/** The workflow's playbook, or null. A file that does not parse reads as no playbook with a warning (pushed to
 * `warnings`, else logged), so a dry run or a run drafts without it instead of failing. */
export function readPlaybook(home: string, id: string, warnings?: string[]): Playbook | null {
  const p = playbookPath(home, id);
  if (!existsSync(p)) return null;
  let pb: unknown;
  try {
    pb = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    pb = null;
  }
  if (typeof pb !== "object" || pb === null || Array.isArray(pb)) {
    if (warnings === undefined) console.error(`brain: workflow ${id}: ${CORRUPT_PLAYBOOK_WARNING}`);
    else warnings.push(CORRUPT_PLAYBOOK_WARNING);
    return null;
  }
  return (pb as Playbook).schema === PLAYBOOK_SCHEMA ? (pb as Playbook) : null;
}

/** The build's identity set as salted hashes (a fresh salt per build). */
export function writeIdentityDigest(home: string, id: string, identity: Identity): void {
  const salt = randomBytes(16).toString("hex");
  const h = (xs: Iterable<string>) => [...new Set([...xs].map((w) => hashWord(salt, w)))].sort();
  const dir = workflowDir(home, id);
  ensureDir(dir);
  const digest = { schema: IDENTITY_SCHEMA, salt, author: h(identity.author), company: h(identity.company), names: h([...identity.people, ...identity.orgs, ...identity.words]) };
  writePrivate(join(dir, IDENTITY_FILE), JSON.stringify(digest) + "\n");
}

/** The identity digest of the last build, or null (none, or not readable). */
export function readIdentityDigest(home: string, id: string): IdentityDigest | null {
  const p = join(workflowDir(home, id), IDENTITY_FILE);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? new Set(v as string[]) : null);
    const [author, company, names] = [list(j.author), list(j.company), list(j.names)];
    if (j.schema !== IDENTITY_SCHEMA || typeof j.salt !== "string" || author === null || company === null || names === null) return null;
    return { salt: j.salt, author, company, names };
  } catch {
    return null;
  }
}

export function readPlaybookMd(home: string, id: string): string | null {
  const p = join(workflowDir(home, id), PLAYBOOK_MD);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function writePlaybook(home: string, pb: Playbook): void {
  const dir = workflowDir(home, pb.workflowId);
  ensureDir(dir);
  writePrivate(join(dir, PLAYBOOK_FILE), JSON.stringify(pb, null, 2) + "\n");
  writePrivate(join(dir, PLAYBOOK_MD), renderPlaybookMd(pb));
}

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** The user's notes, checked like the rest of the playbook (fail closed), as a new version. */
export function setPlaybookNotes(home: string, id: string, notes: unknown, identity: Identity, now: number): Playbook {
  if (typeof notes !== "string") throw new PlaybookNotesError("notes (a string) is required");
  if ([...notes].length > MAX_NOTES_CHARS) throw new PlaybookNotesError(`notes are at most ${MAX_NOTES_CHARS} characters`);
  if (CONTROL_RE.test(notes)) throw new PlaybookNotesError("notes have control characters");
  const prev = readPlaybook(home, id);
  if (prev === null) throw new PlaybookNotesError("build the playbook first");
  const version = prev.version + 1;
  const next: Playbook = { ...prev, notes: notes.trim(), version, history: [...prev.history, { version, at: now, change: "notes" as const }].slice(-50) };
  assertDepersonalised(next, identity);
  writePlaybook(home, next);
  return next;
}
