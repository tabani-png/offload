// Shared s05c route setup: the s05 world (fixture week, stub tone pack, drafted outreach workflow) behind createBrain.
import { createBrain, type Brain, type BrainOptions } from "../../src/api/server.ts";
import { ScriptedExecutor, sendEachItem } from "../../src/workflows/executor.ts";
import { NOW, world, type World } from "../s05-workflows/setup.ts";

export const TOKEN = "t".repeat(40);
export const SEND = "mcp__gmail__send_email";

export interface RouteWorld extends World {
  brain: Brain;
  call<T>(path: string, init?: { method?: string; body?: unknown; raw?: string; token?: string }): Promise<{ status: number; body: T }>;
}

export async function routeWorld(opts: { tone?: boolean; now?: () => number; observerEnv?: BrainOptions["observerEnv"] } = {}): Promise<RouteWorld> {
  const w = await world(opts.tone === undefined ? {} : { tone: opts.tone });
  const brain = createBrain({
    home: w.home,
    token: TOKEN,
    now: opts.now ?? (() => NOW),
    workflows: { model: w.model, executor: new ScriptedExecutor({ [SEND]: async () => {} }, sendEachItem(SEND)), env: { GMAIL_OAUTH_PATH: "/tmp/creds.json" } },
    ...(opts.observerEnv === undefined ? {} : { observerEnv: opts.observerEnv }),
  });
  return {
    ...w,
    brain,
    async call<T>(path: string, init: { method?: string; body?: unknown; raw?: string; token?: string } = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? TOKEN}` };
      let body: string | undefined;
      if (init.raw !== undefined || init.body !== undefined) {
        body = init.raw ?? JSON.stringify(init.body);
        headers["content-type"] = "application/json";
      }
      const r = await brain.handle(new Request(`http://127.0.0.1:4545${path}`, { method: init.method ?? "GET", headers, ...(body === undefined ? {} : { body }) }));
      return { status: r.status, body: (await r.json()) as T };
    },
  };
}
