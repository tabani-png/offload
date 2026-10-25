// S2-02 test setup: a temp home, a movable clock, the fake control plane on 127.0.0.1, a fetch that refuses every
// non-loopback host (and records the hosts it saw), and a sync client wired to them.
import { SyncClient, type SyncDeps } from "../../src/sync/client.ts";
import { clearSyncKeyCache } from "../../src/sync/keys.ts";
import { clearBrainKeyCache } from "../../src/store/vault.ts";
import { tempHome } from "../helpers.ts";
import { FakeControl } from "./fake-control.ts";

export const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
export const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** Hosts every test fetch went to (HERMETIC). */
export const seenHosts = new Set<string>();

export const loopbackFetch: NonNullable<SyncDeps["fetch"]> = async (input, init) => {
  const host = new URL(input).hostname;
  seenHosts.add(host);
  if (!LOOPBACK.has(host)) throw new Error(`hermetic test: refused a request to ${host}`);
  return fetch(input, init);
};

/** The fake browser: follows the AuthKit URL, the control plane's redirect and the loopback callback. */
export const browser = async (url: string) => {
  await loopbackFetch(url);
};

export interface SyncWorld {
  home: string;
  clock: { now: number };
  control: FakeControl;
  client: SyncClient;
  logs: string[];
  /** A new client on the same home (a brain restart). */
  restart(over?: Partial<SyncDeps>): SyncClient;
  cleanup(): Promise<void>;
}

export async function syncWorld(opts: { home?: string; cleanupHome?: () => void; deps?: Partial<SyncDeps>; now?: number } = {}): Promise<SyncWorld> {
  clearSyncKeyCache();
  clearBrainKeyCache();
  const t = opts.home === undefined ? tempHome() : { home: opts.home, cleanup: opts.cleanupHome ?? (() => {}) };
  const clock = { now: opts.now ?? NOW };
  const control = new FakeControl(clock).start();
  const logs: string[] = [];
  const make = (over: Partial<SyncDeps> = {}) =>
    new SyncClient({ home: t.home, now: () => clock.now, controlUrl: control.url, fetch: loopbackFetch, openUrl: browser, log: (l) => logs.push(l), timezone: "America/Toronto", ...(opts.deps ?? {}), ...over });
  const w: SyncWorld = {
    home: t.home,
    clock,
    control,
    client: make(),
    logs,
    restart(over = {}) {
      clearSyncKeyCache();
      w.client = make(over);
      return w.client;
    },
    async cleanup() {
      await control.stop();
      t.cleanup();
    },
  };
  return w;
}

/** Connects the world's client (PKCE loopback flow against the fake). */
export async function connect(w: SyncWorld): Promise<void> {
  await w.client.connect();
  await w.client.connectIdle();
  if (w.client.status().state !== "connected") throw new Error(`connect failed: ${w.client.status().lastError}`);
}

/** Connects and acknowledges the required notice. */
export async function connectAndAck(w: SyncWorld): Promise<void> {
  await connect(w);
  await w.client.refreshConfig();
  const n = w.control.config.requiredNotice;
  if (n !== null) await w.client.acknowledgeNotice(n.noticeVersionId);
}

// ---------- the s09 demo fixture behind the sync client ----------

import { makeBatch, type Batch } from "../../src/workflows/batch.ts";
import { observedInstances } from "../../src/workflows/observed.ts";
import { saveBatch } from "../../src/workflows/store.ts";
import { world, type World } from "../s05-workflows/setup.ts";
import { WORKFLOW } from "./fake-control.ts";

export interface FixtureSyncWorld extends SyncWorld {
  fixture: World;
  batch: Batch;
}

/** The s05/s09 fixture week (≈100 outreach emails a day) with the outreach workflow drafted, one live batch of 20
 * observed recipients sent on 2026-10-16 (drafts = what the person really wrote), and the workflow bound to a
 * company workflow. The clock is 2026-10-19 12:00 UTC, so 2026-10-12..18 are completed days. */
export async function fixtureSyncWorld(opts: { bind?: boolean } = {}): Promise<FixtureSyncWorld> {
  const fixture = await world();
  const w = await syncWorld({ home: fixture.home, cleanupHome: fixture.cleanup, deps: { analysis: async () => fixture.analysis } });
  const obs = observedInstances(fixture.analysis, fixture.outreach.taskId, { limit: 20 }).instances;
  const sentAt = new Date(2026, 9, 16, 15, 0).getTime();
  const b = makeBatch(fixture.outreach.id, "live", obs.map((o) => ({ key: o.recipient.email, to: o.recipient.email, subject: o.subject, body: o.excerpt, warnings: [] })), sentAt - 600_000);
  b.state = "sent";
  b.approvedAt = sentAt - 60_000;
  b.itemStates = Object.fromEntries(b.items.map((i, k) => [i.key, { state: "sent" as const, at: sentAt + k * 1000, tool: "mcp__gmail__send_email" }]));
  b.results = b.items.map((i, k) => ({ key: i.key, tool: "mcp__gmail__send_email", ok: true, at: sentAt + k * 1000 }));
  b.sealDay = "2026-10-16";
  saveBatch(fixture.home, b);
  if (opts.bind !== false) w.client.bind(fixture.outreach.id, { workflowId: WORKFLOW, version: 1 });
  return { ...w, fixture, batch: b };
}
