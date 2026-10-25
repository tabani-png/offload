// A fake control plane for S2-02 (stands in for S2-01/S2-05): Bun.serve on 127.0.0.1 only. It implements the device
// side of plan/stage-2/API.md: AuthKit login (redirects to the loopback callback with an enrollment code bound to the
// PKCE challenge), enroll, challenge, token (15 min, ES256 over the nonce), sync config and batches (signature over the
// exact body, JCS check, schema check, seq replay check, sentAt window, server-side consent re-check). Every request
// is recorded.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { verifyEs256, type PublicJwk } from "../../src/sync/device.ts";
import { b64url } from "../../src/sync/encoding.ts";
import { parseSignatureHeader } from "../../src/sync/envelope.ts";
import { canonicalize } from "../../src/sync/jcs.ts";
import { validate } from "../../src/sync/schema.ts";
import { PKCE_VERIFIER_HEADER } from "../../src/sync/http.ts";
import type { DeviceConfig, SyncEnvelope, SyncReceipt } from "../../src/sync/types.ts";

export const PERSON = "11111111-1111-4111-8111-111111111111";
export const TENANT = "22222222-2222-4222-8222-222222222222";
export const NOTICE_1 = "33333333-3333-4333-8333-333333333333";
export const NOTICE_WT = "44444444-4444-4444-8444-444444444444";
export const WORKFLOW = "55555555-5555-4555-8555-555555555555";

export function defaultConfig(over: Partial<DeviceConfig> = {}): DeviceConfig {
  return {
    personId: PERSON,
    tenantId: TENANT,
    jurisdiction: "CA-ON",
    requiredNotice: { noticeVersionId: NOTICE_1, title: "How Offload works at Acme", markdown: "# Notice\nWhat is captured and why.", features: ["workflow_metrics"] },
    allowedKinds: ["notice_ack", "run_outcome", "review_event", "baseline_sample", "daily_aggregate", "working_time_aggregate", "workflow_proposal"],
    features: { workflow_metrics: true, per_person_views: false, working_time: false },
    workingTimeStartsAt: null,
    killSwitch: false,
    minAppVersion: "0",
    flushSeconds: 900,
    ...over,
  };
}

export interface Received {
  body: string;
  headers: Headers;
  envelope: SyncEnvelope;
  signatureOk: boolean;
  receipt: SyncReceipt | null;
  status: number;
}

interface Device {
  jwk: PublicJwk;
  revoked: boolean;
  lastSeq: number;
  acked: Set<string>;
}

const err = (status: number, code: string, message = code) => Response.json({ error: { code, message } }, { status });

export class FakeControl {
  url = "";
  private server: ReturnType<typeof Bun.serve> | null = null;
  readonly devices = new Map<string, Device>();
  private readonly codes = new Map<string, { challenge: string; used: boolean }>();
  private readonly nonces = new Map<string, string>();
  private readonly tokens = new Map<string, { deviceId: string; expiresAt: number }>();
  config: DeviceConfig = defaultConfig();
  readonly received: Received[] = [];
  readonly calls: string[] = [];
  /** Override the batches answer (status + JSON) once per call; return null to fall through. */
  intercept: ((env: SyncEnvelope) => Response | null) | null = null;
  /** Rejections to put in the next receipts: object id -> code. */
  rejectNext = new Map<string, { code: SyncReceipt["rejected"][number]["code"]; retryable: boolean }>();
  /** A login that ends with an error instead of a code. */
  loginError: string | null = null;

  constructor(readonly clock: { now: number }) {}

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
    return this;
  }
  async stop(): Promise<void> {
    await this.server?.stop(true);
  }

  revoke(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d !== undefined) d.revoked = true;
    for (const [t, v] of this.tokens) if (v.deviceId === deviceId) this.tokens.delete(t);
  }
  tokenCount(): number {
    return this.calls.filter((c) => c === "POST /v1/devices/token").length;
  }

  private bearer(req: Request): string | null {
    const t = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    const rec = t === undefined ? undefined : this.tokens.get(t);
    if (rec === undefined || rec.expiresAt <= this.clock.now || this.devices.get(rec.deviceId)?.revoked !== false) return null;
    return rec.deviceId;
  }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    this.calls.push(`${req.method} ${u.pathname}`);
    const body = req.method === "POST" ? await req.text() : "";
    const parsed = (() => {
      try {
        return body === "" ? null : (JSON.parse(body) as Record<string, unknown>);
      } catch {
        return null;
      }
    })();
    switch (`${req.method} ${u.pathname}`) {
      case "GET /auth/login": {
        const redirect = u.searchParams.get("redirect_uri") ?? "";
        if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect) || u.searchParams.get("code_challenge_method") !== "S256") return err(400, "validation_failed");
        const state = u.searchParams.get("state") ?? "";
        if (this.loginError !== null) return Response.redirect(`${redirect}?error=${this.loginError}&state=${state}`, 302);
        const code = b64url(randomBytes(18));
        this.codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", used: false });
        return Response.redirect(`${redirect}?code=${code}&state=${encodeURIComponent(state)}`, 302);
      }
      case "POST /v1/devices/enroll": {
        if (validate("device-enrollment.schema.json#/$defs/request", parsed).length > 0) return err(400, "validation_failed");
        const p = parsed as { enrollmentCode: string; publicKeyJwk: PublicJwk };
        const c = this.codes.get(p.enrollmentCode);
        const verifier = req.headers.get(PKCE_VERIFIER_HEADER) ?? "";
        if (c === undefined || c.used) return err(401, "unauthorized", "unknown or used code");
        if (b64url(createHash("sha256").update(verifier).digest()) !== c.challenge) return err(401, "unauthorized", "pkce mismatch");
        c.used = true;
        const deviceId = randomUUID();
        this.devices.set(deviceId, { jwk: p.publicKeyJwk, revoked: false, lastSeq: 0, acked: new Set() });
        return Response.json({ deviceId, personId: PERSON, tenantId: TENANT, enrolledAt: this.clock.now });
      }
      case "POST /v1/devices/challenge": {
        const id = String(parsed?.deviceId ?? "");
        const d = this.devices.get(id);
        if (d === undefined || d.revoked) return err(401, "unauthorized");
        const nonce = b64url(randomBytes(24));
        this.nonces.set(nonce, id);
        return Response.json({ nonce, expiresAt: this.clock.now + 60_000 });
      }
      case "POST /v1/devices/token": {
        if (validate("device-enrollment.schema.json#/$defs/tokenRequest", parsed).length > 0) return err(400, "validation_failed");
        const p = parsed as { deviceId: string; nonce: string; signature: string };
        const d = this.devices.get(p.deviceId);
        if (d === undefined || d.revoked || this.nonces.get(p.nonce) !== p.deviceId) return err(401, "unauthorized");
        this.nonces.delete(p.nonce);
        if (!(await verifyEs256(d.jwk, new TextEncoder().encode(p.nonce), p.signature))) return err(401, "bad_signature");
        const accessToken = b64url(randomBytes(32));
        const expiresAt = this.clock.now + 15 * 60_000;
        this.tokens.set(accessToken, { deviceId: p.deviceId, expiresAt });
        return Response.json({ accessToken, expiresAt });
      }
      case "GET /v1/sync/config": {
        if (this.bearer(req) === null) return err(401, "unauthorized");
        return Response.json(this.config);
      }
      case "POST /v1/sync/batches":
        return this.batches(req, body, parsed);
    }
    return err(404, "not_found");
  }

  private async batches(req: Request, body: string, parsed: Record<string, unknown> | null): Promise<Response> {
    const deviceId = this.bearer(req);
    if (deviceId === null) return err(401, "unauthorized");
    const d = this.devices.get(deviceId)!;
    const sigh = parseSignatureHeader(req.headers.get("offload-signature"));
    const env = parsed as unknown as SyncEnvelope;
    const signatureOk = sigh !== null && sigh.keyid === deviceId && (await verifyEs256(d.jwk, new TextEncoder().encode(body), sigh.sig));
    const rec: Received = { body, headers: req.headers, envelope: env, signatureOk, receipt: null, status: 0 };
    this.received.push(rec);
    const answer = (r: Response) => ((rec.status = r.status), r);
    if (!signatureOk) return answer(err(401, "bad_signature"));
    if (parsed === null || canonicalize(parsed) !== body) return answer(err(400, "validation_failed", "body is not JCS"));
    if (validate("sync-envelope.schema.json", parsed).length > 0) return answer(err(400, "validation_failed", validate("sync-envelope.schema.json", parsed).slice(0, 3).join("; ")));
    if (env.deviceId !== deviceId) return answer(err(403, "forbidden"));
    if (env.seq <= d.lastSeq) return answer(err(409, "replay"));
    if (Math.abs(env.sentAt - this.clock.now) > 10 * 60_000) return answer(err(409, "replay", "sentAt"));
    const forced = this.intercept?.(env) ?? null;
    if (forced !== null) return answer(forced);
    d.lastSeq = env.seq;
    const receipt: SyncReceipt = { seq: env.seq, accepted: [], rejected: [] };
    for (const o of env.objects) {
      const forcedReject = this.rejectNext.get(o.id);
      if (forcedReject !== undefined) {
        this.rejectNext.delete(o.id);
        receipt.rejected.push({ id: o.id, ...forcedReject });
        continue;
      }
      // Server-side re-check (ADR 0103 §2): G1 and G2 from its own records.
      if (o.kind === "notice_ack") d.acked.add(o.noticeVersionId);
      else if (this.config.requiredNotice !== null && !d.acked.has(this.config.requiredNotice.noticeVersionId)) {
        receipt.rejected.push({ id: o.id, code: "consent_missing", retryable: false });
        continue;
      } else if (o.kind === "working_time_aggregate" && !this.config.features.working_time) {
        receipt.rejected.push({ id: o.id, code: "feature_disabled", retryable: false });
        continue;
      }
      receipt.accepted.push(o.id);
    }
    rec.receipt = receipt;
    return answer(Response.json(receipt));
  }

  /** Every object the server accepted, in order. */
  acceptedObjects(): SyncEnvelope["objects"] {
    return this.received.flatMap((r) => (r.receipt === null ? [] : r.envelope.objects.filter((o) => r.receipt!.accepted.includes(o.id))));
  }
}
