// HERMETIC: no S2-02 test opens a non-loopback socket. Every listener binds 127.0.0.1, every request goes through a
// fetch that refuses other hosts, and a brain without OFFLOAD_CONTROL_URL makes no request at all.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";
import { StubModel } from "../../src/models/model.ts";
import { startLoopback } from "../../src/sync/enroll.ts";
import { tempHome } from "../helpers.ts";
import { NOTICE_1 } from "./fake-control.ts";
import { connectAndAck, LOOPBACK, loopbackFetch, seenHosts, syncWorld, type SyncWorld } from "./setup.ts";

const realFetch = globalThis.fetch;
const globalHosts = new Set<string>();
let w: SyncWorld;
beforeEach(() => {
  // Every fetch in this file, including the fake browser's, is recorded and refused off the loopback address.
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      globalHosts.add(u.hostname);
      if (!LOOPBACK.has(u.hostname)) throw new Error(`hermetic: refused ${u.hostname}`);
      return realFetch(input, init);
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await w?.cleanup();
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("HERMETIC: a full connect, ack, preview and flush touches only 127.0.0.1", async () => {
  w = await syncWorld();
  await connectAndAck(w);
  await w.client.preview();
  await w.client.flush({ force: true });
  expect(w.control.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect([...globalHosts].every((h) => LOOPBACK.has(h))).toBe(true);
  expect([...seenHosts].every((h) => LOOPBACK.has(h))).toBe(true);
  expect(globalHosts.size).toBeGreaterThan(0);
});

test("HERMETIC: the test fetch refuses any other host", async () => {
  const host = ["control", "example"].join(".");
  await expect(loopbackFetch(`https://${host}/v1/sync/config`)).rejects.toThrow("refused");
});

test("HERMETIC: the enrollment callback listener binds 127.0.0.1 only", () => {
  const flow = startLoopback("http://127.0.0.1:9", { timeoutMs: 1000 });
  try {
    expect(new URL(flow.redirectUri).hostname).toBe("127.0.0.1");
    expect(new URL(flow.authorizeUrl).searchParams.get("redirect_uri")).toBe(flow.redirectUri);
  } finally {
    flow.close();
  }
});

test("HERMETIC: a brain without OFFLOAD_CONTROL_URL never makes a sync request", async () => {
  w = await syncWorld();
  const t = tempHome();
  let calls = 0;
  try {
    const brain = createBrain({ home: t.home, token: "h".repeat(40), workflows: { model: new StubModel(), env: {} }, sync: { env: {}, fetch: async () => ((calls += 1), Promise.reject(new Error("no network"))) } });
    for (const [m, p] of [["GET", "/sync/status"], ["GET", "/sync/preview"], ["POST", "/sync/pause"], ["POST", "/sync/notice/ack"]] as const) {
      await brain.handle(new Request(`http://127.0.0.1:4545${p}`, { method: m, headers: { authorization: `Bearer ${"h".repeat(40)}`, ...(m === "POST" ? { "content-type": "application/json" } : {}) }, ...(p === "/sync/notice/ack" ? { body: JSON.stringify({ noticeVersionId: NOTICE_1 }) } : {}) }));
    }
    expect((await brain.sync.flush({ force: true })).skipped).toBe("not_connected");
    expect(calls).toBe(0);
  } finally {
    t.cleanup();
  }
});

test("HERMETIC: no S2-02 test file names a non-loopback URL", () => {
  const dir = import.meta.dir;
  const bad: string[] = [];
  for (const f of readdirSync(dir)) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/https?:\/\/[A-Za-z0-9.-]+/g)) if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(m[0])) bad.push(`${f}: ${m[0]}`);
  }
  expect(bad).toEqual([]);
});
