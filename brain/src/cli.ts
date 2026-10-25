// brain CLI.
//   bun run brain/src/cli.ts analyze --home DIR [--top N] [--review-seconds S] [--json]
//   bun run brain/src/cli.ts serve   --home DIR [--port P] [--model stub|real]   (first stdout line: OFFLOAD_BRAIN_READY {"port":N,"token":"..."})
//     --model real (default) = Claude via the Agent SDK; stub = the deterministic test model, every response labelled
//     `model: "stub"` (demos). `claude` is accepted as an alias for real everywhere.
//   bun run brain/src/cli.ts tone build --home DIR [--source fixture|mcp] [--model stub|claude] [--force]
//   bun run brain/src/cli.ts tone test  --home DIR --hold-back N [--source fixture|mcp] [--model stub|claude]
//   bun run brain/src/cli.ts tone pairs --home DIR [--answers]       (prints the latest sealed blind-test pairs)
//   bun run brain/src/cli.ts draft   --insight N|ins_… --home DIR [--facts FILE] [--json]
//   bun run brain/src/cli.ts dry-run (--workflow ID | --insight N|ins_…) --home DIR [--limit N] [--model stub|claude] [--json]
//   bun run brain/src/cli.ts purge   --home DIR [--json]   (s10b N4: the app runs it at launch; same purge as serve)
//   analyze/serve --understanding v1|v2 (s12; default v1 until s15): v2 = span descriptions + local embeddings + task
//     induction. --embedder stub|ollama (v2 only; default stub = deterministic offline; ollama = 127.0.0.1:11434,
//     --embed-model qwen3-embedding:0.6b|bge-m3). --role R --industry I: optional user context (prompts only).
//   serve --log-file FILE (s10b): the brain's log lines go to FILE, scrubbed of content, rotated at 5 MB keeping 2.
//     Without it they go to stderr, scrubbed the same way.
//   serve --captioner off|stub|ollama (s11, default off) [--vision-model TAG|auto] [--ollama-url http://127.0.0.1:11434]:
//     captions the observer's keyframes with a LOCAL vision model into sealed Frame notes (brain/src/vision).
import { readFileSync } from "node:fs";
import { installBrainLogging } from "./log.ts";
import { purgeAll } from "./store/retention.ts";
import { analyzeHome, type Analysis, type AnalyzeOptions } from "./analyze.ts";
import { OLLAMA_EMBED_MODELS, OllamaEmbedder, StubEmbedder } from "./understanding/embed.ts";
import { formatReadyLine, startBrainServer, resolveToken } from "./api/server.ts";
import { toInsights } from "./api/dto.ts";
import { CAPTIONER_OFF, type DryRunResponse } from "./api/types.ts";
import type { DryRunResult } from "./workflows/dryrun.ts";
import { loadConnectorsConfig, toMcpServers } from "./connectors/config.ts";
import { connectMcp } from "./connectors/mcp-client.ts";
import { loadModelConfig, StubModel, type Model } from "./models/model.ts";
import { createRoutedModel } from "./models/factory.ts";
import { RoutedModel } from "./models/router.ts";
import { ClaudeCaptioner, claudeKeyConfigured, CLAUDE_VISION_MODELS, DEFAULT_CLAUDE_VISION_MODEL } from "./vision/claude.ts";
import { RoutedCaptioner } from "./vision/routed.ts";
import { latestBlindRun, readBlindFile, runBlindTest } from "./tone/blind.ts";
import { FixtureMailSource, McpMailSource, type MailSource } from "./tone/mail-source.ts";
import { buildTonePack } from "./tone/pack.ts";
import { draftGeneralWorkflow, draftWorkflow, isGeneralInsight, NotFoundError } from "./workflows/drafter.ts";
import { readUserContext } from "./context/store.ts";
import { dryRun } from "./workflows/dryrun.ts";
import { readWorkflow } from "./workflows/store.ts";
import { ObserverFrameSource } from "./vision/frames.ts";
import { DEFAULT_OLLAMA_URL, DEFAULT_VISION_MODEL, loopbackOrigin, OllamaCaptioner } from "./vision/ollama.ts";
import { StubCaptioner } from "./vision/stub.ts";
import { SpawnLinkRunner } from "./connectors/link.ts";
import { fetchSchema, readUniverse, syncUniverse, UniverseSyncError, universeStatus } from "./connectors/universe.ts";
import { CaptionWorker } from "./vision/worker.ts";

const USAGE = `usage:
  bun run brain/src/cli.ts analyze --home DIR [--top N] [--review-seconds S] [--json]
  bun run brain/src/cli.ts serve --home DIR [--port P] [--model stub|real]
  analyze, serve, draft and dry-run also take --understanding v1|v2 [--embedder stub|ollama] [--embed-model M] [--role R] [--industry I]
  bun run brain/src/cli.ts tone build --home DIR [--source fixture|mcp] [--model stub|claude] [--force]
  bun run brain/src/cli.ts tone test --home DIR --hold-back N [--source fixture|mcp] [--model stub|claude]
  bun run brain/src/cli.ts tone pairs --home DIR [--answers]
  bun run brain/src/cli.ts draft --insight N|ins_ID --home DIR [--facts FILE] [--json]
  bun run brain/src/cli.ts dry-run (--workflow ID | --insight N|ins_ID) --home DIR [--limit N] [--model stub|claude] [--json]
  bun run brain/src/cli.ts purge --home DIR [--json]
  bun run brain/src/cli.ts universe sync|status|schema SLUG --home DIR [--json]   (s17, read-only Composio listing)
  serve also takes --log-file FILE, --captioner off|stub|ollama|claude|auto, --vision-model TAG|auto, --claude-vision-model M, --ollama-url URL`;

class UsageError extends Error {}

type Command = "analyze" | "serve" | "tone build" | "tone test" | "tone pairs" | "draft" | "dry-run" | "purge";

interface Args {
  command: Command;
  home: string;
  top: number;
  reviewSeconds: number | undefined;
  json: boolean;
  port: number;
  insight: string;
  workflow: string;
  facts: string;
  limit: number | undefined;
  model: "stub" | "real";
  /** s14: --model was given (draft uses the stub design model unless asked for the real one). */
  modelGiven: boolean;
  source: "fixture" | "mcp";
  force: boolean;
  holdBack: number;
  answers: boolean;
  logFile: string;
  understanding: "v1" | "v2";
  embedder: "stub" | "ollama";
  embedModel: string;
  role: string;
  industry: string;
  /** Which s12 flags were given (they are only valid on analyze and serve). */
  s12Flags: string[];
  captioner: "off" | "stub" | "ollama" | "claude" | "auto";
  visionModel: string;
  /** s14: --claude-vision-model (default: the router's caption model, claude-haiku-5-5). */
  claudeVisionModel: string;
  ollamaUrl: string;
}

function parse(argv: readonly string[]): Args {
  let [first, ...rest] = argv;
  let command: Command;
  if (first === "tone") {
    const sub = rest[0];
    if (sub !== "build" && sub !== "test" && sub !== "pairs") throw new UsageError(`unknown tone command ${sub ?? "(none)"}`);
    command = `tone ${sub}`;
    rest = rest.slice(1);
  } else if (first === "analyze" || first === "serve" || first === "draft" || first === "dry-run" || first === "purge") command = first;
  else throw new UsageError(`unknown command ${first ?? "(none)"}`);
  const args: Args = { command, home: "", top: 5, reviewSeconds: undefined, json: false, port: 0, insight: "", workflow: "", facts: "", limit: undefined, model: "real", modelGiven: false, source: "fixture", force: false, holdBack: 0, answers: false, logFile: "", understanding: "v1", embedder: "stub", embedModel: "qwen3-embedding:0.6b", role: "", industry: "", s12Flags: [], captioner: "off", visionModel: DEFAULT_VISION_MODEL, claudeVisionModel: "", ollamaUrl: DEFAULT_OLLAMA_URL };
  const num = (flag: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number in [${min}, ${max}]`);
    return n;
  };
  const str = (flag: string, v: string | undefined): string => {
    if (v === undefined || v === "" || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--home") args.home = rest[++i] ?? "";
    else if (a === "--top") args.top = Math.floor(num(a, rest[++i], 1, 100));
    else if (a === "--review-seconds") args.reviewSeconds = num(a, rest[++i], 1, 600);
    else if (a === "--json") args.json = true;
    else if (a === "--port") args.port = Math.floor(num(a, rest[++i], 0, 65535));
    else if (a === "--insight") args.insight = str(a, rest[++i]);
    else if (a === "--workflow") args.workflow = str(a, rest[++i]);
    else if (a === "--facts") args.facts = str(a, rest[++i]);
    else if (a === "--limit") args.limit = Math.floor(num(a, rest[++i], 1, 50));
    else if (a === "--hold-back") args.holdBack = Math.floor(num(a, rest[++i], 1, 100));
    else if (a === "--force") args.force = true;
    else if (a === "--answers") args.answers = true;
    else if (a === "--log-file") args.logFile = str(a, rest[++i]);
    else if (a === "--understanding") {
      const v = rest[++i];
      if (v !== "v1" && v !== "v2") throw new UsageError("--understanding must be v1 or v2");
      args.understanding = v;
      args.s12Flags.push(a);
    } else if (a === "--embedder") {
      const v = rest[++i];
      if (v !== "stub" && v !== "ollama") throw new UsageError("--embedder must be stub or ollama");
      args.embedder = v;
      args.s12Flags.push(a);
    } else if (a === "--embed-model") {
      const v = str(a, rest[++i]);
      if (!(OLLAMA_EMBED_MODELS as readonly string[]).includes(v)) throw new UsageError(`--embed-model must be one of ${OLLAMA_EMBED_MODELS.join(", ")}`);
      args.embedModel = v;
      args.s12Flags.push(a);
    } else if (a === "--role") {
      args.role = str(a, rest[++i]);
      args.s12Flags.push(a);
    } else if (a === "--industry") {
      args.industry = str(a, rest[++i]);
      args.s12Flags.push(a);
    } else if (a === "--captioner") {
      const v = rest[++i];
      if (v !== "off" && v !== "stub" && v !== "ollama" && v !== "claude" && v !== "auto") throw new UsageError("--captioner must be off, stub, ollama, claude or auto");
      args.captioner = v;
    } else if (a === "--vision-model") args.visionModel = str(a, rest[++i]);
    else if (a === "--claude-vision-model") {
      const v = str(a, rest[++i]);
      if (!(CLAUDE_VISION_MODELS as readonly string[]).includes(v)) throw new UsageError(`--claude-vision-model must be one of ${CLAUDE_VISION_MODELS.join(", ")}`);
      args.claudeVisionModel = v;
    }
    else if (a === "--ollama-url") {
      args.ollamaUrl = str(a, rest[++i]);
      try {
        loopbackOrigin(args.ollamaUrl);
      } catch (err) {
        throw new UsageError(`--ollama-url: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    else if (a === "--model") {
      const v = rest[++i];
      if (v !== "stub" && v !== "real" && v !== "claude") throw new UsageError("--model must be stub or real (claude is an alias for real)");
      args.model = v === "stub" ? "stub" : "real";
      args.modelGiven = true;
    } else if (a === "--source") {
      const v = rest[++i];
      if (v !== "fixture" && v !== "mcp") throw new UsageError("--source must be fixture or mcp");
      args.source = v;
    } else throw new UsageError(`unknown argument ${a}`);
  }
  if (args.home === "") throw new UsageError("--home DIR is required");
  // s14: draft and dry-run analyse the store too, so they take the same flags.
  if (args.s12Flags.length > 0 && command !== "analyze" && command !== "serve" && command !== "draft" && command !== "dry-run") throw new UsageError(`${args.s12Flags[0]} is only for analyze, serve, draft and dry-run`);
  if (args.understanding === "v1" && (args.s12Flags.includes("--embedder") || args.s12Flags.includes("--embed-model"))) throw new UsageError("--embedder needs --understanding v2");
  if (command === "draft" && args.insight === "") throw new UsageError("draft needs --insight N|ins_ID");
  if (command === "dry-run" && args.insight === "" && args.workflow === "") throw new UsageError("dry-run needs --workflow ID or --insight N");
  if (command === "tone test" && args.holdBack === 0) throw new UsageError("tone test needs --hold-back N");
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
    const u = i.profile.understanding;
    if (u !== undefined) {
      lines.push(
        `   loop: ${u.loop.map((id) => u.steps.find((x) => x.id === id)?.name ?? id).join(" → ") || "(single step)"}`,
        `   reach ${u.reach.value.toFixed(2)}: ${u.reach.perSurface.slice(0, 4).map((r) => `${r.host || r.app} ${r.via}${r.connectorId === null ? "" : `:${r.connectorId}`}`).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatDryRun(r: DryRunResponse): string {
  const lines = [`Dry run ${r.workflowId}: ${r.totals.instances} real instances from the store, side effects ${r.sideEffects.denied}/${r.sideEffects.attempted} denied by the gate`, `batch ${r.batchHash}`];
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  r.instances.forEach((i, n) => {
    lines.push(
      "",
      `[${n + 1}] ${i.day} → ${i.recipient.email} · ${i.subject}`,
      "  --- our draft",
      ...(i.draft ?? "(no draft for this workflow kind)").split("\n").map((l) => `  | ${l}`),
      "  --- what you wrote (OCR excerpt)",
      ...i.observed.excerpt.split("\n").map((l) => `  | ${l}`),
      `  time: you ${i.estimate.observedMinutes.toFixed(1)} min → review ${i.estimate.reviewSeconds} s → saves ${i.estimate.savedMinutes.toFixed(1)} min`,
      ...i.warnings.map((w) => `  warning: ${w}`),
    );
  });
  const g = (r as DryRunResult).general;
  if (g !== undefined) {
    lines.push("", `general dry run (${g.outputType}, variant ${g.variant}): ${g.totals.arithmetic}`);
    g.instances.forEach((i, n) => {
      lines.push("", `[${n + 1}] ${i.day} · ${i.ours.summary}`, `  ours:   ${i.ours.fields.map((f) => `${f.label}=${f.value ?? "?"}`).join(", ")}${i.ours.text === null ? "" : `\n  | ${i.ours.text.split("\n").join("\n  | ")}`}`, `  theirs: ${i.theirs.summary}${i.theirs.fields.length === 0 ? "" : ` (${i.theirs.fields.map((f) => `${f.label}=${f.value ?? "?"}`).join(", ")})`}`, `  match:  ${i.match.arithmetic}`, ...i.warnings.map((w) => `  warning: ${w}`));
    });
  }
  lines.push("", `total: ${r.totals.arithmetic}`);
  return lines.join("\n");
}

/** s12 options for analyze and serve. Ollama is loopback only; a failed embed call is an error, never a silent stub. */
function understandingOptions(a: Args): Pick<AnalyzeOptions, "understanding" | "embedder" | "userContext"> {
  const user = { ...(a.role === "" ? {} : { role: a.role }), ...(a.industry === "" ? {} : { industry: a.industry }) };
  const ctx = Object.keys(user).length === 0 ? {} : { userContext: user };
  if (a.understanding === "v1") return ctx;
  return { understanding: "v2", embedder: a.embedder === "ollama" ? new OllamaEmbedder({ model: a.embedModel }) : new StubEmbedder(), ...ctx };
}

/** s14: what `--captioner auto` tries, in order. Claude first (operator decision 2026-10-25, ADR 0009); a one-line
 * change puts the local model first. */
export const AUTO_CAPTIONERS: readonly ("claude" | "ollama")[] = ["claude", "ollama"];

export interface VisionChoice {
  worker: CaptionWorker | undefined;
  /** Why captions are off under auto (shown as a needs-you line in GET /status). */
  needsYou: string | null;
  label: string;
}

/** s11/s14: the caption worker for `serve --captioner`, or none. `auto` = the first of AUTO_CAPTIONERS that can work:
 * Claude when a key is configured (falling back to the local model when the budget or the key says no), else Ollama
 * when it is healthy, else off with a needs-you line. Exported for tests. */
export async function chooseVision(a: Pick<Args, "home" | "captioner" | "visionModel" | "ollamaUrl" | "claudeVisionModel">, o: { env?: Readonly<Record<string, string | undefined>>; router?: RoutedModel["router"]; ollama?: OllamaCaptioner } = {}): Promise<VisionChoice> {
  const env = o.env ?? process.env;
  const source = new ObserverFrameSource(a.home);
  const worker = (captioner: ConstructorParameters<typeof CaptionWorker>[0]["captioner"]) => new CaptionWorker({ home: a.home, source, captioner });
  const ollama = () => o.ollama ?? new OllamaCaptioner({ url: a.ollamaUrl, model: a.visionModel });
  const claude = () => new ClaudeCaptioner({ env, ...(a.claudeVisionModel === "" ? {} : { model: a.claudeVisionModel }), ...(o.router === undefined ? {} : { router: o.router }) });
  if (a.captioner === "off") return { worker: undefined, needsYou: null, label: "off" };
  if (a.captioner === "stub") return { worker: worker(new StubCaptioner()), needsYou: null, label: "stub (deterministic)" };
  if (a.captioner === "ollama") return { worker: worker(ollama()), needsYou: null, label: `ollama ${a.visionModel} on ${a.ollamaUrl}` };
  const allowed = () => o.router?.captionOnClaude() ?? true;
  if (a.captioner === "claude") return { worker: worker(new RoutedCaptioner(claude(), ollama(), allowed)), needsYou: null, label: `claude ${a.claudeVisionModel || DEFAULT_CLAUDE_VISION_MODEL}, local model when the budget or the account says no` };
  for (const c of AUTO_CAPTIONERS) {
    if (c === "claude" && claudeKeyConfigured(env)) return { worker: worker(new RoutedCaptioner(claude(), ollama(), allowed)), needsYou: null, label: "auto: claude (local model as fallback)" };
    if (c === "ollama") {
      const oc = ollama();
      if ((await oc.health()).ok) return { worker: worker(oc), needsYou: null, label: `auto: ollama ${oc.model}` };
    }
  }
  return { worker: undefined, needsYou: "Offload cannot read screens yet: add a Claude key in Settings or start Ollama on this Mac.", label: "auto: off" };
}

/** s11 (kept for tests): the worker for an explicit off|stub|ollama choice. */
export function visionWorker(a: Pick<Args, "home" | "captioner" | "visionModel" | "ollamaUrl">): CaptionWorker | undefined {
  if (a.captioner === "off" || a.captioner === "auto" || a.captioner === "claude") return undefined;
  const captioner = a.captioner === "stub" ? new StubCaptioner() : new OllamaCaptioner({ url: a.ollamaUrl, model: a.visionModel });
  return new CaptionWorker({ home: a.home, source: new ObserverFrameSource(a.home), captioner });
}

export { parse as parseArgs };

// s14: every model call goes through the router (models/router.ts): the stub backend for --model stub, else the
// Claude API (with a key) or the Claude Code login.
const modelOf = (a: Args): Model => createRoutedModel({ home: a.home, stub: a.model === "stub" });

function resolveInsight(a: Analysis, ref: string): string {
  if (/^\d+$/.test(ref)) {
    const i = a.insights[Number(ref) - 1];
    if (i === undefined) throw new NotFoundError(`no insight #${ref} (there are ${a.insights.length})`);
    return i.id;
  }
  return ref;
}

async function mailSource(args: Args): Promise<{ source: MailSource; close: () => Promise<void> }> {
  if (args.source === "fixture") return { source: new FixtureMailSource(), close: async () => {} };
  const { config, errors, path } = loadConnectorsConfig(args.home);
  if (config === null) throw new UsageError(errors.length > 0 ? errors.join("; ") : `no ${path}: connect Gmail first (brain/CONNECTORS.md)`);
  if (config.mail === undefined) throw new UsageError(`${path} has no "mail" section naming the server and read tool for Sent mail`);
  const servers = toMcpServers({ ...config, servers: { [config.mail.server]: config.servers[config.mail.server]! } }, process.env);
  const conn = await connectMcp(config.mail.server, servers[config.mail.server]!, config.servers[config.mail.server]!.catalog);
  return { source: new McpMailSource({ caller: conn.caller, tool: config.mail.listTool, args: config.mail.args, ...(config.mail.limitArg === undefined ? {} : { limitArg: config.mail.limitArg }) }), close: conn.close };
}

/** s17: `universe sync|status|schema SLUG --home DIR [--json]`: the Composio app list (read-only commands only). */
async function universeCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  let home = "";
  let json = false;
  let slug = "";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--home") home = rest[++i] ?? "";
    else if (rest[i] === "--json") json = true;
    else if (sub === "schema" && slug === "" && !rest[i]!.startsWith("-")) slug = rest[i]!;
    else throw new UsageError(`unknown argument ${rest[i]}`);
  }
  if (home === "") throw new UsageError("--home DIR is required");
  const runner = new SpawnLinkRunner();
  if (sub === "sync") {
    const r = await syncUniverse({ home, runner, env: process.env, now: Date.now, log: (l) => console.error(l) });
    const s = universeStatus(r.index, Date.now());
    console.log(json ? JSON.stringify({ ...s, failedToolkits: r.failedToolkits, commands: r.commands }) : `synced ${s.toolkits} apps, ${s.tools} tools (read ${s.classes.read}, commit ${s.classes.commit}, draft ${s.classes.draft}, denied ${s.classes.denied}); ${r.failedToolkits.length} apps kept from before; ${r.commands} read-only commands`);
    return 0;
  }
  if (sub === "status") {
    const s = universeStatus(readUniverse(home), Date.now());
    console.log(json ? JSON.stringify(s) : s.syncedAt === null ? "no app list yet (run: universe sync)" : `${s.toolkits} apps, ${s.tools} tools, synced ${new Date(s.syncedAt).toISOString()}${s.stale ? " (stale)" : ""}`);
    return 0;
  }
  if (sub === "schema") {
    if (slug === "") throw new UsageError("universe schema needs a tool slug");
    const r = await fetchSchema({ home, runner, env: process.env, now: Date.now, slug, maxAgeMs: 0 });
    if (r === null) {
      console.error(`brain: no schema for ${slug}`);
      return 1;
    }
    const props = Object.keys((r.inputSchema.properties as Record<string, unknown> | undefined) ?? {});
    console.log(json ? JSON.stringify(r) : `${slug}: ${props.length} fields (${props.join(", ")}); required ${JSON.stringify(r.inputSchema.required ?? [])}; sha256 ${r.hash}`);
    return 0;
  }
  throw new UsageError(`unknown universe command ${sub ?? "(none)"} (sync, status, schema SLUG)`);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "universe") {
    try {
      return await universeCommand(argv.slice(1));
    } catch (err) {
      if (!(err instanceof UsageError) && !(err instanceof UniverseSyncError)) throw err;
      console.error(`brain: ${err.message}`);
      return 2;
    }
  }
  let args: Args;
  try {
    args = parse(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`brain: ${err.message}\n${USAGE}`);
    return 2;
  }
  try {
    return await runCommand(args);
  } catch (err) {
    if (err instanceof UsageError || err instanceof NotFoundError) {
      console.error(`brain: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

async function runCommand(args: Args): Promise<number> {
  if (args.command === "purge") {
    const r = purgeAll(args.home, Date.now(), { log: (l) => console.error(l) });
    console.log(args.json ? JSON.stringify(r) : `purged ${r.files} artefact(s), ${r.keys} key(s), ${r.toneCards} tone card(s); sealed ${r.sealed} plaintext file(s)`);
    return 0;
  }
  if (args.command === "analyze") {
    const a = await analyzeHome(args.home, { ...understandingOptions(args), ...(args.reviewSeconds === undefined ? {} : { reviewSeconds: args.reviewSeconds }) });
    if (args.json) {
      const body = toInsights(a);
      console.log(JSON.stringify({ ...body, insights: body.insights.slice(0, args.top) }, null, 2));
    } else console.log(formatReport(a, args.top));
    return 0;
  }
  if (args.command === "tone pairs") {
    const run = latestBlindRun(args.home);
    const text = run === null ? null : readBlindFile(args.home, `${run}/${args.answers ? "key.json.enc" : "pairs.md.enc"}`);
    if (text === null) throw new UsageError("no blind test from the last 7 days: run `tone test` first");
    console.log(text);
    return 0;
  }
  if (args.command === "tone build" || args.command === "tone test") {
    const models = loadModelConfig(args.home);
    const { source, close } = await mailSource(args);
    try {
      if (args.command === "tone build") {
        const r = await buildTonePack({ home: args.home, source, model: modelOf(args), models, force: args.force });
        console.log(`tone pack: ${r.corpus} sent emails`);
        for (const b of r.buckets) console.log(`  ${b.bucket}: ${b.emails} emails → ${b.file}${b.action === "kept_edited" ? " (kept: you edited it; --force to rebuild)" : ""}`);
      } else {
        const r = await runBlindTest({ home: args.home, emails: await source.listSent({ limit: 500 }), holdBack: args.holdBack, model: modelOf(args), models });
        console.log(`blind test: ${r.summary.n} held back, trained on ${r.trainedOn.length}`);
        console.log(`  greeting match ${Math.round(r.summary.greetingMatch * 100)}% · sign-off match ${Math.round(r.summary.signMatch * 100)}% · length ratio ${r.summary.meanWordRatio} · word overlap ${r.summary.meanOverlap}`);
        console.log(`  pairs for you (sealed, kept 7 days): tone pairs --home ${args.home}\n  answer key: tone pairs --home ${args.home} --answers\n  rule: ${r.summary.rule}`);
      }
    } finally {
      await close();
    }
    return 0;
  }
  if (args.command === "draft" || args.command === "dry-run") {
    const stored = readUserContext(args.home).context;
    const u = understandingOptions(args);
    const opts = { ...u, ...(u.userContext === undefined && stored !== undefined ? { userContext: stored } : {}) };
    const a = await analyzeHome(args.home, opts);
    let workflowId = args.workflow;
    if (workflowId === "" || args.command === "draft") {
      const facts = args.facts === "" ? undefined : readFileSync(args.facts, "utf8");
      const insightId = resolveInsight(a, args.insight);
      const common = { home: args.home, analysis: a, insightId, models: loadModelConfig(args.home), ...(facts === undefined ? {} : { facts }) };
      // s14: any task that is not one of the s05 email templates gets a general plan (stub model unless --model real).
      const { workflow, created } = isGeneralInsight(a, insightId)
        ? await draftGeneralWorkflow({ ...common, model: args.modelGiven ? modelOf(args) : new StubModel(), ...(opts.userContext === undefined ? {} : { user: opts.userContext }) })
        : draftWorkflow(common);
      workflowId = workflow.id;
      if (args.command === "draft") {
        if (args.json) console.log(JSON.stringify(workflow, null, 2));
        else {
          console.log(`${created ? "drafted" : "exists"} ${workflow.id}: ${workflow.name} [${workflow.status}, auto-run ${workflow.autoRun ? "on" : "off"}]`);
          console.log(`  folder: ${args.home.replace(/\/$/, "")}/workflows/${workflow.id}`);
          if (workflow.plan !== undefined) {
            const p = workflow.plan;
            console.log(`  plan: ${p.outputType}, kept "${p.variants.find((v) => v.id === p.chosen)?.label}" (${p.reason})`);
            for (const sc of p.probe) console.log(`    ${sc.variant}: ${sc.arithmetic}`);
          }
          workflow.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.type.padEnd(13)} ${s.title}${s.connector === null ? "" : ` (${s.connector})`}`));
          console.log(`  estimate: ${workflow.estimate.arithmetic}`);
        }
        return 0;
      }
    }
    if (readWorkflow(args.home, workflowId) === null) throw new NotFoundError(`no workflow ${workflowId}`);
    const r = await dryRun({ home: args.home, analysis: a, workflowId, model: modelOf(args), ...(args.limit === undefined ? {} : { limit: args.limit }) });
    console.log(args.json ? JSON.stringify(r, null, 2) : formatDryRun(r));
    return 0;
  }
  // Before anything is logged: scrubbed lines, to --log-file (rotated) or stderr.
  installBrainLogging(args.logFile === "" ? {} : { file: args.logFile });
  const { token, generated } = resolveToken(process.env);
  if (generated) console.error("brain: no OFFLOAD_TOKEN set; generated one (it is in the ready line)");
  const model = modelOf(args);
  if (args.model === "stub") console.error("brain: --model stub: drafts come from the deterministic test model (labelled model: \"stub\")");
  const u = understandingOptions(args);
  if (u.understanding === "v2") console.error(`brain: --understanding v2 (${u.embedder?.id ?? "stub"})`);
  const choice = await chooseVision(args, model instanceof RoutedModel ? { router: model.router } : {});
  if (args.captioner !== "off") console.error(`brain: captioner ${choice.label}; images are masked by the observer first${choice.label.includes("claude") ? " and go only to your Anthropic account" : " and stay on this Mac"}`);
  const vision = choice.worker ?? (choice.needsYou === null ? undefined : { status: () => ({ ...CAPTIONER_OFF, needsYou: choice.needsYou }) });
  const srv = await startBrainServer({ home: args.home, token, port: args.port, workflows: { model, modelLabel: args.model }, ...(args.model === "real" && process.env.OFFLOAD_UNIVERSE_SYNC !== "0" ? { universe: { autoRefresh: true } } : {}), ...(Object.keys(u).length === 0 ? {} : { analyze: u }), ...(vision === undefined ? {} : { vision }) });
  // The first stdout line, machine-readable; startup logs went to stderr (brain/API.md "Connection").
  process.stdout.write(formatReadyLine(srv.port, token) + "\n");
  console.log(`brain listening on ${srv.url}`);
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
