// s24 CLI (brain/src/cli.ts dispatches `build` here):
//   build --solution N|ins_ID|held:N --option n --home DIR [--model stub|real] [--json]
//       the brief of option n (drafted if needed) and its frozen check script; prints both hashes. Nothing is built.
//   build approve --brief sol_ID --brief-hash H --check-hash C --home DIR [--json]   -> the single-use build token
//   build run --brief sol_ID --token T --home DIR [--max-tries N] [--max-usd X] [--json]   dry-run build
//   build record --run run_ID --home DIR                                                the run record (JSON)
// Like `solutions`, the check writer is the stub model unless --model is given.
import { analyzeHome } from "../analyze.ts";
import { readUserContext } from "../context/store.ts";
import { createRoutedModel } from "../models/factory.ts";
import { loadModelConfig, StubModel } from "../models/model.ts";
import { approveBuild } from "./approval.ts";
import { readRunRecord } from "./record.ts";
import { runBuild } from "./runner.ts";
import { profileFromEnv } from "./sandbox.ts";
import { builderQuery, prepareBuild } from "./service.ts";

export class BuildUsageError extends Error {}

function flags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.set("json", "1");
    else if (a.startsWith("--") && argv[i + 1] !== undefined) out.set(a.slice(2), argv[++i]!);
    else throw new BuildUsageError(`unknown argument ${a}`);
  }
  return out;
}

const need = (f: Map<string, string>, k: string, what: string) => {
  const v = f.get(k);
  if (v === undefined || v === "") throw new BuildUsageError(`build ${what} needs --${k}`);
  return v;
};

export async function buildCommand(argv: readonly string[]): Promise<number> {
  const sub = argv[0] === "approve" || argv[0] === "run" || argv[0] === "record" ? argv[0] : "prepare";
  const f = flags(sub === "prepare" ? argv : argv.slice(1));
  const home = need(f, "home", sub);
  const json = f.has("json");
  if (sub === "record") {
    const r = readRunRecord(home, need(f, "run", sub));
    if (r === null) throw new BuildUsageError("no such run");
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (sub === "approve") {
    const r = approveBuild(home, need(f, "brief", sub), need(f, "brief-hash", sub), need(f, "check-hash", sub), Date.now());
    console.log(json ? JSON.stringify(r) : `approved the build of ${f.get("brief")} (brief ${r.briefHash.slice(0, 12)}, check ${r.checkHash.slice(0, 12)}); build token (shown once, single use): ${r.token}`);
    return 0;
  }
  if (sub === "run") {
    const num = (k: string) => (f.has(k) ? Number(f.get(k)) : undefined);
    const limits = { ...(num("max-tries") === undefined ? {} : { maxTries: num("max-tries")! }), ...(num("max-usd") === undefined ? {} : { maxUsd: num("max-usd")! }) };
    const r = await runBuild({ home, briefId: need(f, "brief", sub), token: need(f, "token", sub), query: await builderQuery(), profile: profileFromEnv(), limits });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(`${r.outcome} after ${r.tries.length} tr${r.tries.length === 1 ? "y" : "ies"}, $${r.totals.costUsd.toFixed(2)}${r.reason === null ? "" : ` (${r.reason})`}\n  run: ${r.id}\n  dry run, nothing installed. files: ${r.artifactPath}`);
    return r.outcome === "PASS" ? 0 : 1;
  }
  const option = Number(need(f, "option", "--solution"));
  if (!Number.isInteger(option) || option < 1) throw new BuildUsageError("--option must be a whole number from 1");
  const ref = need(f, "solution", "");
  const model = f.has("model") ? createRoutedModel({ home, stub: f.get("model") === "stub" }) : new StubModel();
  const user = readUserContext(home).context;
  const a = await analyzeHome(home, user === undefined ? {} : { userContext: user });
  const r = await prepareBuild({ home, analysis: a, ref, option, model, models: loadModelConfig(home), modelLabel: f.has("model") && f.get("model") !== "stub" ? "router:build_checks" : "stub", now: Date.now, ...(user === undefined ? {} : { user }) });
  if (json) console.log(JSON.stringify({ briefId: r.brief.id, briefHash: r.brief.hash, checks: r.checks, content: r.content }, null, 2));
  else
    console.log(
      `brief ${r.brief.id} [${r.brief.kind}]: ${r.brief.what}\n  check script ${r.checks.file} sha256 ${r.checks.sha256}\n  review: ${home.replace(/\/$/, "")}/solutions/${r.brief.id}/BUILD.md\n  approve: build approve --brief ${r.brief.id} --brief-hash ${r.brief.hash} --check-hash ${r.checks.sha256} --home ${home}`,
    );
  return 0;
}
