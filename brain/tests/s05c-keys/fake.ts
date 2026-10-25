import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Path of the fake offload-observer (wrap-key, unwrap-key, status --json) used by s05c tests. */
export const FAKE_OBSERVER = new URL("./fake-observer.sh", import.meta.url).pathname;

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * s10b N6: observer children get only PATH, HOME, OFFLOAD_HOME and OFFLOAD_KEYS, so FAKE_OBSERVER_* settings can no
 * longer travel in the environment. This writes a wrapper script (in `dir`, default a fresh temp folder) that sets
 * them and execs the fake; point OFFLOAD_OBSERVER_BIN at the returned path.
 */
export function fakeObserverWith(vars: Record<string, string | undefined>, dir: string = mkdtempSync(join(tmpdir(), "offload-fake-obs-"))): string {
  const lines = ["#!/bin/bash"];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && /^FAKE_OBSERVER_[A-Z0-9_]+$/.test(k)) lines.push(`export ${k}=${q(v)}`);
  lines.push(`exec ${q(FAKE_OBSERVER)} "$@"`);
  const p = join(dir, `fake-observer-${Math.random().toString(36).slice(2, 10)}.sh`);
  writeFileSync(p, lines.join("\n") + "\n");
  chmodSync(p, 0o755);
  return p;
}

/** The FAKE_OBSERVER_* variables currently in process.env. */
export function fakeVarsFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FAKE_OBSERVER_") && v !== undefined) out[k] = v;
  return out;
}
