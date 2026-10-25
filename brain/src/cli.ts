// brain CLI.
//   bun run brain/src/cli.ts analyze --home DIR [--top N] [--review-seconds S] [--json]
//   bun run brain/src/cli.ts serve   --home DIR [--port P]        (token: OFFLOAD_TOKEN, or generated and printed once)
import { analyzeHome, type Analysis } from "./analyze.ts";
import { startBrainServer, resolveToken } from "./api/server.ts";
import { toInsights } from "./api/dto.ts";

const USAGE = `usage:
  bun run brain/src/cli.ts analyze --home DIR [--top N] [--review-seconds S] [--json]
  bun run brain/src/cli.ts serve --home DIR [--port P]`;

class UsageError extends Error {}

interface Args {
  command: "analyze" | "serve";
  home: string;
  top: number;
  reviewSeconds: number | undefined;
  json: boolean;
  port: number;
}

function parse(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "analyze" && command !== "serve") throw new UsageError(`unknown command ${command ?? "(none)"}`);
  const args: Args = { command, home: "", top: 5, reviewSeconds: undefined, json: false, port: 0 };
  const num = (flag: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number in [${min}, ${max}]`);
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--home") args.home = rest[++i] ?? "";
    else if (a === "--top") args.top = Math.floor(num(a, rest[++i], 1, 100));
    else if (a === "--review-seconds") args.reviewSeconds = num(a, rest[++i], 1, 600);
    else if (a === "--json") args.json = true;
    else if (a === "--port") args.port = Math.floor(num(a, rest[++i], 0, 65535));
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (args.home === "") throw new UsageError("--home DIR is required");
  return args;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatReport(a: Analysis, top: number): string {
  const days = a.windowDays;
  const lines: string[] = [];
  const range = days.length === 0 ? "no days" : `${days[0]}..${days[days.length - 1]}`;
  lines.push(`Offload brain: ${days.length} days (${range}), ${a.events.length} events, ${a.store.badLineCount} bad lines, ${(a.totalActiveMs / 3_600_000).toFixed(1)} h active, ${a.tasks.length} tasks`);
  for (const d of a.store.days) for (const e of d.errors) lines.push(`  warning ${d.day}: ${e}`);
  if (a.insights.length === 0) lines.push("", "No insights yet: nothing repeats enough to automate.");
  for (const i of a.insights.slice(0, top)) {
    const s = i.stats;
    const conn = i.connectors.all.map((c) => `${c.name} (${c.how})`).join(", ") || "none";
    lines.push(
      "",
      `#${i.rank} ${i.label.name}  [${i.label.kind}]  score ${i.score.value.toFixed(4)}`,
      `   ${i.label.description}`,
      `   share ${pct(s.share.value)} · ${s.instancesPerDay.value.toFixed(1)}/day on ${s.daysActive.value} days · median ${s.medianMinutes.value.toFixed(1)} min · p90 ${s.p90Minutes.value.toFixed(1)} min · sameness ${s.sameness.value.toFixed(2)}`,
      `   judgement ${i.judge.judgement.toFixed(2)} · risk ${i.judge.risk.toFixed(2)} (${i.judge.reasons.join("; ")})`,
      `   connect: ${conn}`,
      `   ${i.saving.arithmetic}`,
      `   range: saves ${i.saving.range.low.hoursSaved.toFixed(1)}-${i.saving.range.high.hoursSaved.toFixed(1)} h/wk (${Math.round(i.saving.range.low.pct * 100)}-${Math.round(i.saving.range.high.pct * 100)}%)`,
      `   evidence: ${s.instances.eventIds.length} events in ${s.instances.value} instances`,
    );
  }
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`brain: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (args.command === "analyze") {
    const a = await analyzeHome(args.home, args.reviewSeconds === undefined ? {} : { reviewSeconds: args.reviewSeconds });
    if (args.json) {
      const body = toInsights(a);
      console.log(JSON.stringify({ ...body, insights: body.insights.slice(0, args.top) }, null, 2));
    } else console.log(formatReport(a, args.top));
    return 0;
  }
  const { token, generated } = resolveToken(process.env);
  const srv = await startBrainServer({ home: args.home, token, port: args.port });
  console.log(`brain listening on ${srv.url}`);
  if (generated) console.log(`OFFLOAD_TOKEN=${token}`);
  return await new Promise<number>(() => {
    // Runs until the process is stopped.
  });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error("brain: failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    },
  );
}
