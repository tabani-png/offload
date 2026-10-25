// Brain artefacts that hold OCR or mail text (REVIEW-1 H4): dry runs, dry-run batches, the tone corpus and the
// blind-test files. They are sealed with a per-day brain key, the same scheme as the observer's OFFLOAD_KEYS=file
// mode (docs/store-contract.md): AES-256-GCM lines, one raw 32-byte key per local day in
// $OFFLOAD_HOME/brain-keys/YYYY-MM-DD.key (0600, folder 0700). Deleting a day = delete its key AND its artefacts.
//
// Why not the Keychain: only the observer holds the Keychain master key and it has no command that wraps a brain key
// (engine/ is out of this slice). Raw key files give crypto-shredding (a purged key makes every leftover copy, backup
// or Time Machine snapshot of its artefacts unreadable) but do not protect against another process running as the
// same user. That is the same trade-off as OFFLOAD_KEYS=file; see slices/s05b-gate-hardening/SPEC.md.
//
// Sealed file: line 1 "OBV1 YYYY-MM-DD", line 2 the encrypted text (crypto.ts line format).
// Purge (startup and hourly, see startPurgeSchedule): days older than 7 local days lose their key and artefacts, and a
// line goes to $OFFLOAD_HOME/purge-log.jsonl {day, deletedAt, events: 0, files, by: "brain"}. Readers refuse an
// expired artefact even before the purge ran.
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptLine, encryptLine, generateKey, KEY_BYTES } from "./crypto.ts";

export const KEEP_DAYS = 7;
export const PURGE_INTERVAL_MS = 3_600_000;
const MAGIC = "OBV1";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar day of a timestamp, YYYY-MM-DD. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole local days from `day` to the day of `now` (0 = today). null for a malformed label. */
export function dayAge(day: string, now: number): number | null {
  if (!DAY_RE.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const then = new Date(y, m - 1, d).getTime();
  const t = new Date(now);
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  return Math.round((today - then) / 86_400_000);
}

/** Older than KEEP_DAYS local days: today and the 7 days before it are kept (same rule as the observer). */
export const isExpired = (day: string, now: number) => {
  const age = dayAge(day, now);
  return age === null || age > KEEP_DAYS;
};

export const brainKeysDir = (home: string) => join(home, "brain-keys");
export const brainKeyPath = (home: string, at: number | string) => join(brainKeysDir(home), `${typeof at === "number" ? localDay(at) : at}.key`);

function writeAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function keyFor(home: string, day: string, create: boolean): Buffer | null {
  const p = brainKeyPath(home, day);
  if (existsSync(p)) {
    const k = readFileSync(p);
    return k.length === KEY_BYTES ? k : null;
  }
  if (!create) return null;
  mkdirSync(brainKeysDir(home), { recursive: true, mode: 0o700 });
  chmodSync(brainKeysDir(home), 0o700);
  // Create-if-absent, atomically: a key that already exists is never replaced (that would orphan its artefacts).
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, generateKey(), { mode: 0o600 });
  try {
    linkSync(tmp, p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return readFileSync(p);
}

/** Writes `text` sealed under the key of the local day of `at` (0600, atomic). */
export function sealText(home: string, path: string, text: string, at: number): void {
  const day = localDay(at);
  const key = keyFor(home, day, true)!;
  writeAtomic(path, `${MAGIC} ${day}\n${encryptLine(key, text)}\n`);
}

/** The day a sealed file belongs to, or null when it is not a sealed file. */
export function sealedDay(path: string): string | null {
  try {
    const head = readFileSync(path, "utf8").slice(0, 32).split("\n")[0] ?? "";
    const m = /^OBV1 (\d{4}-\d{2}-\d{2})$/.exec(head);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Plain text of a sealed file; null when missing, expired (then it is deleted), unsealed or undecryptable. */
export function openText(home: string, path: string, now: number): string | null {
  if (!existsSync(path)) return null;
  const [head, body] = readFileSync(path, "utf8").split("\n");
  const m = /^OBV1 (\d{4}-\d{2}-\d{2})$/.exec(head ?? "");
  if (m?.[1] === undefined || body === undefined) return null;
  if (isExpired(m[1], now)) {
    rmSync(path, { force: true });
    return null;
  }
  const key = keyFor(home, m[1], false);
  if (key === null) return null;
  try {
    return decryptLine(key, body);
  } catch {
    return null;
  }
}

// ---------- purge ----------

export interface PurgeResult {
  /** Artefact files deleted (expired, or debris whose key is gone). */
  files: number;
  /** Day keys deleted. */
  keys: number;
  /** Legacy plaintext files sealed in place. */
  sealed: number;
  days: string[];
}

const SEALED_SUFFIX = ".enc";

/** Every place a brain artefact with OCR or mail text can live. Plain = written before s05b. */
function artefacts(home: string): Array<{ path: string; plain: boolean; dryRunBatch?: boolean }> {
  const out: Array<{ path: string; plain: boolean; dryRunBatch?: boolean }> = [];
  const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
  const wfRoot = join(home, "workflows");
  for (const id of ls(wfRoot)) {
    if (!/^wf_[a-z0-9]{4,40}$/.test(id)) continue;
    const dir = join(wfRoot, id);
    for (const n of ["dry-run.json", "dry-run.json.enc"]) if (existsSync(join(dir, n))) out.push({ path: join(dir, n), plain: !n.endsWith(SEALED_SUFFIX) });
    for (const n of ls(join(dir, "dry-runs"))) if (/^\d+\.json(\.enc)?$/.test(n)) out.push({ path: join(dir, "dry-runs", n), plain: !n.endsWith(SEALED_SUFFIX) });
    for (const n of ls(join(dir, "batches"))) {
      if (/^[0-9a-f]{64}\.json\.enc$/.test(n)) out.push({ path: join(dir, "batches", n), plain: false });
      else if (/^[0-9a-f]{64}\.json$/.test(n)) {
        // Only dry-run batches carry OCR-parsed recipients and subjects; live batches are the send record.
        try {
          if ((JSON.parse(readFileSync(join(dir, "batches", n), "utf8")) as { kind?: string }).kind === "dry_run") out.push({ path: join(dir, "batches", n), plain: true, dryRunBatch: true });
        } catch {
          // Not JSON: not ours to judge.
        }
      }
    }
  }
  const tone = join(home, "tone");
  for (const n of ["corpus.jsonl", "corpus.jsonl.enc"]) if (existsSync(join(tone, n))) out.push({ path: join(tone, n), plain: !n.endsWith(SEALED_SUFFIX) });
  for (const run of ls(join(tone, "blind-test"))) {
    for (const n of ls(join(tone, "blind-test", run))) if (/^(pairs\.md|key\.json)(\.enc)?$/.test(n)) out.push({ path: join(tone, "blind-test", run, n), plain: !n.endsWith(SEALED_SUFFIX) });
  }
  return out;
}

export interface PurgeOptions {
  log?: (line: string) => void;
}

/** Deletes expired brain keys and artefacts, seals legacy plaintext ones, and logs what it did. */
export function purgeExpired(home: string, now: number, opts: PurgeOptions = {}): PurgeResult {
  const res: PurgeResult = { files: 0, keys: 0, sealed: 0, days: [] };
  const perDay = new Map<string, number>();
  const gone = (day: string) => perDay.set(day, (perDay.get(day) ?? 0) + 1);

  for (const a of artefacts(home)) {
    if (a.plain) {
      const mday = localDay(statSync(a.path).mtimeMs);
      if (isExpired(mday, now)) {
        rmSync(a.path, { force: true });
        res.files += 1;
        gone(mday);
      } else {
        const text = readFileSync(a.path, "utf8");
        const target = a.path + SEALED_SUFFIX;
        sealText(home, target, text, statSync(a.path).mtimeMs);
        rmSync(a.path, { force: true });
        res.sealed += 1;
      }
      continue;
    }
    const day = sealedDay(a.path);
    if (day === null || isExpired(day, now) || keyFor(home, day, false) === null) {
      rmSync(a.path, { force: true });
      res.files += 1;
      gone(day ?? "unknown");
    }
  }
  const kdir = brainKeysDir(home);
  if (existsSync(kdir)) {
    for (const n of readdirSync(kdir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.key$/.exec(n);
      if (m?.[1] === undefined || !isExpired(m[1], now)) continue;
      rmSync(join(kdir, n), { force: true });
      res.keys += 1;
      perDay.set(m[1], perDay.get(m[1]) ?? 0);
    }
  }
  // Empty blind-test run folders go too.
  const blind = join(home, "tone", "blind-test");
  if (existsSync(blind)) for (const run of readdirSync(blind)) if (readdirSync(join(blind, run)).length === 0) rmdirSync(join(blind, run));

  res.days = [...perDay.keys()].sort();
  for (const day of res.days) {
    appendFileSync(join(home, "purge-log.jsonl"), JSON.stringify({ day, deletedAt: now, events: 0, files: perDay.get(day) ?? 0, by: "brain" }) + "\n", { mode: 0o600 });
  }
  if (res.files + res.keys + res.sealed > 0) {
    (opts.log ?? console.log)(`brain: purge removed ${res.files} artefact(s) and ${res.keys} key(s) older than ${KEEP_DAYS} days${res.days.length > 0 ? ` (${res.days.join(", ")})` : ""}; sealed ${res.sealed} plaintext file(s)`);
  }
  return res;
}

export interface ScheduleDeps {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (t: unknown) => void;
  log: (line: string) => void;
}

/** Purges now and every hour. Returns a stop function. Errors are logged, never thrown into the timer. */
export function startPurgeSchedule(home: string, now: () => number, deps: Partial<ScheduleDeps> = {}): () => void {
  const log = deps.log ?? ((l: string) => console.log(l));
  const run = () => {
    try {
      purgeExpired(home, now(), { log });
    } catch (err) {
      log(`brain: purge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  run();
  if (deps.setInterval !== undefined) {
    const t = deps.setInterval(run, PURGE_INTERVAL_MS);
    return () => (deps.clearInterval ?? (() => {}))(t);
  }
  const t = setInterval(run, PURGE_INTERVAL_MS);
  t.unref?.();
  return () => clearInterval(t);
}
