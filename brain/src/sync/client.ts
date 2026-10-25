// The sync client (ADR 0103, SPEC S2-02): enrollment, consent gate, projection into the closed set of sync objects,
// the sealed outbox and signed envelopes. Order of one flush:
//   token (challenge-signed) -> GET /v1/sync/config -> collect + project what consent allows -> queue (sealed) ->
//   decide per queued object (send / hold / drop) -> split (<= 500 objects, <= 1 MiB) -> seq written -> sign -> POST
//   -> receipt (accepted and duplicate leave the outbox; retryable rejections back off; the rest are dropped).
// Flush every flushSeconds (default 15 min) and after each run; network, 429 and 5xx back off exponentially to 6 h.
// A revoked device stops: nothing is sent until it is connected again.
import { hostname } from "node:os";
import type { Analysis } from "../analyze.ts";
import type { ObserverEnv } from "../store/observer.ts";
import { readWorkflow } from "../workflows/store.ts";
import { decide, noticeSatisfied, workingTimeAllowed, workingTimeNotice, type ConsentState } from "./consent.ts";
import { loadDeviceSigner, type DeviceSigner } from "./device.ts";
import { DeviceRevokedError, startLoopback, TokenManager, type LoopbackFlow } from "./enroll.ts";
import { signEnvelope, splitObjects } from "./envelope.ts";
import { EvidenceKey } from "./evidence-key.ts";
import { checkControlUrl, ControlClient, ControlError, type FetchFn } from "./http.ts";
import { canonicalize } from "./jcs.ts";
import { Outbox, type OutboxEntry } from "./outbox.ts";
import { projectBaselineSamples, projectDailyAggregate, projectNoticeAck, projectReviewEvent, projectRunOutcome, projectWorkflowProposal, projectWorkingTime } from "./project/index.ts";
import { readReviews, recordReview, type ReviewRecord } from "./reviews.ts";
import { assertValid, SCHEMA_OF_KIND } from "./schema.ts";
import { readState, writeState, type SyncState } from "./state.ts";
import { collectBaselines, collectDaily, collectProposal, collectReviews, collectRuns, collectWorkingTime } from "./collect.ts";
import type { Binding, DeviceConfig, NoticeAck, SyncEnvelope, SyncKind, SyncObject, SyncReceipt, WorkflowProposal } from "./types.ts";

export const SYNC_APP_VERSION = "brain-s2.02";
export const DEFAULT_FLUSH_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 6 * 3_600_000;
export const TICK_MS = 60_000;

export interface SyncDeps {
  home: string;
  env?: ObserverEnv & Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Default: env.OFFLOAD_CONTROL_URL. */
  controlUrl?: string;
  fetch?: FetchFn;
  /** Opens the AuthKit URL in the browser (default: `open URL` on macOS). */
  openUrl?: (url: string) => void | Promise<void>;
  /** The brain's analysis of the observer store (baselines, working time). */
  analysis?: () => Promise<Analysis>;
  /** A hardware signer (Secure Enclave seam). Default: the software key `device-signing`. */
  signer?: DeviceSigner;
  deviceName?: string;
  log?: (line: string) => void;
  loopbackTimeoutMs?: number;
  /** IANA zone for a "local" cron in a shared workflow (default: this Mac's). */
  timezone?: string;
}

export type SyncPhase = "not_configured" | "not_connected" | "connecting" | "connected" | "paused" | "revoked";

export interface SyncStatusDTO {
  state: SyncPhase;
  controlUrl: string | null;
  configError: string | null;
  deviceId: string | null;
  personId: string | null;
  tenantId: string | null;
  enrolledAt: number | null;
  paused: boolean;
  seq: number;
  notice: { required: DeviceConfig["requiredNotice"]; acknowledged: boolean } | null;
  features: DeviceConfig["features"] | null;
  outbox: { total: number; byKind: Partial<Record<SyncKind, number>> };
  boundWorkflows: number;
  lastFlushAt: number | null;
  nextFlushAt: number | null;
  failures: number;
  lastError: string | null;
}

export interface FlushResult {
  sent: number;
  envelopes: number;
  accepted: number;
  rejected: number;
  dropped: number;
  held: number;
  skipped?: "not_connected" | "revoked" | "backoff" | "busy";
  error?: string;
}

export class SyncError extends Error {
  constructor(
    readonly code: "not_configured" | "not_connected" | "conflict" | "not_found" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

export const backoffMs = (failures: number) => Math.min(MAX_BACKOFF_MS, DEFAULT_FLUSH_MS * 2 ** Math.max(0, failures - 1));
const RETRYABLE = new Set(["rate_limited", "server_error"]);

export class SyncClient {
  readonly home: string;
  private readonly env: NonNullable<SyncDeps["env"]>;
  private readonly now: () => number;
  private readonly fetchFn: FetchFn;
  private readonly url: { url: string } | { error: string };
  private readonly outbox: Outbox;
  private readonly log: (l: string) => void;
  private signer: DeviceSigner | null;
  private tokens: TokenManager | null = null;
  private config: DeviceConfig | null = null;
  private flow: (LoopbackFlow & { done: Promise<void> }) | null = null;
  private flushing: Promise<FlushResult> | null = null;

  constructor(private readonly deps: SyncDeps) {
    this.home = deps.home;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
    this.fetchFn = deps.fetch ?? ((u, i) => fetch(u, i));
    this.url = checkControlUrl(deps.controlUrl ?? this.env.OFFLOAD_CONTROL_URL);
    this.outbox = new Outbox(this.home, this.env);
    this.log = deps.log ?? ((l) => console.error(l));
    this.signer = deps.signer ?? null;
  }

  private state(): SyncState {
    return readState(this.home);
  }
  private save(s: SyncState): void {
    writeState(this.home, s, this.now());
  }
  private get control(): ControlClient {
    if ("error" in this.url) throw new SyncError("not_configured", this.url.error);
    return new ControlClient(this.url.url, this.fetchFn);
  }
  private connected(s: SyncState): boolean {
    return s.deviceId !== null && !s.revoked && "url" in this.url && s.controlUrl === this.url.url;
  }
  private deviceSigner(create: boolean): DeviceSigner | null {
    this.signer ??= loadDeviceSigner(this.home, { create, env: this.env });
    return this.signer;
  }
  private evidence(): EvidenceKey {
    return EvidenceKey.load(this.home, { create: true, env: this.env })!;
  }
  private tokenManager(s: SyncState): TokenManager {
    const signer = this.deviceSigner(false);
    if (signer === null || s.deviceId === null) throw new SyncError("not_connected", "this Mac is not connected to a company");
    this.tokens ??= new TokenManager(this.control, signer, s.deviceId, this.now);
    return this.tokens;
  }
  private consent(s: SyncState): ConsentState {
    return { config: this.config, acks: s.acks, paused: s.paused, now: this.now() };
  }

  // ---------- status, pause ----------

  status(): SyncStatusDTO {
    const s = this.state();
    const entries = this.outbox.list(this.now());
    const byKind: Partial<Record<SyncKind, number>> = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const phase: SyncPhase = "error" in this.url ? "not_configured" : s.revoked ? "revoked" : this.connected(s) ? (s.paused ? "paused" : "connected") : this.flow !== null ? "connecting" : "not_connected";
    return {
      state: phase,
      controlUrl: "url" in this.url ? this.url.url : null,
      configError: "error" in this.url ? this.url.error : null,
      deviceId: s.deviceId,
      personId: s.personId,
      tenantId: s.tenantId,
      enrolledAt: s.enrolledAt,
      paused: s.paused,
      seq: s.seq,
      notice: this.config === null ? null : { required: this.config.requiredNotice, acknowledged: noticeSatisfied(this.consent(s)) },
      features: this.config?.features ?? null,
      outbox: { total: entries.length, byKind },
      boundWorkflows: Object.keys(s.bindings).length,
      lastFlushAt: s.lastFlushAt,
      nextFlushAt: s.nextFlushAt,
      failures: s.failures,
      lastError: s.lastError,
    };
  }

  setPaused(paused: boolean): SyncStatusDTO {
    const s = this.state();
    s.paused = paused;
    this.save(s);
    return this.status();
  }

  /** Binds a local workflow to a company workflow version (role workflow on this Mac, or a promoted proposal). */
  bind(localId: string, binding: Binding | null): void {
    const s = this.state();
    if (binding === null) delete s.bindings[localId];
    else s.bindings[localId] = { workflowId: binding.workflowId, version: binding.version };
    this.save(s);
  }

  recordReview(r: ReviewRecord): void {
    recordReview(this.home, r, this.now());
  }

  // ---------- enrollment ----------

  /** Starts "Connect to company": loopback listener, browser to AuthKit, then enroll in the background. */
  async connect(): Promise<{ state: "waiting"; authorizeUrl: string }> {
    const control = this.control;
    const s = this.state();
    if (this.connected(s)) throw new SyncError("conflict", "this Mac is already connected");
    if (this.flow !== null) return { state: "waiting", authorizeUrl: this.flow.authorizeUrl };
    const flow = startLoopback(control.base, this.deps.loopbackTimeoutMs === undefined ? {} : { timeoutMs: this.deps.loopbackTimeoutMs });
    const done = flow.code
      .then(async (code) => {
        const signer = this.deviceSigner(true)!;
        const res = await control.enroll({ enrollmentCode: code, deviceName: (this.deps.deviceName ?? hostname()).slice(0, 120) || "Mac", appVersion: SYNC_APP_VERSION, publicKeyJwk: await signer.publicJwk() }, flow.verifier);
        const next = this.state();
        // A new enrollment is a new device: new id, seq from 1 again (the server keys replay on the device id).
        Object.assign(next, { controlUrl: control.base, deviceId: res.deviceId, personId: res.personId, tenantId: res.tenantId, enrolledAt: res.enrolledAt, seq: 0, revoked: false, failures: 0, lastError: null, nextFlushAt: this.now() });
        this.save(next);
        this.tokens = null;
        this.config = null;
        this.log(`brain: sync connected to ${control.base} as device ${res.deviceId}`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const next = this.state();
        next.lastError = `connect failed: ${msg}`.slice(0, 300);
        this.save(next);
        this.log(`brain: sync connect failed: ${msg}`);
      })
      .finally(() => (this.flow = null));
    this.flow = { ...flow, done };
    await (this.deps.openUrl ?? openInBrowser)(flow.authorizeUrl);
    return { state: "waiting", authorizeUrl: flow.authorizeUrl };
  }

  /** Resolves when a running connect flow has finished (tests). */
  async connectIdle(): Promise<void> {
    await this.flow?.done;
  }

  // ---------- config, notice, share ----------

  /** GET /v1/sync/config. Any failure leaves the config unknown (= nothing but notice_ack may leave). */
  async refreshConfig(): Promise<DeviceConfig | null> {
    const s = this.state();
    if (!this.connected(s)) return (this.config = null);
    try {
      this.config = await this.control.config(await this.tokenManager(s).get());
    } catch (err) {
      this.config = null;
      if (err instanceof DeviceRevokedError) this.markRevoked(err.message);
      else if (err instanceof ControlError && err.status === 401) this.tokens?.invalidate();
      throw err;
    }
    return this.config;
  }

  private markRevoked(why: string): void {
    const s = this.state();
    s.revoked = true;
    s.lastError = why.slice(0, 300);
    this.save(s);
    this.tokens = null;
    this.config = null;
    this.log(`brain: sync stopped: ${why}`);
  }

  /** The person acknowledged the required notice on this Mac: record it and queue the notice_ack (G1). */
  async acknowledgeNotice(noticeVersionId: string): Promise<NoticeAck> {
    const s = this.state();
    if (!this.connected(s)) throw new SyncError("not_connected", "this Mac is not connected to a company");
    const config = this.config ?? (await this.refreshConfig());
    const notice = config?.requiredNotice ?? null;
    if (config === null || notice === null || notice.noticeVersionId !== noticeVersionId) throw new SyncError("conflict", "that notice version is not the one this Mac must acknowledge");
    const at = this.now();
    const ack = projectNoticeAck({ noticeVersionId, acknowledgedAt: at, jurisdiction: config.jurisdiction, features: notice.features }, { ids: this.evidence().ids, now: at });
    assertValid(SCHEMA_OF_KIND.notice_ack, ack);
    const next = this.state();
    next.acks = [...next.acks.filter((a) => a.noticeVersionId !== noticeVersionId), { noticeVersionId, acknowledgedAt: at, features: [...notice.features] }];
    next.known[ack.id] = at;
    this.save(next);
    this.outbox.add([{ id: ack.id, kind: "notice_ack", object: ack, queuedAt: at, attempts: 0 }], at);
    return ack;
  }

  /** G4 preview: the exact proposal JSON that would be sent. */
  proposal(localId: string): WorkflowProposal {
    const s = this.state();
    const input = collectProposal(this.home, localId, s.bindings[localId] ?? null, this.deps.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (input === null) throw new SyncError("not_found", "unknown workflow id");
    const p = projectWorkflowProposal(input, { ids: this.evidence().ids, now: this.now() });
    assertValid(SCHEMA_OF_KIND.workflow_proposal, p);
    return p;
  }

  /** G4 confirm: queues exactly the previewed proposal. `hash` (from the preview) must still match. */
  share(localId: string, hash: string | null): WorkflowProposal {
    if (!this.connected(this.state())) throw new SyncError("not_connected", "this Mac is not connected to a company");
    const p = this.proposal(localId);
    if (hash !== null && hash !== p.definitionHash) throw new SyncError("conflict", "the workflow changed since the preview: preview it again");
    const at = this.now();
    const s = this.state();
    s.known[p.id] = at;
    this.save(s);
    this.outbox.add([{ id: p.id, kind: "workflow_proposal", object: p, queuedAt: at, confirmedAt: at, attempts: 0 }], at);
    return p;
  }

  // ---------- projection ----------

  /** Projects what consent allows now and queues objects not queued or sent before. */
  private async enqueueProjected(): Promise<number> {
    const s = this.state();
    const c = this.consent(s);
    const allowed = (k: SyncKind) => decide(k, c, { forQueue: true }) === "send";
    const metrics = (["run_outcome", "review_event", "baseline_sample", "daily_aggregate"] as const).some(allowed);
    const wt = allowed("working_time_aggregate") && workingTimeAllowed(c);
    if (!metrics && !wt) return 0;
    const now = this.now();
    const ev = this.evidence();
    const ctx = { ids: ev.ids, now };
    const objects: SyncObject[] = [];
    const runs = collectRuns(this.home, s.bindings, now);
    const reviews = collectReviews(runs, readReviews(this.home));
    const analysis = this.deps.analysis === undefined ? null : await this.deps.analysis();
    const baselines = analysis === null ? [] : collectBaselines(analysis, this.home, s.bindings, ev, now);
    if (allowed("run_outcome")) objects.push(...runs.map((r) => projectRunOutcome(r, ctx)));
    if (allowed("review_event")) objects.push(...reviews.map((r) => projectReviewEvent(r, ctx)));
    if (allowed("baseline_sample")) objects.push(...baselines.flatMap((b) => projectBaselineSamples(b, ctx)));
    if (analysis !== null && allowed("daily_aggregate")) objects.push(...collectDaily(analysis, this.home, s.bindings, runs, reviews, baselines, now).map((d) => projectDailyAggregate(d, ctx)));
    if (analysis !== null && wt) {
      const notice = workingTimeNotice(s.acks)!;
      objects.push(...collectWorkingTime(analysis, now, this.config!.workingTimeStartsAt!, notice.noticeVersionId).map((w) => projectWorkingTime(w, ctx)));
    }
    const fresh: OutboxEntry[] = [];
    for (const o of objects) {
      if (s.known[o.id] !== undefined) continue;
      assertValid(SCHEMA_OF_KIND[o.kind], o);
      fresh.push({ id: o.id, kind: o.kind, object: o, queuedAt: now, attempts: 0 });
      s.known[o.id] = now;
    }
    if (fresh.length > 0) {
      this.save(s);
      this.outbox.add(fresh, now);
    }
    return fresh.length;
  }

  /** Applies consent to the outbox: drops what may never go, returns what may go now (in order) and the held count. */
  private gateOutbox(): { send: OutboxEntry[]; held: number; dropped: number } {
    const s = this.state();
    const c = this.consent(s);
    const now = this.now();
    const send: OutboxEntry[] = [];
    let held = 0;
    let dropped = 0;
    this.outbox.update(now, (entries) =>
      entries.filter((e) => {
        const d = decide(e.kind, c, { confirmed: e.confirmedAt !== undefined });
        if (d === "drop") {
          dropped += 1;
          return false;
        }
        if (d === "hold" || (e.notBefore !== undefined && e.notBefore > now)) held += 1;
        else send.push(e);
        return true;
      }),
    );
    if (dropped > 0) this.log(`brain: sync dropped ${dropped} queued object(s) that consent no longer allows`);
    return { send, held, dropped };
  }

  private envelopes(s: SyncState, send: readonly OutboxEntry[]): SyncEnvelope[] {
    const now = this.now();
    return splitObjects(
      send.map((e) => e.object),
      s.deviceId!,
    ).map((objects, i) => ({ v: 1, deviceId: s.deviceId!, seq: s.seq + 1 + i, sentAt: now, objects }));
  }

  /** GET /sync/preview: the exact next envelope (refreshes config and the queue the way a flush would). */
  async preview(): Promise<{ envelope: SyncEnvelope | null; body: string | null; held: number; queued: number }> {
    const s0 = this.state();
    if (!this.connected(s0)) throw new SyncError("not_connected", "this Mac is not connected to a company");
    await this.refreshConfig().catch(() => null);
    await this.enqueueProjected();
    const { send, held } = this.gateOutbox();
    const env = this.envelopes(this.state(), send)[0] ?? null;
    return { envelope: env, body: env === null ? null : canonicalize(env), held, queued: send.length + held };
  }

  // ---------- flush ----------

  /** One flush now (one at a time). `force` ignores the backoff window (tests, after a run). */
  flush(opts: { force?: boolean } = {}): Promise<FlushResult> {
    if (this.flushing !== null) return this.flushing.then(() => ({ sent: 0, envelopes: 0, accepted: 0, rejected: 0, dropped: 0, held: 0, skipped: "busy" as const }));
    this.flushing = this.flushOnce(opts.force === true).finally(() => (this.flushing = null));
    return this.flushing;
  }

  private failed(err: unknown): FlushResult {
    const s = this.state();
    const ce = err instanceof ControlError ? err : null;
    s.failures += 1;
    s.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    s.nextFlushAt = this.now() + Math.max(backoffMs(s.failures), Math.min(MAX_BACKOFF_MS, ce?.retryAfterMs ?? 0));
    this.save(s);
    return { sent: 0, envelopes: 0, accepted: 0, rejected: 0, dropped: 0, held: 0, error: s.lastError };
  }

  private async flushOnce(force: boolean): Promise<FlushResult> {
    const empty = { sent: 0, envelopes: 0, accepted: 0, rejected: 0, dropped: 0, held: 0 };
    const s0 = this.state();
    if (s0.revoked) return { ...empty, skipped: "revoked" };
    if (!this.connected(s0)) return { ...empty, skipped: "not_connected" };
    if (!force && s0.nextFlushAt !== null && this.now() < s0.nextFlushAt) return { ...empty, skipped: "backoff" };
    try {
      await this.refreshConfig();
    } catch (err) {
      if (err instanceof DeviceRevokedError) return { ...empty, skipped: "revoked" };
      if (!(err instanceof ControlError) || err.retryable) return this.failed(err);
      // The config was refused (not a network problem): stay at "unknown config" and still send acks.
    }
    await this.enqueueProjected();
    const { send, held, dropped } = this.gateOutbox();
    const res: FlushResult = { ...empty, held, dropped };
    let remaining = [...send];
    while (remaining.length > 0) {
      const s = this.state();
      const env = this.envelopes(s, remaining)[0]!;
      // The seq is used up BEFORE the request: a retry after a crash never reuses it.
      s.seq = env.seq;
      this.save(s);
      const signed = await signEnvelope(env, this.deviceSigner(false)!);
      let receipt: SyncReceipt;
      try {
        receipt = await this.sendWithRefresh(signed);
      } catch (err) {
        if (err instanceof DeviceRevokedError) return { ...res, skipped: "revoked" };
        if (err instanceof ControlError && !err.retryable) {
          // replay: the seq is already burned, the next envelope takes a higher one; others: keep and retry later.
          const st = this.state();
          st.lastError = err.message.slice(0, 300);
          st.nextFlushAt = this.now() + backoffMs(Math.max(1, st.failures));
          this.save(st);
          return { ...res, error: err.message };
        }
        return { ...res, ...this.failed(err), sent: res.sent, envelopes: res.envelopes, accepted: res.accepted, rejected: res.rejected };
      }
      res.envelopes += 1;
      res.sent += env.objects.length;
      this.applyReceipt(receipt, env, res);
      const done = new Set(env.objects.map((o) => o.id));
      remaining = remaining.filter((e) => !done.has(e.id));
    }
    const s = this.state();
    s.failures = 0;
    s.lastFlushAt = this.now();
    s.lastError = null;
    s.nextFlushAt = this.now() + Math.max(60_000, (this.config?.flushSeconds ?? DEFAULT_FLUSH_MS / 1000) * 1000);
    this.save(s);
    return res;
  }

  private async sendWithRefresh(signed: Awaited<ReturnType<typeof signEnvelope>>): Promise<SyncReceipt> {
    const s = this.state();
    const tm = this.tokenManager(s);
    try {
      return await this.control.send(await tm.get(), signed);
    } catch (err) {
      if (!(err instanceof ControlError) || err.status !== 401) throw err;
      tm.invalidate();
      try {
        return await this.control.send(await tm.get(), signed);
      } catch (again) {
        if (again instanceof DeviceRevokedError) this.markRevoked(again.message);
        throw again;
      }
    }
  }

  private applyReceipt(r: SyncReceipt, env: SyncEnvelope, res: FlushResult): void {
    const now = this.now();
    const accepted = new Set(r.accepted);
    const rejected = new Map(r.rejected.map((x) => [x.id, x]));
    const inEnvelope = new Set(env.objects.map((o) => o.id));
    this.outbox.update(now, (entries) =>
      entries.flatMap((e) => {
        if (!inEnvelope.has(e.id)) return [e];
        const rj = rejected.get(e.id);
        if (accepted.has(e.id) || rj?.code === "duplicate") {
          res.accepted += 1;
          return [];
        }
        if (rj === undefined) {
          // Neither accepted nor rejected: keep it for the next flush.
          return [{ ...e, attempts: e.attempts + 1 }];
        }
        res.rejected += 1;
        // Only rate_limited / server_error are retried (ADR 0103 §4), whatever the receipt's flag says.
        if (RETRYABLE.has(rj.code)) return [{ ...e, attempts: e.attempts + 1, notBefore: now + backoffMs(e.attempts + 1) }];
        this.log(`brain: sync object ${e.kind} rejected (${rj.code}); not retried`);
        return [];
      }),
    );
  }

  /** After a workflow run: flush now (unless paused, not connected or backing off). */
  afterRun(): Promise<FlushResult> {
    return this.flush().catch((err: unknown) => ({ sent: 0, envelopes: 0, accepted: 0, rejected: 0, dropped: 0, held: 0, error: err instanceof Error ? err.message : String(err) }));
  }

  /** Background flushes: checks every minute, flushes when nextFlushAt is due. Returns a stop function. */
  start(intervalMs: number = TICK_MS): () => void {
    const fail = (err: unknown) => this.log(`brain: sync flush failed: ${err instanceof Error ? err.message : String(err)}`);
    const t = setInterval(() => {
      try {
        const s = this.state();
        if (!this.connected(s) || (s.nextFlushAt !== null && this.now() < s.nextFlushAt)) return;
        void this.flush().catch(fail);
      } catch (err) {
        // An unreadable state file must never take the brain down from a timer.
        fail(err);
      }
    }, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  /** Connected and not paused (state file only: cheap, no decryption). */
  active(): boolean {
    try {
      const s = this.state();
      return this.connected(s) && !s.paused;
    } catch {
      return false;
    }
  }

  /** Is the workflow known locally (routes)? */
  hasWorkflow(localId: string): boolean {
    try {
      return readWorkflow(this.home, localId) !== null;
    } catch {
      return false;
    }
  }
}

function openInBrowser(url: string): void {
  if (process.platform !== "darwin") throw new SyncError("bad_request", `open this URL in a browser to connect: ${url}`);
  Bun.spawn(["/usr/bin/open", url], { stdout: "ignore", stderr: "ignore" });
}
