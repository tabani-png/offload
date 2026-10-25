// Evidence refs (ADR 0103 §1): instanceRef = hex(HMAC-SHA256(deviceEvidenceKey, localInstanceId))[0:32]. The key is
// the brain key `device-evidence` (observer-wrapped; raw file under OFFLOAD_KEYS=file) and never leaves this Mac, so
// the control plane can count and sum refs but cannot resolve or correlate them across devices. The local map
// ref -> instance is sealed per capture day with the brain day key (`brain-YYYY-MM-DD`) and follows the 7-day rule:
// a ref of an instance older than 7 days no longer resolves, like the instance itself.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hmacHex, ulidFrom } from "./encoding.ts";
import { DEVICE_EVIDENCE, syncKey } from "./keys.ts";
import { isExpired, openText, sealText } from "../store/vault.ts";
import type { ObserverEnv } from "../store/observer.ts";
import type { IdMaker } from "./types.ts";

export const refsDir = (home: string) => join(home, "sync", "refs");
const refsPath = (home: string, day: string) => join(refsDir(home), `${day}.json.enc`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RefTarget {
  instanceId: string;
  day: string;
}

export class EvidenceKey {
  private constructor(
    private readonly home: string,
    private readonly key: Uint8Array,
    private readonly env: ObserverEnv,
  ) {}

  /** The device's evidence key (created on first use when `create`). */
  static load(home: string, opts: { create: boolean; env?: ObserverEnv }): EvidenceKey | null {
    const k = syncKey(home, DEVICE_EVIDENCE, opts);
    return k === null ? null : new EvidenceKey(home, k, opts.env ?? process.env);
  }

  /** For tests: an evidence key from given bytes. */
  static fromBytes(home: string, key: Uint8Array, env: ObserverEnv = process.env): EvidenceKey {
    return new EvidenceKey(home, key, env);
  }

  ref(localInstanceId: string): string {
    return hmacHex(this.key, localInstanceId).slice(0, 32);
  }

  /** Deterministic object ids keyed on this device's secret: the server cannot link them to local data. */
  readonly ids: IdMaker = (kind, naturalKey, ts) => ulidFrom(this.key, `${kind}\u0000${naturalKey}`, Math.max(0, Math.floor(ts)));

  /** Refs for instances, remembered locally (sealed under each instance's capture day) so self-view can resolve them. */
  remember(instances: readonly RefTarget[], now: number): Map<string, string> {
    const out = new Map<string, string>();
    const byDay = new Map<string, Record<string, string>>();
    for (const i of instances) {
      if (!DAY_RE.test(i.day) || isExpired(i.day, now)) continue;
      const r = this.ref(i.instanceId);
      out.set(i.instanceId, r);
      let m = byDay.get(i.day);
      if (m === undefined) byDay.set(i.day, (m = this.readDay(i.day, now)));
      m[r] = i.instanceId;
    }
    mkdirSync(refsDir(this.home), { recursive: true, mode: 0o700 });
    for (const [day, m] of byDay) sealText(this.home, refsPath(this.home, day), JSON.stringify(m), day, this.env);
    return out;
  }

  private readDay(day: string, now: number): Record<string, string> {
    const t = openText(this.home, refsPath(this.home, day), now, this.env);
    if (t === null) return {};
    try {
      return JSON.parse(t) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** The local instance behind a ref, or null (unknown here, from another device, or past 7 days). */
  resolve(ref: string, now: number): RefTarget | null {
    if (!/^[0-9a-f]{32}$/.test(ref) || !existsSync(refsDir(this.home))) return null;
    for (const n of readdirSync(refsDir(this.home))) {
      const day = /^(\d{4}-\d{2}-\d{2})\.json\.enc$/.exec(n)?.[1];
      if (day === undefined || isExpired(day, now)) continue;
      const id = this.readDay(day, now)[ref];
      if (id !== undefined && this.ref(id) === ref) return { instanceId: id, day };
    }
    return null;
  }
}

/** Retention: ref maps of expired days are deleted (store/retention.ts). Returns the days removed. */
export function purgeRefs(home: string, now: number): string[] {
  if (!existsSync(refsDir(home))) return [];
  const gone: string[] = [];
  for (const n of readdirSync(refsDir(home))) {
    const day = /^(\d{4}-\d{2}-\d{2})\.json\.enc$/.exec(n)?.[1];
    if (day === undefined || isExpired(day, now)) {
      rmSync(join(refsDir(home), n), { force: true });
      gone.push(day ?? "unknown");
    }
  }
  return gone;
}
