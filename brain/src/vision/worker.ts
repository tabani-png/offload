// The caption pipeline (SPEC C8): pulls new keyframes from the observer, captions them with a LOCAL captioner, masks
// the text, and writes Frame notes into the brain's sealed store. One caption at a time; a bounded queue gives
// backpressure (when full the poll stops adding; the rest is found on a later poll because it still has no note).
import type { CaptionerStatusDTO } from "../api/types.ts";
import type { ObserverEnv } from "../store/observer.ts";
import { localDay } from "../store/vault.ts";
import { CaptionerFatalError } from "./ollama.ts";
import { appendNotes, buildNote, maskFields, readFrameNotes } from "./notes.ts";
import type { FrameSource } from "./frames.ts";
import type { Captioner, FrameRef, UserContext } from "./types.ts";

export interface WorkerOptions {
  home: string;
  source: FrameSource;
  captioner: Captioner;
  now?: () => number;
  env?: ObserverEnv;
  /** Poll interval, ms (default 15 000). */
  pollMs?: number;
  /** Queue cap (default 32). */
  maxQueue?: number;
  /** Attempts per frame before it is skipped for this process (default 3). */
  maxAttempts?: number;
  /** Days looked back, today included (default 8 = the 7-day window). */
  lookbackDays?: number;
  /** Health re-check interval while unhealthy or idle, ms (default 60 000). */
  healthEveryMs?: number;
  /** Per-caption deadline, ms (default 180 000). The captioner has its own per-attempt timeout too. */
  captionDeadlineMs?: number;
  context?: () => UserContext;
  log?: (line: string) => void;
}

/** Keeps an error message short and free of anything but our own wording (no note text ever gets here). */
const scrub = (s: string) => s.replace(/[\r\n\t]+/g, " ").slice(0, 200);

export class CaptionWorker {
  private readonly o: Required<Omit<WorkerOptions, "context" | "log" | "env">> & Pick<WorkerOptions, "context" | "env"> & { log: (l: string) => void };
  private queue: FrameRef[] = [];
  private queued = new Set<string>();
  private noted = new Map<string, Set<string>>();
  private attempts = new Map<string, number>();
  private gaveUp = new Set<string>();
  private running = false;
  private healthy: boolean | null = null;
  private lastHealthAt = 0;
  private stats = { processed: 0, failed: 0, skipped: 0, lastCaptionAt: null as number | null, lastLatencyMs: null as number | null, lastError: null as string | null, lastPollAt: null as number | null };

  constructor(opts: WorkerOptions) {
    this.o = {
      now: Date.now,
      pollMs: 15_000,
      maxQueue: 32,
      maxAttempts: 3,
      lookbackDays: 8,
      healthEveryMs: 60_000,
      captionDeadlineMs: 180_000,
      log: (l: string) => console.error(l),
      ...opts,
    } as CaptionWorker["o"];
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  private notedFor(day: string): Set<string> {
    let s = this.noted.get(day);
    if (s === undefined) {
      s = new Set(readFrameNotes(this.o.home, day, this.o.now(), this.o.env).map((n) => n.frameId));
      this.noted.set(day, s);
    }
    return s;
  }

  /** Days in the window, oldest first, that have frames. */
  private windowDays(): string[] {
    const now = this.o.now();
    const want = new Set<string>();
    for (let i = this.o.lookbackDays - 1; i >= 0; i--) want.add(localDay(now - i * 86_400_000));
    // A DST day can make the loop above miss or repeat a label; also include every stored day that is in range.
    return this.o.source.days().filter((d) => want.has(d));
  }

  /** Finds frames without a note and queues them, oldest first, until the queue is full. Returns how many it added. */
  poll(): number {
    this.stats.lastPollAt = this.o.now();
    let added = 0;
    // Forget notes caches of days that left the window.
    const days = this.windowDays();
    for (const d of [...this.noted.keys()]) if (!days.includes(d)) this.noted.delete(d);
    for (const day of days) {
      if (this.queue.length >= this.o.maxQueue) break;
      const listing = this.o.source.list(day, this.o.now());
      if (listing.error !== undefined) {
        this.stats.lastError = scrub(`frames ${day}: ${listing.error}`);
        continue;
      }
      const noted = this.notedFor(day);
      for (const ref of listing.frames) {
        if (this.queue.length >= this.o.maxQueue) break;
        if (noted.has(ref.frameId) || this.queued.has(ref.frameId) || this.gaveUp.has(ref.frameId)) continue;
        this.queue.push(ref);
        this.queued.add(ref.frameId);
        added += 1;
      }
    }
    return added;
  }

  async checkHealth(): Promise<boolean> {
    this.lastHealthAt = this.o.now();
    const h = await this.o.captioner.health();
    this.healthy = h.ok;
    if (!h.ok) this.stats.lastError = scrub(h.detail);
    return h.ok;
  }

  /** Captions the head of the queue. Returns false when there was nothing to do (or the captioner is down). */
  async step(): Promise<boolean> {
    const ref = this.queue[0];
    if (ref === undefined) return false;
    if (this.healthy !== true) {
      if (this.healthy === false && this.o.now() - this.lastHealthAt < this.o.healthEveryMs) return false;
      if (!(await this.checkHealth())) return false;
    }
    this.queue.shift();
    this.queued.delete(ref.frameId);
    const t0 = this.o.now();
    const started = performance.now();
    try {
      const image = this.o.source.read(ref, t0);
      if (image === null) {
        this.stats.skipped += 1; // purged or expired meanwhile
        return true;
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.o.captionDeadlineMs);
      let fields;
      try {
        fields = await this.o.captioner.caption({ image, ref, ...(this.o.context === undefined ? {} : { context: this.o.context() }) }, ctl.signal);
      } finally {
        clearTimeout(timer);
      }
      const note = buildNote(ref, maskFields(fields), this.o.captioner.id);
      appendNotes(this.o.home, [note], this.o.now(), this.o.env, () => ref.day);
      this.notedFor(ref.day).add(ref.frameId);
      this.attempts.delete(ref.frameId);
      this.stats.processed += 1;
      this.stats.lastCaptionAt = this.o.now();
      this.stats.lastLatencyMs = Math.round(performance.now() - started);
      return true;
    } catch (err) {
      const msg = scrub(err instanceof Error ? err.message : String(err));
      this.stats.lastError = msg;
      if (err instanceof CaptionerFatalError) {
        // The captioner itself is not usable (model missing, refused): keep the frame, wait for health.
        this.healthy = false;
        this.lastHealthAt = this.o.now();
        this.queue.unshift(ref);
        this.queued.add(ref.frameId);
        return false;
      }
      const n = (this.attempts.get(ref.frameId) ?? 0) + 1;
      this.attempts.set(ref.frameId, n);
      if (n >= this.o.maxAttempts) {
        this.gaveUp.add(ref.frameId);
        this.attempts.delete(ref.frameId);
        this.stats.failed += 1;
        this.o.log(`brain: captioner gave up on one frame after ${n} attempts: ${msg}`);
      } else {
        this.queue.push(ref);
        this.queued.add(ref.frameId);
      }
      return true;
    }
  }

  /** Polls, then captions until the queue is empty or the captioner is down. One run at a time. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      this.poll();
      while (await this.step()) done += 1;
    } finally {
      this.running = false;
    }
    return done;
  }

  /** Starts the poll loop. Returns a stop function. Errors are logged, never thrown into the timer. */
  start(): () => void {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      this.runOnce().catch((err: unknown) => {
        this.stats.lastError = scrub(err instanceof Error ? err.message : String(err));
        this.o.log(`brain: caption worker failed: ${this.stats.lastError}`);
      });
    };
    const t = setInterval(tick, this.o.pollMs);
    (t as { unref?: () => void }).unref?.();
    setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }

  status(): CaptionerStatusDTO {
    return {
      enabled: true,
      captioner: this.o.captioner.kind,
      model: this.o.captioner.model,
      healthy: this.healthy,
      queueDepth: this.queue.length,
      processed: this.stats.processed,
      failed: this.stats.failed,
      skipped: this.stats.skipped,
      lastPollAt: this.stats.lastPollAt,
      lastCaptionAt: this.stats.lastCaptionAt,
      lastLatencyMs: this.stats.lastLatencyMs,
      lastError: this.stats.lastError,
    };
  }
}
