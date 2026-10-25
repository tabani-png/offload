// s09b: POST /observer/pause and /observer/resume run `offload-observer pause|resume --home HOME` and answer with the
// fresh GET /observer report, so the app no longer shells out itself.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorResponse, ObserverControlResponse } from "../../src/api/types.ts";
import { FAKE_OBSERVER } from "../s05c-keys/fake.ts";
import { s09bWorld, type S09bWorld } from "./setup.ts";

let w: S09bWorld | null = null;
afterEach(() => {
  w?.cleanup();
  w = null;
});

const STATUS = { schemaVersion: 1, home: "/x", running: true, paused: true, daysStored: [], keepDays: 7, keysMode: "keychain", keyFiles: { raw: 0, wrapped: 0 }, permissions: null, permissionsSource: "unknown", days: [], nextPurgeAt: null, nextExpiry: null, heartbeat: null };

async function withFake(extra: Record<string, string> = {}): Promise<{ w: S09bWorld; log: string }> {
  // The log and status file live in the world's home; the brain is rebuilt with an env that points at them.
  const ww = await s09bWorld();
  const log = join(ww.home, "obs.log");
  const status = join(ww.home, "status.json");
  writeFileSync(status, JSON.stringify(STATUS));
  const brainEnv = { OFFLOAD_OBSERVER_BIN: FAKE_OBSERVER, FAKE_OBSERVER_LOG: log, FAKE_OBSERVER_STATUS: status, ...extra };
  const { createBrain } = await import("../../src/api/server.ts");
  ww.brain = createBrain({ home: ww.home, token: "t".repeat(40), now: () => ww.clock.now, workflows: { model: ww.model, env: {} }, observerEnv: brainEnv });
  return { w: ww, log };
}

describe("s09b observer pause / resume", () => {
  test("OBSCTL: POST /observer/pause runs `pause --home HOME` and returns the fresh observer status", async () => {
    const f = await withFake();
    w = f.w;
    const r = await w.call<ObserverControlResponse>("/observer/pause", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, action: "pause", ok: true });
    expect(r.body.observer.available).toBe(true);
    expect(r.body.observer.status?.paused).toBe(true);
    const log = readFileSync(f.log, "utf8");
    expect(log).toContain(`pause --home ${w.home}`);
    // pause first, then the status read.
    expect(log.indexOf("pause")).toBeLessThan(log.indexOf("status --json"));
    expect(existsSync(join(w.home, "paused"))).toBe(true);
  });

  test("OBSCTL: POST /observer/resume runs `resume --home HOME`", async () => {
    const f = await withFake();
    w = f.w;
    await w.call("/observer/pause", { method: "POST" });
    const r = await w.call<ObserverControlResponse>("/observer/resume", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.action).toBe("resume");
    expect(readFileSync(f.log, "utf8")).toContain(`resume --home ${w.home}`);
    expect(existsSync(join(w.home, "paused"))).toBe(false);
  });

  test("OBSCTL: an observer that exits non-zero is a 409 conflict with its stderr; nothing is claimed", async () => {
    const f = await withFake({ FAKE_OBSERVER_CONTROL_EXIT: "1" });
    w = f.w;
    const r = await w.call<ErrorResponse>("/observer/pause", { method: "POST" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("conflict");
    expect(r.body.message).toContain("observer is not running");
  });

  test("OBSCTL: a missing observer binary is a 409 that names the binary", async () => {
    w = await s09bWorld({ observerEnv: { OFFLOAD_OBSERVER_BIN: "/nonexistent/offload-observer" } });
    const r = await w.call<ErrorResponse>("/observer/resume", { method: "POST" });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("/nonexistent/offload-observer");
  });

  test("OBSCTL: GET is 405, an unknown action 404, no token 401, a foreign Origin 403", async () => {
    const f = await withFake();
    w = f.w;
    expect((await w.call("/observer/pause")).status).toBe(405);
    expect((await w.call("/observer/stop", { method: "POST" })).status).toBe(404);
    expect((await w.call("/observer/pause", { method: "POST", token: "x".repeat(40) })).status).toBe(401);
    expect((await w.call("/observer/pause", { method: "POST", headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect(existsSync(f.log) ? readFileSync(f.log, "utf8") : "").not.toContain("pause --home");
  });
});
