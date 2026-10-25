// Calls into the observer binary (`offload-observer`): the only process that holds the Keychain master key.
// Used for wrapped day keys (export-day, reader.ts), brain keys (wrap-key / unwrap-key, vault.ts) and GET /observer.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ObserverEnv = Readonly<Record<string, string | undefined>>;

/** engine/.build/offload-observer next to this repo's brain/, unless OFFLOAD_OBSERVER_BIN says otherwise. */
export function observerBin(env: ObserverEnv): string {
  const given = env.OFFLOAD_OBSERVER_BIN;
  if (given !== undefined && given !== "") return given;
  return fileURLToPath(new URL("../../../engine/.build/offload-observer", import.meta.url));
}

/** process.env overlaid with `env`, OFFLOAD_HOME set to `home`. */
export function observerChildEnv(home: string, env: ObserverEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  out.OFFLOAD_HOME = home;
  return out;
}

export const missingBinMessage = (bin: string, what: string) => `${what} needs the observer, but ${bin} does not exist (build the engine or set OFFLOAD_OBSERVER_BIN)`;

export interface ObserverRun {
  ok: boolean;
  stdout: string;
  /** Why it failed; never contains stdout (which may carry a key). */
  error: string;
}

/** Runs `bin args… --home HOME` synchronously with `input` on stdin. */
export function runObserverSync(home: string, args: readonly string[], env: ObserverEnv, opts: { input?: string; timeoutMs?: number; drop?: readonly string[] } = {}): ObserverRun {
  const bin = observerBin(env);
  const what = `${args[0] ?? "observer"}`;
  if (!existsSync(bin)) return { ok: false, stdout: "", error: missingBinMessage(bin, what) };
  const childEnv = observerChildEnv(home, env);
  for (const k of opts.drop ?? []) delete childEnv[k];
  const r = spawnSync(bin, [...args, "--home", home], { env: childEnv, input: opts.input ?? "", encoding: "utf8", timeout: opts.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024 });
  if (r.error !== undefined) return { ok: false, stdout: "", error: `${bin} ${what} failed: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, stdout: "", error: `${bin} ${what} exited ${r.status ?? r.signal}: ${(r.stderr ?? "").trim().slice(0, 300)}` };
  return { ok: true, stdout: r.stdout ?? "", error: "" };
}
