// Reads the observer store (docs/store-contract.md). Plain `.jsonl` and encrypted `.jsonl.enc` are both supported.
// Bad lines are never dropped silently: each one is returned with its file, line number and reason.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DayLabel, OffloadEvent } from "../types.ts";
import { decryptLine, KEY_BYTES, LineCryptoError } from "./crypto.ts";
import { validateEvent } from "./schema.ts";

export type BadLineReason = "invalid_base64" | "decrypt_failed" | "invalid_json" | "schema_invalid" | "duplicate_id";

export interface BadLine {
  day: DayLabel;
  file: string;
  /** 1-based line number in the file. */
  line: number;
  reason: BadLineReason;
  detail: string;
}

export type DaySource = "plain" | "encrypted" | "both";

export interface DayRead {
  day: DayLabel;
  source: DaySource;
  files: string[];
  events: OffloadEvent[];
  bad: BadLine[];
  totalLines: number;
  blankLines: number;
  /** Day-level problems (e.g. missing key). The affected lines are also in `bad`. */
  errors: string[];
}

export interface StoreRead {
  home: string;
  days: DayRead[];
  eventCount: number;
  badLineCount: number;
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.enc)?$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function daysDir(home: string): string {
  return join(home, "days");
}

export function keyPath(home: string, day: DayLabel): string {
  return join(home, "keys", `${day}.key`);
}

export function listDays(home: string): DayLabel[] {
  const dir = daysDir(home);
  if (!existsSync(dir)) return [];
  const days = new Set<DayLabel>();
  for (const name of readdirSync(dir)) {
    const m = DAY_FILE_RE.exec(name);
    if (m?.[1] !== undefined) days.add(m[1]);
  }
  return [...days].sort();
}

/** Fingerprint of the day files (name, size, mtime) so callers can cache analysis until the store changes. */
export function storeFingerprint(home: string): string {
  const dir = daysDir(home);
  if (!existsSync(dir)) return "empty";
  return readdirSync(dir)
    .filter((n) => DAY_FILE_RE.test(n))
    .sort()
    .map((n) => {
      const st = statSync(join(dir, n));
      return `${n}:${st.size}:${st.mtimeMs}`;
    })
    .join("|");
}

function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface LineSink {
  day: DayLabel;
  seen: Set<string>;
  events: OffloadEvent[];
  bad: BadLine[];
}

function acceptJson(sink: LineSink, file: string, lineNo: number, json: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    sink.bad.push({ day: sink.day, file, line: lineNo, reason: "invalid_json", detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  const result = validateEvent(parsed);
  if (!result.ok) {
    sink.bad.push({ day: sink.day, file, line: lineNo, reason: "schema_invalid", detail: result.error });
    return;
  }
  if (sink.seen.has(result.event.id)) {
    sink.bad.push({ day: sink.day, file, line: lineNo, reason: "duplicate_id", detail: `id ${result.event.id} already read` });
    return;
  }
  sink.seen.add(result.event.id);
  sink.events.push(result.event);
}

function loadKey(home: string, day: DayLabel): { key: Buffer } | { error: string } {
  const path = keyPath(home, day);
  if (!existsSync(path)) return { error: `key file missing: ${path}` };
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) return { error: `key file ${path} is ${key.length} bytes, expected ${KEY_BYTES}` };
  return { key };
}

export function readDay(home: string, day: DayLabel): DayRead {
  const plain = join(daysDir(home), `${day}.jsonl`);
  const enc = join(daysDir(home), `${day}.jsonl.enc`);
  const hasPlain = existsSync(plain);
  const hasEnc = existsSync(enc);
  const sink: LineSink = { day, seen: new Set(), events: [], bad: [] };
  const result: DayRead = {
    day,
    source: hasPlain && hasEnc ? "both" : hasEnc ? "encrypted" : "plain",
    files: [],
    events: sink.events,
    bad: sink.bad,
    totalLines: 0,
    blankLines: 0,
    errors: [],
  };

  if (hasEnc) {
    result.files.push(enc);
    const lines = splitLines(readFileSync(enc, "utf8"));
    const loaded = loadKey(home, day);
    if ("error" in loaded) result.errors.push(loaded.error);
    lines.forEach((line, i) => {
      result.totalLines += 1;
      if (line.trim() === "") {
        result.blankLines += 1;
        return;
      }
      if ("error" in loaded) {
        sink.bad.push({ day, file: enc, line: i + 1, reason: "decrypt_failed", detail: loaded.error });
        return;
      }
      let json: string;
      try {
        json = decryptLine(loaded.key, line);
      } catch (err) {
        if (!(err instanceof LineCryptoError)) throw err;
        sink.bad.push({ day, file: enc, line: i + 1, reason: err.reason === "invalid_base64" ? "invalid_base64" : "decrypt_failed", detail: err.message });
        return;
      }
      acceptJson(sink, enc, i + 1, json);
    });
  }

  if (hasPlain) {
    result.files.push(plain);
    splitLines(readFileSync(plain, "utf8")).forEach((line, i) => {
      result.totalLines += 1;
      if (line.trim() === "") {
        result.blankLines += 1;
        return;
      }
      acceptJson(sink, plain, i + 1, line);
    });
  }

  sink.events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return result;
}

export function readStore(home: string, opts: { windowDays?: number } = {}): StoreRead {
  const window = opts.windowDays ?? 7;
  const days = listDays(home).slice(-window).map((d) => readDay(home, d));
  return {
    home,
    days,
    eventCount: days.reduce((n, d) => n + d.events.length, 0),
    badLineCount: days.reduce((n, d) => n + d.bad.length, 0),
  };
}
