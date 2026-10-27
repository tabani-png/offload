// GET /observer: `offload-observer status --json --home HOME` (schemaVersion 1) passed through, permissions included.
// Always 200: a missing binary, a non-zero exit, a timeout or output that is not a v1 status is `available: false`
// with the reason, so the UI can say what is wrong instead of failing the request.
import { existsSync } from "node:fs";
import { missingBinMessage, observerBin, observerChildEnv, type ObserverEnv } from "../store/observer.ts";
import { KEEP_DAYS } from "../store/vault.ts";
import { API_VERSION, type ObserverControlResponse, type ObserverPermissionsDTO, type ObserverResponse, type ObserverStatusDTO } from "./types.ts";

export const OBSERVER_STATUS_TIMEOUT_MS = 5_000;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const bool = (x: unknown) => x === true;
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown) => (typeof x === "string" ? x : "");

function permissions(x: unknown): ObserverPermissionsDTO | null {
  if (!isObj(x)) return null;
  return { screenRecording: bool(x.screenRecording), accessibility: bool(x.accessibility), inputMonitoring: bool(x.inputMonitoring) };
}

/** The v1 status, field by field; throws when it is not one. */
export function toObserverStatus(raw: unknown): ObserverStatusDTO {
  if (!isObj(raw)) throw new Error("status is not a JSON object");
  if (raw.schemaVersion !== 1) throw new Error(`unsupported status schemaVersion ${String(raw.schemaVersion)}`);
  const keyFiles = isObj(raw.keyFiles) ? raw.keyFiles : {};
  const expiry = isObj(raw.nextExpiry) && typeof raw.nextExpiry.day === "string" && num(raw.nextExpiry.at) !== null ? { day: raw.nextExpiry.day, at: num(raw.nextExpiry.at)! } : null;
  return {
    schemaVersion: 1,
    home: str(raw.home),
    running: bool(raw.running),
    paused: bool(raw.paused),
    daysStored: Array.isArray(raw.daysStored) ? raw.daysStored.filter((d): d is string => typeof d === "string") : [],
    keepDays: num(raw.keepDays) ?? KEEP_DAYS,
    keysMode: str(raw.keysMode),
    keyFiles: { raw: num(keyFiles.raw) ?? 0, wrapped: num(keyFiles.wrapped) ?? 0 },
    permissions: permissions(raw.permissions),
    permissionsSource: str(raw.permissionsSource) || "unknown",
    days: Array.isArray(raw.days)
      ? raw.days.filter(isObj).map((d) => ({ day: str(d.day), events: num(d.events) ?? 0, encrypted: bool(d.encrypted), plain: bool(d.plain) }))
      : [],
    nextPurgeAt: num(raw.nextPurgeAt),
    nextExpiry: expiry,
    heartbeat: isObj(raw.heartbeat) ? raw.heartbeat : null,
  };
}

export async function observerStatus(home: string, env: ObserverEnv, now: number): Promise<ObserverResponse> {
  const bin = observerBin(env);
  const base = { version: API_VERSION, bin, checkedAt: now } as const;
  const fail = (error: string): ObserverResponse => ({ ...base, available: false, error, permissions: null, status: null });
  if (!existsSync(bin)) return fail(missingBinMessage(bin, "status"));
  let proc;
  try {
    proc = Bun.spawn([bin, "status", "--json", "--home", home], { env: observerChildEnv(home, env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return fail(`${bin} status failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, OBSERVER_STATUS_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) return fail(`${bin} status timed out after ${OBSERVER_STATUS_TIMEOUT_MS} ms`);
  if (code !== 0) return fail(`${bin} status exited ${code}: ${stderr.trim().slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail(`${bin} status printed output that is not JSON`);
  }
  try {
    const status = toObserverStatus(parsed);
    return { ...base, available: true, error: null, permissions: status.permissions, status };
  } catch (err) {
    return fail(`${bin} status: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- s09b: POST /observer/pause | /observer/resume ----------

export type ObserverControlResult = { ok: true; body: ObserverControlResponse } | { ok: false; error: string };

/** Runs `offload-observer pause|resume --home HOME` (5 s timeout), then reads the status again for the reply. */
export async function observerControl(home: string, action: "pause" | "resume", env: ObserverEnv, now: number): Promise<ObserverControlResult> {
  const bin = observerBin(env);
  if (!existsSync(bin)) return { ok: false, error: missingBinMessage(bin, action) };
  let proc;
  try {
    proc = Bun.spawn([bin, action, "--home", home], { env: observerChildEnv(home, env), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return { ok: false, error: `${bin} ${action} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, OBSERVER_STATUS_TIMEOUT_MS);
  const [, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) return { ok: false, error: `${bin} ${action} timed out after ${OBSERVER_STATUS_TIMEOUT_MS} ms` };
  if (code !== 0) return { ok: false, error: `${bin} ${action} exited ${code}: ${stderr.trim().slice(0, 300)}` };
  return { ok: true, body: { version: API_VERSION, action, ok: true, observer: await observerStatus(home, env, now) } };
}
