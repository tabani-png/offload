// s24 service: from a solution option to frozen checks (prepareBuild), and the SDK the runner uses. The real SDK is
// `query` from @anthropic-ai/claude-agent-sdk (ADR 0004). Tests of the CLI and the server swap it for a recorded fake
// through OFFLOAD_BUILDER_FAKE_SDK, honoured only when NODE_ENV is "test".
import type { Analysis } from "../analyze.ts";
import type { Model, ModelConfig } from "../models/model.ts";
import { BriefError, type SolutionBrief } from "../solutions/brief.ts";
import { chooseSolution, designSolutions } from "../solutions/service.ts";
import type { UserContext } from "../types.ts";
import { writeChecks, type CheckSet, type Mask } from "./checks.ts";
import type { BuilderQuery } from "./runner.ts";

export interface PrepareResult {
  brief: SolutionBrief;
  checks: CheckSet;
  content: string;
  buildMd: string;
}

/** Option n (1-based, in the set's ranked order) of the solution set for `ref`: its brief (drafted if needed) and the
 * frozen check script. Nothing is built. */
export async function prepareBuild(o: { home: string; analysis: Analysis; ref: string; option: number; model: Model; models: ModelConfig; modelLabel: string; user?: UserContext; mask?: Mask; now: () => number }): Promise<PrepareResult> {
  const { set } = await designSolutions({ analysis: o.analysis, ref: o.ref, model: o.model, models: o.models, ...(o.user === undefined ? {} : { user: o.user }) });
  const option = set.options[o.option - 1];
  if (option === undefined) throw new BriefError(`no option #${o.option} (there are ${set.options.length})`, "not_found");
  if (option.handoff.to !== "brief") throw new BriefError(`option #${o.option} is ${option.kind}: only tool, setup and remove_step options have a brief to build`, "bad_request");
  const r = await chooseSolution({ home: o.home, analysis: o.analysis, set, kind: option.kind, model: o.model, models: o.models, now: o.now, ...(o.user === undefined ? {} : { user: o.user }) });
  if (r.kind === "workflow") throw new BriefError("a workflow has no brief", "bad_request");
  const c = await writeChecks({ home: o.home, briefId: r.brief.id, model: o.model, models: o.models, modelLabel: o.modelLabel, now: o.now(), ...(o.mask === undefined ? {} : { mask: o.mask }) });
  return { brief: r.brief, checks: c.set, content: c.content, buildMd: c.buildMd };
}

/** The Agent SDK's query(), or the test fake. */
export async function builderQuery(env: Readonly<Record<string, string | undefined>> = process.env): Promise<BuilderQuery> {
  const fake = env.OFFLOAD_BUILDER_FAKE_SDK;
  if (fake !== undefined && fake !== "" && env.NODE_ENV === "test") return ((await import(fake)) as { query: BuilderQuery }).query;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  return query as unknown as BuilderQuery;
}
