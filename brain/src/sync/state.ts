// Sync state on disk: $OFFLOAD_HOME/sync/state.json (0600, atomic writes). Ids, counters and flags only, no content
// and no secret: the device keys are brain keys (sync/keys.ts) and the access token lives in memory only.
// `seq` is the last sequence number USED: it is written before an envelope goes out, so a crash or restart can never
// reuse one (replay protection, ADR 0103 §3). `known` remembers object ids already queued or sent (8 days); `digests`
// the last queued form of each run outcome, so a run that progresses is sent again under its id.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalAck } from "./consent.ts";
import type { Binding } from "./types.ts";

export interface SyncState {
  version: 1;
  controlUrl: string | null;
  deviceId: string | null;
  personId: string | null;
  tenantId: string | null;
  enrolledAt: number | null;
  seq: number;
  paused: boolean;
  revoked: boolean;
  acks: LocalAck[];
  /** Local workflow id -> company workflow id + version (role workflows, promoted proposals). */
  bindings: Record<string, Binding>;
  known: Record<string, number>;
  /** Run outcome id -> sha256 of the JCS of the copy last queued: a changed run is queued again (ADR 0111 §4). */
  digests: Record<string, string>;
  failures: number;
  lastFlushAt: number | null;
  nextFlushAt: number | null;
  lastError: string | null;
}

export const syncDir = (home: string) => join(home, "sync");
export const statePath = (home: string) => join(syncDir(home), "state.json");
export const KNOWN_KEEP_MS = 8 * 86_400_000;

export const emptyState = (): SyncState => ({ version: 1, controlUrl: null, deviceId: null, personId: null, tenantId: null, enrolledAt: null, seq: 0, paused: false, revoked: false, acks: [], bindings: {}, known: {}, digests: {}, failures: 0, lastFlushAt: null, nextFlushAt: null, lastError: null });

export function readState(home: string): SyncState {
  if (!existsSync(statePath(home))) return emptyState();
  try {
    const v = JSON.parse(readFileSync(statePath(home), "utf8")) as Partial<SyncState>;
    return { ...emptyState(), ...v, version: 1 };
  } catch {
    // An unreadable state must not reset seq to 0 silently: refuse to sync until it is repaired.
    throw new Error(`sync state ${statePath(home)} is not readable JSON`);
  }
}

export function writeState(home: string, s: SyncState, now: number): void {
  for (const [id, at] of Object.entries(s.known)) if (now - at > KNOWN_KEEP_MS) delete s.known[id];
  for (const id of Object.keys(s.digests)) if (s.known[id] === undefined) delete s.digests[id];
  mkdirSync(syncDir(home), { recursive: true, mode: 0o700 });
  const p = statePath(home);
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}
