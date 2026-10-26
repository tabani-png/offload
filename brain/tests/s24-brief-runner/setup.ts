// s24 test setup: a draft brief on disk (the s22 LinkedIn remove_step fixture, through the real s22 code), a fake
// router backend replaying the recorded check-writer reply, and a fake Agent SDK query() that acts in the workspace
// like a builder would (writes files, asks canUseTool) and replies with recorded result messages.
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChecks } from "../../src/builder/checks.ts";
import type { BuilderQuery } from "../../src/builder/runner.ts";
import { DEFAULT_MODELS } from "../../src/models/model.ts";
import { ModelRouter, RoutedModel, type Backend, type BackendRequest } from "../../src/models/router.ts";
import { writeBrief } from "../../src/solutions/brief.ts";
import { rulesSolutions } from "../../src/solutions/rules.ts";
import { buildFixture, LINKEDIN_IMAGE } from "../s22-solution-designer/fixtures.ts";

process.env.OFFLOAD_KEYS ??= "file";
export const NOW = new Date(2026, 9, 26, 12).getTime();
export const REC = join(import.meta.dir, "recorded");
export const CHECK_REPLY = readFileSync(join(REC, "check-writer.json"), "utf8");

export const tmp = (prefix = "offload-s24-") => mkdtempSync(join(tmpdir(), prefix));

export function briefHome(): { home: string; briefId: string; briefHash: string } {
  const home = tmp();
  const f = buildFixture(LINKEDIN_IMAGE);
  const set = rulesSolutions({ subject: f.subject, task: f.task, windowDays: 7, stepOf: f.stepOf });
  const option = set.options.find((o) => o.kind === "remove_step")!;
  const { brief } = writeBrief(home, set, option, NOW);
  return { home, briefId: brief.id, briefHash: brief.hash };
}

/** The router over a fake backend: records each request, answers with `reply`. */
export function fakeRouted(home: string, reply: string | ((r: BackendRequest) => string) = CHECK_REPLY) {
  const calls: BackendRequest[] = [];
  const backend: Backend = {
    kind: "api",
    metered: true,
    async complete(req) {
      calls.push(req);
      return { text: typeof reply === "string" ? reply : reply(req), stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0 }, model: req.model };
    },
  };
  return { model: new RoutedModel(new ModelRouter({ home, backend, monthlyBudgetUsd: null, env: {} })), calls };
}

export async function prepared() {
  const b = briefHome();
  const { model, calls } = fakeRouted(b.home);
  const c = await writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "router:build_checks", now: NOW });
  return { ...b, checkHash: c.set.sha256, checks: c, calls };
}

export interface FakeTry {
  /** Runs in the workspace before the result: write files, call canUseTool. */
  act?: (ws: string, options: Parameters<BuilderQuery>[0]["options"]) => Promise<void> | void;
  costUsd?: number;
  turns?: number;
  subtype?: string;
  throws?: string;
}

/** A fake query(): try i plays tries[i] (the last one repeats). Records every prompt and options. */
export function fakeQuery(tries: FakeTry[]) {
  const seen: Array<Parameters<BuilderQuery>[0]> = [];
  const query: BuilderQuery = (args) => {
    seen.push(args);
    const t = tries[Math.min(seen.length - 1, tries.length - 1)]!;
    return (async function* () {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.310", model: "claude-sonnet-5-5", cwd: args.options.cwd, tools: args.options.tools };
      if (t.throws !== undefined) throw new Error(t.throws);
      await t.act?.(args.options.cwd!, args.options);
      yield { type: "result", subtype: t.subtype ?? "success", num_turns: t.turns ?? 4, total_cost_usd: t.costUsd ?? 0.05, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 }, modelUsage: { "claude-sonnet-5-5": {} }, result: "done" };
    })();
  };
  return { query, seen };
}

export const writeSlug = (which: "good" | "bad") => (ws: string) => copyFileSync(join(REC, `slug-${which}.py`), join(ws, "slug.py"));
