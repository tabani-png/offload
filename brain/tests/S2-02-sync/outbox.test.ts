// OUTBOX: sealed on disk (no plaintext JSON), 7-day purge with a purge-log line, retry/backoff, receipt handling.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backoffMs, DEFAULT_FLUSH_MS, MAX_BACKOFF_MS } from "../../src/sync/client.ts";
import { Outbox, outboxDir, purgeOutbox } from "../../src/sync/outbox.ts";
import { purgeAll } from "../../src/store/retention.ts";
import { brainKeyPath } from "../../src/store/vault.ts";
import { NOTICE_1 } from "./fake-control.ts";
import { connect, connectAndAck, NOW, syncWorld, type SyncWorld } from "./setup.ts";

const DAY_MS = 86_400_000;
let w: SyncWorld;
beforeEach(async () => {
  w = await syncWorld();
});
afterEach(() => w.cleanup());

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)) : []);

test("OUTBOX: queued objects are sealed with the brain day key: no plaintext JSON in the outbox file", async () => {
  await connectAndAck(w);
  const f = files(outboxDir(w.home));
  expect(f).toHaveLength(1);
  const raw = readFileSync(f[0]!, "utf8");
  expect(raw.startsWith("OBV1 2026-10-19\n")).toBe(true);
  expect(raw).not.toContain("notice_ack");
  expect(raw).not.toContain(NOTICE_1);
  expect(raw).not.toContain("{");
  expect(existsSync(brainKeyPath(w.home, "2026-10-19"))).toBe(true);
  expect(new Outbox(w.home).list(NOW).map((e) => e.kind)).toEqual(["notice_ack"]);
});

test("OUTBOX: a paused outbox holds objects locally (sealed) and sends them after resume", async () => {
  await connect(w);
  w.client.setPaused(true);
  await w.client.refreshConfig();
  await w.client.acknowledgeNotice(NOTICE_1);
  const r = await w.client.flush({ force: true });
  expect(r.sent).toBe(0);
  expect(r.held).toBe(1);
  expect(w.control.received).toHaveLength(0);
  w.client.setPaused(false);
  expect((await w.client.flush({ force: true })).sent).toBe(1);
  expect(w.control.acceptedObjects().map((o) => o.kind)).toEqual(["notice_ack"]);
});

test("OUTBOX: objects older than 7 days are dropped by the purge with a purge-log line", async () => {
  await connect(w);
  w.client.setPaused(true);
  await w.client.refreshConfig();
  await w.client.acknowledgeNotice(NOTICE_1);
  const later = NOW + 8 * DAY_MS;
  const res = purgeAll(w.home, later, { log: () => {} });
  expect(res.syncFiles).toBeGreaterThan(0);
  expect(files(outboxDir(w.home))).toEqual([]);
  const log = readFileSync(join(w.home, "purge-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { day: string; by: string; files: number });
  expect(log.some((l) => l.by === "sync-outbox" && l.day === "2026-10-19" && l.files === 1)).toBe(true);
  expect(new Outbox(w.home).list(later)).toEqual([]);
});

test("OUTBOX: the reader refuses an expired day even before the purge ran", async () => {
  await connect(w);
  await w.client.refreshConfig();
  await w.client.acknowledgeNotice(NOTICE_1);
  expect(new Outbox(w.home).list(NOW + 7 * DAY_MS)).toHaveLength(1);
  expect(new Outbox(w.home).list(NOW + 8 * DAY_MS)).toEqual([]);
  expect(purgeOutbox(w.home, NOW + 7 * DAY_MS).files).toBe(0);
});

test("OUTBOX: accepted objects leave the outbox; a flush with nothing new sends nothing", async () => {
  await connectAndAck(w);
  const r = await w.client.flush({ force: true });
  expect(r).toMatchObject({ envelopes: 1, sent: 1, accepted: 1, rejected: 0 });
  expect(new Outbox(w.home).list(NOW)).toEqual([]);
  expect((await w.client.flush({ force: true })).envelopes).toBe(0);
  expect(w.control.received).toHaveLength(1);
});

test("OUTBOX: a retryable rejection (rate_limited, server_error) stays queued and is retried after its backoff", async () => {
  await connectAndAck(w);
  const id = new Outbox(w.home).list(NOW)[0]!.id;
  w.control.rejectNext.set(id, { code: "server_error", retryable: true });
  const r1 = await w.client.flush({ force: true });
  expect(r1).toMatchObject({ rejected: 1, accepted: 0 });
  const e = new Outbox(w.home).list(NOW)[0]!;
  expect(e.attempts).toBe(1);
  expect(e.notBefore).toBe(NOW + backoffMs(1));
  // Within the backoff window it is held, not re-sent.
  expect((await w.client.flush({ force: true })).held).toBe(1);
  w.clock.now = e.notBefore!;
  const r3 = await w.client.flush({ force: true });
  expect(r3.accepted).toBe(1);
  expect(new Outbox(w.home).list(w.clock.now)).toEqual([]);
});

test("OUTBOX: a non-retryable rejection is dropped and logged, never retried, whatever its retryable flag says", async () => {
  await connectAndAck(w);
  const id = new Outbox(w.home).list(NOW)[0]!.id;
  w.control.rejectNext.set(id, { code: "validation_failed", retryable: true });
  const r = await w.client.flush({ force: true });
  expect(r.rejected).toBe(1);
  expect(new Outbox(w.home).list(NOW)).toEqual([]);
  expect(w.logs.some((l) => l.includes("rejected (validation_failed)"))).toBe(true);
});

test("OUTBOX: a duplicate rejection counts as delivered", async () => {
  await connectAndAck(w);
  const id = new Outbox(w.home).list(NOW)[0]!.id;
  w.control.rejectNext.set(id, { code: "duplicate", retryable: false });
  expect((await w.client.flush({ force: true })).accepted).toBe(1);
  expect(new Outbox(w.home).list(NOW)).toEqual([]);
});

test("OUTBOX: network failures, 429 and 5xx back off exponentially from 15 min to at most 6 h", async () => {
  expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([15, 30, 60, 120, 240, 360, 360, 360].map((m) => m * 60_000));
  expect(backoffMs(1)).toBe(DEFAULT_FLUSH_MS);
  expect(MAX_BACKOFF_MS).toBe(6 * 3_600_000);
  await connectAndAck(w);
  w.control.intercept = () => Response.json({ error: { code: "server_error", message: "down" } }, { status: 500 });
  for (let i = 1; i <= 3; i++) {
    const before = w.clock.now;
    await w.client.flush({ force: true });
    const st = w.client.status();
    expect(st.failures).toBe(i);
    expect(st.nextFlushAt).toBe(before + backoffMs(i));
    w.clock.now += 1000;
  }
  // Not forced: a flush inside the backoff window does nothing.
  expect((await w.client.flush()).skipped).toBe("backoff");
  expect(new Outbox(w.home).list(w.clock.now)).toHaveLength(1);
});

test("OUTBOX: a 429 with Retry-After waits at least that long", async () => {
  await connectAndAck(w);
  w.control.intercept = () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), { status: 429, headers: { "retry-after": "3600", "content-type": "application/json" } });
  await w.client.flush({ force: true });
  expect(w.client.status().nextFlushAt).toBe(NOW + 3_600_000);
});

test("OUTBOX: success resets the failure count and schedules the next flush after flushSeconds", async () => {
  await connectAndAck(w);
  w.control.intercept = () => Response.json({ error: { code: "server_error", message: "x" } }, { status: 502 });
  await w.client.flush({ force: true });
  w.control.intercept = null;
  w.control.config.flushSeconds = 600;
  await w.client.flush({ force: true });
  const st = w.client.status();
  expect(st.failures).toBe(0);
  expect(st.lastError).toBeNull();
  expect(st.nextFlushAt).toBe(NOW + 600_000);
});

test("OUTBOX: an invalid receipt from the server is not trusted: the objects stay queued", async () => {
  await connectAndAck(w);
  w.control.intercept = () => Response.json({ seq: 1, accepted: ["not-a-ulid"], rejected: [] });
  const r = await w.client.flush({ force: true });
  expect(r.error).toContain("does not match");
  expect(new Outbox(w.home).list(NOW)).toHaveLength(1);
});

test("OUTBOX: the background timer flushes when due and never throws on a damaged state file", async () => {
  await connectAndAck(w);
  const stop = w.client.start(20);
  try {
    for (let i = 0; i < 100 && w.control.received.length === 0; i++) await Bun.sleep(10);
    expect(w.control.received).toHaveLength(1);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(w.home, "sync", "state.json"), "{ not json");
    await Bun.sleep(60);
    expect(w.logs.some((l) => l.includes("sync flush failed"))).toBe(true);
  } finally {
    stop();
  }
});
