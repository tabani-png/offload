// Shared s09b setup: the s05 world (fixture week, stub tone pack, drafted outreach workflow) behind createBrain,
// with a movable clock, a send-counting executor and an optional observer env.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrain, type Brain, type BrainOptions } from "../../src/api/server.ts";
import { ScriptedExecutor, sendEachItem } from "../../src/workflows/executor.ts";
import { world, type World } from "../s05-workflows/setup.ts";

export const TOKEN = "t".repeat(40);
export const SEND = "mcp__gmail__send_email";

export interface S09bWorld extends World {
  brain: Brain;
  clock: { now: number };
  sends: Array<Record<string, unknown>>;
  call<T>(path: string, init?: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> }): Promise<{ status: number; body: T; headers: Headers }>;
}

/** Local wall-clock time (the scheduler and cron work in local time). */
export const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

export async function s09bWorld(opts: { now?: number; observerEnv?: BrainOptions["observerEnv"]; modelLabel?: "stub" | "real"; tone?: boolean } = {}): Promise<S09bWorld> {
  const w = await world(opts.tone === undefined ? {} : { tone: opts.tone });
  const clock = { now: opts.now ?? local(2026, 10, 19, 8, 0) };
  const sends: Array<Record<string, unknown>> = [];
  const brain = createBrain({
    home: w.home,
    token: TOKEN,
    now: () => clock.now,
    workflows: {
      model: w.model,
      executor: new ScriptedExecutor({ [SEND]: async (input) => void sends.push(input as Record<string, unknown>) }, sendEachItem(SEND)),
      env: { GMAIL_OAUTH_PATH: "/tmp/creds.json" },
      ...(opts.modelLabel === undefined ? {} : { modelLabel: opts.modelLabel }),
    },
    ...(opts.observerEnv === undefined ? {} : { observerEnv: opts.observerEnv }),
  });
  const out: S09bWorld = {
    ...w,
    brain,
    clock,
    sends,
    async call<T>(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? TOKEN}`, ...(init.headers ?? {}) };
      let body: string | undefined;
      if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["content-type"] = "application/json";
      }
      // out.brain, so a test may swap the brain (e.g. a different observer env) and keep using call().
      const r = await out.brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method: init.method ?? "GET", headers, ...(body === undefined ? {} : { body }) }));
      return { status: r.status, body: (await r.json()) as T, headers: r.headers };
    },
  };
  return out;
}

/** Gmail connected: a connectors.json server for the gmail catalog id whose env var is set in the world's env. */
export function connectGmail(home: string): void {
  writeFileSync(join(home, "connectors.json"), JSON.stringify({ version: 1, servers: { gmail: { type: "stdio", command: "npx", args: ["-y", "gmail-mcp"], envFromEnv: { GMAIL_OAUTH_PATH: "GMAIL_OAUTH_PATH" }, catalog: ["gmail"] } } }));
}
