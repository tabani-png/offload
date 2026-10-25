// The control plane, as the device sees it (plan/stage-2/API.md "Auth, devices, sync"). Every response is validated
// against its schema; an invalid one is an error, never trusted. The control URL must be https (TLS) except on the
// loopback address, which only the tests' fake control plane uses.
import { validate } from "./schema.ts";
import type { DeviceConfig, SyncReceipt } from "./types.ts";
import type { PublicJwk } from "./device.ts";
import { SIGNATURE_HEADER, type SignedEnvelope } from "./envelope.ts";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The parsed control URL (no trailing slash), or an error message. */
export function checkControlUrl(raw: string | undefined): { url: string } | { error: string } {
  if (raw === undefined || raw.trim() === "") return { error: "OFFLOAD_CONTROL_URL is not set" };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "OFFLOAD_CONTROL_URL is not a URL" };
  }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return { error: "OFFLOAD_CONTROL_URL must be a plain origin and path" };
  if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))) return { url: u.toString().replace(/\/+$/, "") };
  return { error: "OFFLOAD_CONTROL_URL must use https (http only on 127.0.0.1)" };
}

export class ControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ControlError";
  }
  /** Network failure, 429 or 5xx: try again later with backoff. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface EnrollRequest {
  enrollmentCode: string;
  deviceName: string;
  appVersion: string;
  publicKeyJwk: PublicJwk;
}
export interface EnrollResponse {
  deviceId: string;
  personId: string;
  tenantId: string;
  enrolledAt: number;
}

/** Header carrying the PKCE code_verifier on enroll (the enrollment request schema has no field for it). */
export const PKCE_VERIFIER_HEADER = "Offload-Code-Verifier";

export class ControlClient {
  constructor(
    readonly base: string,
    private readonly fetchFn: FetchFn,
  ) {}

  private async call<T>(method: string, path: string, opts: { body?: string; token?: string; headers?: Record<string, string>; schema?: string }): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: opts.body }), redirect: "error" });
    } catch (err) {
      throw new ControlError(0, "network", `control plane unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const code = typeof body === "object" && body !== null && typeof (body as { error?: { code?: unknown } }).error?.code === "string" ? (body as { error: { code: string } }).error.code : "http_error";
      const ra = Number(res.headers.get("retry-after"));
      throw new ControlError(res.status, code, `${method} ${path}: ${res.status} ${code}`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
    }
    if (opts.schema !== undefined) {
      const errs = validate(opts.schema, body);
      if (errs.length > 0) throw new ControlError(502, "invalid_response", `${method} ${path}: response does not match ${opts.schema}: ${errs.slice(0, 3).join("; ")}`);
    }
    return body as T;
  }

  enroll(req: EnrollRequest, verifier: string): Promise<EnrollResponse> {
    return this.call("POST", "/v1/devices/enroll", { body: JSON.stringify(req), headers: { [PKCE_VERIFIER_HEADER]: verifier }, schema: "device-enrollment.schema.json#/$defs/response" });
  }
  challenge(deviceId: string): Promise<{ nonce: string; expiresAt: number }> {
    return this.call("POST", "/v1/devices/challenge", { body: JSON.stringify({ deviceId }), schema: "device-enrollment.schema.json#/$defs/challenge" });
  }
  token(deviceId: string, nonce: string, signature: string): Promise<{ accessToken: string; expiresAt: number }> {
    return this.call("POST", "/v1/devices/token", { body: JSON.stringify({ deviceId, nonce, signature }), schema: "device-enrollment.schema.json#/$defs/tokenResponse" });
  }
  config(token: string): Promise<DeviceConfig> {
    return this.call("GET", "/v1/sync/config", { token, schema: "device-config.schema.json" });
  }
  send(token: string, e: SignedEnvelope): Promise<SyncReceipt> {
    return this.call("POST", "/v1/sync/batches", { token, body: e.body, headers: { [SIGNATURE_HEADER]: e.header }, schema: "sync-receipt.schema.json" });
  }
}
