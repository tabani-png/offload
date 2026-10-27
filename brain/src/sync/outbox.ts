// The local outbox (ADR 0103 §2 G5, §4): objects waiting to be sent, sealed with the brain day keys (`brain-YYYY-MM-DD`
// of the day they were queued; store/vault.ts sealed-file format, so no plaintext JSON on disk), one file per day in
// $OFFLOAD_HOME/sync/outbox/DAY.json.enc. Objects older than 30 days are dropped with a purge-log line (same rule as
// the brain store): the purge (store/retention.ts) deletes expired day files, and the reader refuses them before that.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isExpired, localDay, openText, sealText } from "../store/vault.ts";
import type { ObserverEnv } from "../store/observer.ts";
import type { SyncKind, SyncObject } from "./types.ts";

export interface OutboxEntry {
  id: string;
  kind: SyncKind;
  object: SyncObject;
  queuedAt: number;
  /** G4: set when the user confirmed a proposal on its preview. */
  confirmedAt?: number;
  attempts: number;
  /** Retry not before (a retryable rejection). */
  notBefore?: number;
}

export const outboxDir = (home: string) => join(home, "sync", "outbox");
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json\.enc$/;

export class Outbox {
  constructor(
    private readonly home: string,
    private readonly env: ObserverEnv = process.env,
  ) {}

  /** Every live entry in send order: notice acks first (the server checks consent against them, ADR 0103 §2), then
   * oldest first (queuedAt, then id). */
  list(now: number): OutboxEntry[] {
    const dir = outboxDir(this.home);
    if (!existsSync(dir)) return [];
    const out: OutboxEntry[] = [];
    for (const n of readdirSync(dir).sort()) {
      const day = FILE_RE.exec(n)?.[1];
      if (day === undefined || isExpired(day, now)) continue;
      const text = openText(this.home, join(dir, n), now, this.env);
      if (text === null) continue;
      try {
        out.push(...(JSON.parse(text) as OutboxEntry[]));
      } catch {
        // A damaged file is skipped; the purge removes it after 30 days.
      }
    }
    const rank = (e: OutboxEntry) => (e.kind === "notice_ack" ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b) || a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Rewrites the outbox as `entries` (grouped by the local day they were queued). */
  private save(entries: readonly OutboxEntry[], now: number): void {
    const dir = outboxDir(this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const byDay = new Map<string, OutboxEntry[]>();
    for (const e of entries) {
      const d = localDay(e.queuedAt);
      if (isExpired(d, now)) continue;
      byDay.set(d, [...(byDay.get(d) ?? []), e]);
    }
    for (const n of readdirSync(dir)) {
      const day = FILE_RE.exec(n)?.[1];
      if (day !== undefined && !byDay.has(day)) rmSync(join(dir, n), { force: true });
    }
    for (const [day, list] of byDay) sealText(this.home, join(dir, `${day}.json.enc`), JSON.stringify(list), day, this.env);
  }

  add(entries: readonly OutboxEntry[], now: number): void {
    if (entries.length === 0) return;
    const cur = this.list(now);
    const ids = new Set(cur.map((e) => e.id));
    this.save([...cur, ...entries.filter((e) => !ids.has(e.id))], now);
  }

  /** Adds entries, replacing a queued entry with the same id (a newer form of the same object). */
  put(entries: readonly OutboxEntry[], now: number): void {
    if (entries.length === 0) return;
    const ids = new Set(entries.map((e) => e.id));
    this.save([...this.list(now).filter((e) => !ids.has(e.id)), ...entries], now);
  }

  /** Applies `change` to the whole list and writes the result. */
  update(now: number, change: (entries: OutboxEntry[]) => OutboxEntry[]): OutboxEntry[] {
    const next = change(this.list(now));
    this.save(next, now);
    return next;
  }
}

/** Retention: outbox day files past 30 days are deleted with a purge-log line {day, deletedAt, events: 0, files, by}. */
export function purgeOutbox(home: string, now: number): { files: number; days: string[] } {
  const dir = outboxDir(home);
  if (!existsSync(dir)) return { files: 0, days: [] };
  const perDay = new Map<string, number>();
  for (const n of readdirSync(dir)) {
    const day = FILE_RE.exec(n)?.[1];
    if (day !== undefined && !isExpired(day, now)) continue;
    rmSync(join(dir, n), { force: true });
    perDay.set(day ?? "unknown", (perDay.get(day ?? "unknown") ?? 0) + 1);
  }
  const days = [...perDay.keys()].sort();
  for (const day of days) appendFileSync(join(home, "purge-log.jsonl"), JSON.stringify({ day, deletedAt: now, events: 0, files: perDay.get(day) ?? 0, by: "sync-outbox" }) + "\n", { mode: 0o600 });
  return { files: days.reduce((n, d) => n + (perDay.get(d) ?? 0), 0), days };
}
