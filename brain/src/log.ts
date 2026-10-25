// Brain logs (REVIEW-2 section 3): never content, and bounded.
// - Every line is scrubbed: addresses become <address>, double-quoted text becomes "…", control and format characters
//   go, and a line is at most MAX_LINE chars. Errors are logged as `Name: message` (scrubbed) plus at most 3 stack
//   frames (code locations only). Our own messages name ids, files and counts, never recipients, drafts or OCR.
// - Files rotate at LOG_MAX_BYTES and keep LOG_KEEP old ones (path.1, path.2): the brain log (`serve --log-file`),
//   gate-log.jsonl and purge-log.jsonl.
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 2;
const MAX_LINE = 500;

const EMAIL_RE = /[^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[A-Za-z]{2,}/g;
const QUOTED_RE = /"(?:[^"\\\n]|\\.)*"/g;
// Control characters except tab, plus Unicode format characters (bidi, zero-width).
const CONTROL_RE = /[\u0000-\u0008\u000A-\u001F\u007F]|\p{Cf}/gu;

/** Removes content from a log text: addresses, quoted strings, control and format characters; caps the length. */
export function scrubLogText(s: string): string {
  const out = s.replace(CONTROL_RE, " ").replace(EMAIL_RE, "<address>").replace(QUOTED_RE, '"…"');
  return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE - 1)}…` : out;
}

/** One log argument as scrubbed text. */
export function formatLogArg(a: unknown): string {
  if (a instanceof Error) {
    const frames = (a.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 3).map((l) => l.trim());
    return scrubLogText(`${a.name}: ${a.message}`) + (frames.length > 0 ? ` (${frames.map(scrubLogText).join(" < ")})` : "");
  }
  if (typeof a === "string") return scrubLogText(a);
  try {
    return scrubLogText(typeof a === "object" ? JSON.stringify(a) : String(a));
  } catch {
    return "[unprintable]";
  }
}

/** Renames path -> path.1 -> path.2 when path is at least `max` bytes; the oldest beyond `keep` is deleted. */
export function rotateIfLarge(path: string, max: number = LOG_MAX_BYTES, keep: number = LOG_KEEP): boolean {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return false;
  }
  if (size < max) return false;
  rmSync(`${path}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  renameSync(path, `${path}.1`);
  return true;
}

/** Appends one line (rotating first when the file is full). 0600. */
export function appendLogLine(path: string, line: string): void {
  rotateIfLarge(path);
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, { mode: 0o600 });
}

/**
 * Routes console.error and console.warn through the scrubber: to `file` (rotated) when given, else to stderr.
 * Returns a function that restores the previous console methods.
 */
export function installBrainLogging(opts: { file?: string } = {}): () => void {
  const prev = { error: console.error, warn: console.warn };
  const write = (...args: unknown[]) => {
    const line = `${new Date().toISOString()} ${args.map(formatLogArg).join(" ")}`;
    if (opts.file === undefined) {
      process.stderr.write(line + "\n");
      return;
    }
    try {
      appendLogLine(opts.file, line);
    } catch {
      process.stderr.write(line + "\n");
    }
  };
  if (opts.file !== undefined) rotateIfLarge(opts.file);
  console.error = write;
  console.warn = write;
  return () => {
    console.error = prev.error;
    console.warn = prev.warn;
  };
}
