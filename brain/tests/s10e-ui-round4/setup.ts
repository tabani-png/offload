// Shared s10e setup: the s09b world (fixture week, stub tone pack, drafted outreach workflow, movable clock) with a
// brain that takes the connect-link options (demo sign-in time, a fake command runner) and counts executor runs.
import { createBrain, type Brain } from "../../src/api/server.ts";
import type { Env } from "../../src/connectors/config.ts";
import type { LinkRunner, LinkRunResult } from "../../src/connectors/link.ts";
import { ScriptedExecutor, sendEachItem, type ExecJob, type Executor } from "../../src/workflows/executor.ts";
import { s09bWorld, SEND, TOKEN, type S09bWorld } from "../s09b-brain/setup.ts";

export { SEND, TOKEN };

/** Words the app's plain-words lint refuses in text shown to a person. */
export const BANNED_RE = /key|token|mcp|skill|gate|json|env/i;

export interface LinkWorld extends S09bWorld {
  executorRuns: ExecJob[];
  logs: string[];
  /** Replaces the brain on the same home (e.g. the real model after a demo sign-in). */
  rebuild(o?: BrainOpts): void;
}

export interface BrainOpts {
  modelLabel?: "stub" | "real";
  linkMs?: number;
  runner?: LinkRunner;
  env?: Env;
}

export async function linkWorld(o: BrainOpts = {}): Promise<LinkWorld> {
  const x = (await s09bWorld({})) as LinkWorld;
  x.executorRuns = [];
  x.logs = [];
  const inner = new ScriptedExecutor({ [SEND]: async (input) => void x.sends.push(input as Record<string, unknown>) }, sendEachItem(SEND));
  const executor: Executor = {
    execute(job) {
      x.executorRuns.push(job);
      return inner.execute(job);
    },
  };
  x.rebuild = (b: BrainOpts = o): void => {
    const brain: Brain = createBrain({
      home: x.home,
      token: TOKEN,
      now: () => x.clock.now,
      log: (l) => void x.logs.push(l),
      workflows: { model: x.model, executor, env: b.env ?? {}, modelLabel: b.modelLabel ?? "stub" },
      link: { ...(b.linkMs === undefined ? {} : { linkMs: b.linkMs }), ...(b.runner === undefined ? {} : { runner: b.runner }) },
    });
    x.brain = brain;
  };
  x.rebuild(o);
  return x;
}

/** A runner that never spawns: records every argv and env, answers from `reply`. */
export class FakeRunner implements LinkRunner {
  readonly calls: Array<{ argv: string[]; env: Record<string, string>; timeoutMs: number }> = [];
  constructor(public reply: (argv: readonly string[]) => LinkRunResult | Promise<LinkRunResult>) {}
  async run(argv: readonly string[], opts: { timeoutMs: number; env: Record<string, string> }): Promise<LinkRunResult> {
    this.calls.push({ argv: [...argv], env: { ...opts.env }, timeoutMs: opts.timeoutMs });
    return this.reply(argv);
  }
}

export const ok = (stdout: string): LinkRunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
