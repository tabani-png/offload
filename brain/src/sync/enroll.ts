// Enrollment and device tokens (plan/stage-2/plan.md "Data flow" 1, ADR 0102 §3).
// Connect: a PKCE pair (RFC 7636, S256) and a loopback listener on 127.0.0.1 (RFC 8252 §7.3); the browser opens the
// control plane's AuthKit login with redirect_uri = the loopback callback; after sign-in the control plane redirects
// back with a one-time enrollment code and our state; the brain then calls POST /v1/devices/enroll with the device's
// public JWK (the verifier goes in the Offload-Code-Verifier header).
// Tokens: POST /v1/devices/challenge -> nonce; ES256 over the nonce's UTF-8 bytes; POST /v1/devices/token -> a 15-minute
// access token, held in memory only and refreshed before it expires. No long-lived bearer secret exists on the Mac.
// A 401/403 from the token endpoints means the device was revoked: sync stops (DeviceRevokedError).
import { createHash, randomBytes } from "node:crypto";
import { b64url } from "./encoding.ts";
import { ControlError, type ControlClient } from "./http.ts";
import type { DeviceSigner } from "./device.ts";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export interface LoopbackFlow {
  authorizeUrl: string;
  redirectUri: string;
  verifier: string;
  /** Resolves with the enrollment code from the redirect, rejects on a bad state, an error or the timeout. */
  code: Promise<string>;
  close(): void;
}

const PAGE = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Offload</title><p>${msg}</p>`;

/** Starts the loopback listener and builds the AuthKit URL. Nothing is sent before the browser is opened. */
export function startLoopback(controlUrl: string, opts: { timeoutMs?: number } = {}): LoopbackFlow {
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  let settle: { ok: (c: string) => void; fail: (e: Error) => void } | null = null;
  const code = new Promise<string>((ok, fail) => (settle = { ok, fail }));
  code.catch(() => {});
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback" || req.method !== "GET") return new Response("not found", { status: 404 });
      const got = u.searchParams.get("state");
      const c = u.searchParams.get("code");
      const html = (status: number, msg: string) => new Response(PAGE(msg), { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (got !== state) {
        // A request without our state is someone else's: ignore it, keep waiting.
        return html(400, "This sign-in link is not the one Offload started.");
      }
      if (u.searchParams.get("error") !== null || c === null || c.length < 16 || c.length > 64) {
        settle?.fail(new Error(`sign-in failed: ${u.searchParams.get("error") ?? "no enrollment code"}`));
        finish();
        return html(400, "Sign-in did not finish. Go back to Offload and try again.");
      }
      settle?.ok(c);
      finish();
      return html(200, "Offload is connected to your company. You can close this tab.");
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const timer = setTimeout(() => {
    settle?.fail(new Error("sign-in timed out"));
    finish();
  }, opts.timeoutMs ?? 10 * 60_000);
  function finish() {
    clearTimeout(timer);
    // Let the response to the browser go out before the listener closes.
    setTimeout(() => void server.stop(true), 0);
  }
  const q = new URLSearchParams({ client: "offload-mac", redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" });
  return { authorizeUrl: `${controlUrl}/auth/login?${q.toString()}`, redirectUri, verifier, code, close: () => (settle?.fail(new Error("sign-in cancelled")), finish()) };
}

export class DeviceRevokedError extends Error {}

/** Refresh this long before expiry. */
export const REFRESH_MARGIN_MS = 60_000;

export class TokenManager {
  private current: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly control: ControlClient,
    private readonly signer: DeviceSigner,
    private readonly deviceId: string,
    private readonly now: () => number,
  ) {}

  /** A valid access token, minted or refreshed when within REFRESH_MARGIN_MS of expiry. */
  async get(): Promise<string> {
    if (this.current !== null && this.now() < this.current.expiresAt - REFRESH_MARGIN_MS) return this.current.token;
    this.pending ??= this.mint().finally(() => (this.pending = null));
    return this.pending;
  }

  invalidate(): void {
    this.current = null;
  }

  private async mint(): Promise<string> {
    try {
      const ch = await this.control.challenge(this.deviceId);
      const sig = b64url(await this.signer.sign(new TextEncoder().encode(ch.nonce)));
      const t = await this.control.token(this.deviceId, ch.nonce, sig);
      this.current = { token: t.accessToken, expiresAt: t.expiresAt };
      return t.accessToken;
    } catch (err) {
      if (err instanceof ControlError && (err.status === 401 || err.status === 403 || err.status === 404)) throw new DeviceRevokedError(`device ${this.deviceId} is no longer enrolled (${err.status} ${err.code})`);
      throw err;
    }
  }
}
