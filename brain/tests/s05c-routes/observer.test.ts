// s05c: GET /observer proxies `offload-observer status --json --home HOME` (schemaVersion 1), permissions included.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorResponse, ObserverResponse } from "../../src/api/types.ts";
import { FAKE_OBSERVER } from "../s05c-keys/fake.ts";
import { tempHome } from "../helpers.ts";
import { routeWorld, type RouteWorld } from "./setup.ts";

let w: RouteWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const STATUS = {
  daysStored: ["2026-10-18", "2026-10-19"],
  days: [
    { day: "2026-10-18", encrypted: true, events: 120, plain: false },
    { day: "2026-10-19", encrypted: true, events: 40, plain: false },
  ],
  heartbeat: { pid: 4242, startedAt: 1, lastTick: 2, paused: false, idle: false, plain: false, eventsWritten: 160, writeErrors: 0, ocrErrors: 3, permissions: { accessibility: true, inputMonitoring: false, screenRecording: true } },
  home: "/Users/x/Library/Application Support/Offload",
  keepDays: 7,
  keyFiles: { raw: 0, wrapped: 2 },
  keysMode: "keychain",
  nextExpiry: { at: 1761451200000, day: "2026-10-18" },
  nextPurgeAt: 1760900000000,
  paused: false,
  permissions: { accessibility: true, inputMonitoring: false, screenRecording: true },
  permissionsSource: "heartbeat",
  running: true,
  schemaVersion: 1,
};

async function observerWith(env: Record<string, string>): Promise<RouteWorld> {
  return await routeWorld({ observerEnv: { OFFLOAD_OBSERVER_BIN: FAKE_OBSERVER, ...env } });
}

describe("s05c observer route", () => {
  test("OBSERVER: GET /observer returns the observer's status --json with its permissions", async () => {
    const t = tempHome();
    try {
      const file = join(t.home, "status.json");
      const log = join(t.home, "obs.log");
      writeFileSync(file, JSON.stringify(STATUS, null, 2));
      w = await observerWith({ FAKE_OBSERVER_STATUS: file, FAKE_OBSERVER_LOG: log });
      const r = await w.call<ObserverResponse>("/observer");
      expect(r.status).toBe(200);
      expect(r.body.available).toBe(true);
      expect(r.body.error).toBeNull();
      expect(r.body.bin).toBe(FAKE_OBSERVER);
      expect(r.body.permissions).toEqual({ screenRecording: true, accessibility: true, inputMonitoring: false });
      expect(r.body.status).toMatchObject({ schemaVersion: 1, running: true, keysMode: "keychain", permissionsSource: "heartbeat", daysStored: STATUS.daysStored, nextPurgeAt: STATUS.nextPurgeAt });
      expect(r.body.status?.heartbeat).toMatchObject({ pid: 4242, ocrErrors: 3 });
      expect(readFileSync(log, "utf8")).toContain(`status --json --home ${w.home}`);
    } finally {
      t.cleanup();
    }
  });

  test("OBSERVER: a missing binary is 200 with available false and an error naming OFFLOAD_OBSERVER_BIN", async () => {
    w = await routeWorld({ observerEnv: { OFFLOAD_OBSERVER_BIN: "/nonexistent/offload-observer" } });
    const r = await w.call<ObserverResponse>("/observer");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: false, status: null, permissions: null, bin: "/nonexistent/offload-observer" });
    expect(r.body.error).toContain("OFFLOAD_OBSERVER_BIN");
  });

  test("OBSERVER: a non-zero exit, non-JSON output or an unknown schemaVersion is available false with the reason", async () => {
    const base = await routeWorld();
    const bad = join(base.home, "bad.txt");
    const v2 = join(base.home, "v2.json");
    writeFileSync(bad, "not json");
    writeFileSync(v2, JSON.stringify({ ...STATUS, schemaVersion: 2 }));
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ FAKE_OBSERVER_EXIT: "1" }, /exited 1/],
      [{ FAKE_OBSERVER_STATUS: bad }, /not JSON/],
      [{ FAKE_OBSERVER_STATUS: v2 }, /schemaVersion 2/],
    ];
    try {
      for (const [env, re] of cases) {
        const x = await observerWith(env);
        try {
          const r = await x.call<ObserverResponse>("/observer");
          expect(r.status).toBe(200);
          expect(r.body.available).toBe(false);
          expect(r.body.error ?? "").toMatch(re);
          expect(r.body.status).toBeNull();
        } finally {
          x.cleanup();
        }
      }
    } finally {
      base.cleanup();
    }
  });

  test("OBSERVER: GET only, token required", async () => {
    w = await observerWith({});
    expect((await w.call<ErrorResponse>("/observer", { method: "POST", body: {} })).status).toBe(405);
    expect((await w.call<ErrorResponse>("/observer", { token: "wrong" })).status).toBe(401);
  });
});
