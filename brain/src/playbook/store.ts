// $OFFLOAD_HOME/workflows/<id>/playbook.json + PLAYBOOK.md (0600). Plain files: a playbook holds no mail text and no
// personal detail (leak.ts checks every write). Notes are the user's; every write bumps the version.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, workflowDir, writePrivate } from "../workflows/store.ts";
import { assertDepersonalised } from "./leak.ts";
import type { Identity } from "./mask.ts";
import { renderPlaybookMd } from "./render.ts";
import { MAX_NOTES_CHARS, PLAYBOOK_SCHEMA, type Playbook } from "./types.ts";

export const PLAYBOOK_FILE = "playbook.json";
export const PLAYBOOK_MD = "PLAYBOOK.md";
export const playbookPath = (home: string, id: string) => join(workflowDir(home, id), PLAYBOOK_FILE);

export class PlaybookNotesError extends Error {}

export function readPlaybook(home: string, id: string): Playbook | null {
  const p = playbookPath(home, id);
  if (!existsSync(p)) return null;
  const pb = JSON.parse(readFileSync(p, "utf8")) as Playbook;
  return pb.schema === PLAYBOOK_SCHEMA ? pb : null;
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
