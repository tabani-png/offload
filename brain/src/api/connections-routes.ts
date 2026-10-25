// s17: the Connections center (brain/API.md "Connections (s17)"). Search any app Composio supports, see how to set
// it up once (Composio sign-in, an API key in the Keychain, a connector server), test it read-only, and hand it to the
// s14 builder. Nothing here sends anything: setup and test only read, build ends with a dry run.
//   GET  /connections?q=&limit=            rows: catalog first, then the Composio list (connectors/universe.ts)
//   GET  /connections/universe             the local index's status
//   POST /connections/universe/refresh     real model: re-sync the index in the background (read-only commands)
//   GET  /connections/:id                  detail: methods, tool counts, the setup in use and its last test
//   POST /connections/:id/setup {method, ...references}
//   POST /connections/:id/test             read-only check of the setup
//   POST /connections/:id/build {insightId?}  draft the workflow with this connection, then a dry run
import type { Analysis } from "../analyze.ts";
import { chainConnected, type ChainResolver } from "../connectors/chain.ts";
import { connectionIdFor, connectionInfo, keychainRefFor, parseSetup, readConnections, secretWhere, SetupError, testConnection, writeConnection, type ConnectionInfo, type ConnectionRecord } from "../connectors/connections.ts";
import { catalogStatus, loadConnectorsConfig, type ConnectorStatus, type Env } from "../connectors/config.ts";
import { CONNECTORS } from "../connectors/catalog.ts";
import { LinkNotFound, readSim, type Linker } from "../connectors/link.ts";
import { universeTargetId } from "../connectors/targets.ts";
import { fetchSchema, matchScore, readUniverse, syncUniverse, toolkitAuthModes, toolsOf, universeStatus, type UniverseIndex, type UniverseTool } from "../connectors/universe.ts";
import { readUserContext } from "../context/store.ts";
import { DEFAULT_MODELS, loadModelConfig, type Model, type ModelConfig } from "../models/model.ts";
import { chooseTool, universeOption, universeTools, type StepToolsDTO, type ToolOptionDTO } from "../plan/tools.ts";
import { draftGeneralWorkflow, draftWorkflow, isGeneralInsight, NotFoundError } from "../workflows/drafter.ts";
import { dryRun } from "../workflows/dryrun.ts";
import { GENERIC_VERB_PREFIX, isGenericVerb } from "../workflows/generic.ts";
import { connectorStatus, detailOf } from "../workflows/service.ts";
import { readWorkflow, updateWorkflow } from "../workflows/store.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { error, json } from "./http.ts";
import { API_VERSION, type ConnectLinkDTO, type ConnectionBuildDTO, type ConnectionDetailDTO, type ConnectionMethodDTO, type ConnectionRowDTO, type ConnectionsResponse, type ConnectionStatusDTO, type ConnectionTestDTO, type ModelLabel, type UniverseStatusDTO } from "./types.ts";

export interface ConnectionsContext {
  home: string;
  env: Env;
  now: () => number;
  model: Model;
  modelLabel: ModelLabel;
  linker: Linker;
  resolver: ChainResolver;
  analysis: () => Promise<Analysis>;
  background: (p: Promise<unknown>) => void;
  /** Adds the chain to a link answer (server.ts). */
  withChain: (dto: ConnectLinkDTO) => Promise<ConnectLinkDTO>;
  log: (line: string) => void;
}

const MAX_BODY = 16 * 1024;
const Q_MAX = 80;

async function jsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "payload_too_large", `body over ${MAX_BODY} bytes`);
  if (text.trim() === "") return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return error(400, "bad_request", "content-type must be application/json");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return error(400, "bad_request", "body is not JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return error(400, "bad_request", "body must be a JSON object");
  return v as Record<string, unknown>;
}

// ---------- status ----------

interface StatusWorld {
  catalog: Record<string, ConnectorStatus>;
  chain: Set<string>;
  sim: Record<string, number>;
  records: Record<string, ConnectionRecord>;
  simulated: boolean;
}

function statusWorld(ctx: ConnectionsContext): StatusWorld {
  const simulated = ctx.modelLabel === "stub";
  return { catalog: catalogStatus(loadConnectorsConfig(ctx.home).config, ctx.env), chain: chainConnected(ctx.home, ctx.now()), sim: simulated ? readSim(ctx.home) : {}, records: readConnections(ctx.home), simulated };
}

function statusOf(id: string, name: string, w: StatusWorld): { status: ConnectionStatusDTO; line: string } {
  const rec = w.records[id];
  if (w.simulated && w.sim[id] !== undefined) return { status: "connected", line: `${name} is connected for this demo. Nothing is sent from a demo sign-in.` };
  if (w.catalog[id] === "connected" || w.chain.has(id) || rec?.test?.ok === true) return { status: "connected", line: `${name} is connected.` };
  if (rec !== undefined) return { status: "needs_you", line: rec.test?.detail ?? `Setup for ${name} has started. Finish it, then test it.` };
  if (w.catalog[id] === "missing_env") return { status: "needs_you", line: `${name} needs its sign-in setting.` };
  return { status: "not_set_up", line: `${name} is not set up yet.` };
}

function toolCounts(idx: UniverseIndex | null, toolkit: string | null): ConnectionRowDTO["tools"] {
  const out = { read: 0, commit: 0, denied: 0 };
  if (idx === null || toolkit === null) return out;
  for (const t of toolsOf(idx, toolkit)) {
    if (t.class === "read") out.read += 1;
    else if (t.class === "commit") out.commit += 1;
    else out.denied += 1;
  }
  return out;
}

function row(info: ConnectionInfo, idx: UniverseIndex | null, w: StatusWorld): ConnectionRowDTO {
  const s = statusOf(info.id, info.name, w);
  return { id: info.id, name: info.name, toolkit: info.toolkit, description: info.description, status: s.status, statusLine: s.line, verified: info.catalog !== null, tools: toolCounts(idx, info.toolkit), method: w.records[info.id]?.method ?? null };
}

function universeDTO(idx: UniverseIndex | null, now: number): UniverseStatusDTO {
  return { version: API_VERSION, ...universeStatus(idx, now) };
}

const NOT_LOADED = "The list of apps Composio supports is not loaded yet. Offload loads it in the background once a day; until then you see the apps Offload knows.";

function listConnections(ctx: ConnectionsContext, q: string, limit: number): ConnectionsResponse {
  const idx = readUniverse(ctx.home);
  const w = statusWorld(ctx);
  const infos: Array<ConnectionInfo & { rank: number }> = CONNECTORS.map((c, i) => ({ ...connectionInfo(c.id, idx)!, rank: i - 10_000 }));
  if (idx !== null)
    for (const t of Object.values(idx.toolkits)) {
      if (t.slug === "composio" || connectionIdFor(t.slug) !== universeTargetId(t.slug)) continue;
      infos.push({ id: universeTargetId(t.slug), name: t.name, toolkit: t.slug, description: t.description, catalog: null, rank: t.rank });
    }
  let picked: Array<ConnectionInfo & { rank: number; score: number }>;
  if (q === "") {
    const busy = (i: ConnectionInfo) => (statusOf(i.id, i.name, w).status === "not_set_up" ? 1 : 0);
    picked = infos.map((i) => ({ ...i, score: 0 })).sort((a, b) => Number(a.catalog === null) - Number(b.catalog === null) || busy(a) - busy(b) || a.rank - b.rank);
  } else {
    picked = infos
      .map((i) => ({ ...i, score: Math.max(matchScore({ name: i.name, slug: i.toolkit ?? i.id, description: i.description }, q), matchScore({ name: i.name, slug: i.id, description: "" }, q)) }))
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score || Number(a.catalog === null) - Number(b.catalog === null) || a.rank - b.rank);
  }
  return { version: API_VERSION, query: q, connections: picked.slice(0, limit).map((i) => row(i, idx, w)), universe: universeDTO(idx, ctx.now()), note: idx === null ? NOT_LOADED : null };
}

// ---------- detail ----------

/** A tool's name in plain words, without the app's own name ("Create linear issue" -> "Create issue"). */
export function plainToolName(t: UniverseTool, appName: string): string {
  const drop = new Set(appName.toLowerCase().split(/\s+/));
  const words = t.name.split(/\s+/).filter((w) => !drop.has(w.toLowerCase()));
  const s = (words.length > 0 ? words : t.name.split(/\s+/)).join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const rankCommit = (t: UniverseTool) => (t.hints.includes("createHint") ? 0 : t.hints.includes("updateHint") ? 1 : 2) + (t.destructive ? 3 : 0);

function methodsFor(name: string, apiKey: boolean): ConnectionMethodDTO[] {
  const out: ConnectionMethodDTO[] = [
    {
      method: "composio",
      title: "Sign in once through Composio",
      detail: "Composio keeps the sign-in for Offload. Offload never sees your password.",
      steps: [`Press Sign in. Your browser opens ${name}'s own sign-in page.`, "Allow access, then come back here. Offload checks by itself.", "Nothing is sent until you approve a batch."],
      recommended: true,
    },
  ];
  if (apiKey)
    out.push({
      method: "api_key",
      title: "Paste an API key",
      detail: "The key is saved straight into your Mac's Keychain and is never shown again.",
      steps: [`Open ${name}'s settings and create an API key.`, "Paste it into the secure field. Offload stores it in your Keychain, not in a file.", "Offload checks it with one read and nothing else."],
      recommended: false,
    });
  out.push({
    method: "mcp",
    title: "Add a connector server",
    detail: "For apps that publish their own connector server: its https address, or the command that starts it on this Mac.",
    steps: ["Copy the server's address or command from the app's help pages.", "If it needs a sign-in, paste it into the secure field. It goes into your Keychain.", "Offload lists what the server offers and calls nothing."],
    recommended: false,
  });
  return out;
}

async function detail(ctx: ConnectionsContext, info: ConnectionInfo): Promise<ConnectionDetailDTO> {
  let idx = readUniverse(ctx.home);
  const w = statusWorld(ctx);
  // Composio's auth modes: read-only `dev toolkits info`, real model only; the demo answers from the cache.
  let modes: string[] | null = info.toolkit === null ? null : (idx?.toolkits[info.toolkit]?.authModes ?? null);
  if (modes === null && info.toolkit !== null && ctx.modelLabel === "real") {
    modes = await toolkitAuthModes({ home: ctx.home, runner: ctx.resolver.deps.runner, env: ctx.env, toolkit: info.toolkit });
    idx = readUniverse(ctx.home);
  }
  const apiKey = modes === null || modes.some((m) => /API_KEY|BEARER|BASIC|TOKEN/i.test(m));
  const tools = idx === null || info.toolkit === null ? [] : toolsOf(idx, info.toolkit);
  const reads = tools.filter((t) => t.class === "read").sort((a, b) => Number(b.important) - Number(a.important) || a.slug.length - b.slug.length);
  const commits = tools.filter((t) => t.class === "commit").sort((a, b) => rankCommit(a) - rankCommit(b) || Number(b.important) - Number(a.important) || a.slug.length - b.slug.length);
  const rec = w.records[info.id];
  return {
    version: API_VERSION,
    ...row(info, idx, w),
    methods: methodsFor(info.name, apiKey),
    sample: { read: reads.slice(0, 3).map((t) => plainToolName(t, info.name)), commit: commits.slice(0, 4).map((t) => plainToolName(t, info.name)) },
    setup:
      rec === undefined
        ? null
        : {
            method: rec.method,
            startedAt: rec.startedAt,
            secretRef: rec.api !== undefined ? secretWhere(rec.api.secret) : null,
            server: rec.server === undefined ? null : rec.server.type === "http" ? rec.server.url : [rec.server.command, ...rec.server.args].join(" "),
            test: rec.test,
          },
    keychain: keychainRefFor(info.id),
    canBuild: true,
  };
}

// ---------- test ----------

async function runTest(ctx: ConnectionsContext, info: ConnectionInfo, rec: ConnectionRecord): Promise<ConnectionTestDTO> {
  const d = ctx.resolver.deps;
  const r = await testConnection(rec, info.name, { runner: d.runner, env: ctx.env, fetch: d.fetch, secrets: d.secrets, mcp: d.mcp, simulated: ctx.modelLabel === "stub", now: ctx.now, timeoutMs: Math.max(d.timeoutMs, 5_000) });
  writeConnection(ctx.home, { ...rec, test: r });
  return { version: API_VERSION, connectionId: info.id, ok: r.ok, detail: r.detail, tools: r.tools, testedAt: r.at };
}

// ---------- build ----------

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when the insight's task happens in this app (its surfaces' hosts and apps). */
function insightTouches(insight: Analysis["insights"][number], info: ConnectionInfo): boolean {
  const p = insight.profile;
  const surfaces = [{ app: p.app, host: p.host }, ...(p.understanding?.surfaces ?? []).map((s) => ({ app: s.app ?? "", host: s.host ?? "" }))];
  for (const s of surfaces) {
    const host = (s.host ?? "").toLowerCase();
    if (info.catalog !== null) {
      if (host !== "" && info.catalog.hosts.some((h) => (h.startsWith(".") ? host.endsWith(h) : h === host))) return true;
      if (info.catalog.apps.includes(s.app)) return true;
    }
    const tk = squash(info.toolkit ?? "");
    if (tk.length >= 4 && (host.split(".").some((l) => squash(l) === tk) || squash(s.app).includes(tk))) return true;
  }
  return false;
}

/** The step a connection fits: an option that is this connection (catalog id, toolkit or universe connection). */
function optionFor(tools: readonly StepToolsDTO[], info: ConnectionInfo): { stepId: string; optionId: string } | null {
  const tk = info.toolkit;
  for (const t of tools)
    for (const o of t.options) {
      if (o.via === "computer") continue;
      if (o.connectorId === info.id || o.id === info.id || (tk !== null && (o.id === tk || o.connectorId === universeTargetId(tk)))) return { stepId: t.stepId, optionId: o.id };
    }
  return null;
}

function commitStepIds(wf: WorkflowJson): string[] {
  if (wf.plan !== undefined) {
    const v = wf.plan.variants.find((x) => x.id === wf.plan!.chosen) ?? wf.plan.variants[0];
    return (v?.steps ?? []).filter((s) => s.type === "commit").map((s) => s.id);
  }
  return wf.steps.filter((s) => s.type === "send").map((s) => s.id);
}

/** Adds this toolkit's best commit tool to the workflow's commit step (keeping at most three options). */
function addUniverseOption(wf: WorkflowJson, idx: UniverseIndex, info: ConnectionInfo, connected: ReadonlySet<string>): { tools: StepToolsDTO[]; stepId: string; optionId: string } | null {
  if (info.toolkit === null) return null;
  const stepId = commitStepIds(wf)[0];
  if (stepId === undefined) return null;
  const planStep = wf.plan?.variants.flatMap((v) => v.steps).find((s) => s.id === stepId);
  const words = `${planStep?.title ?? ""} ${planStep?.detail ?? ""} ${planStep?.capability?.need ?? ""} ${wf.plan?.outputType.replace(/_/g, " ") ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
  const best = universeTools(idx, words, "commit", { toolkit: info.toolkit, limit: 1 })[0];
  if (best === undefined) return null;
  const opt: ToolOptionDTO = universeOption(idx, best, connected);
  const tools = [...(wf.tools ?? [])];
  const i = tools.findIndex((t) => t.stepId === stepId);
  if (i < 0) {
    tools.push({ stepId, capability: "universe.commit", catalogCapability: null, need: planStep?.capability?.need ?? planStep?.title ?? "the commit", options: [opt], chosen: opt.id, chosenBy: "default", runsWith: opt.id, suggestion: "" });
  } else {
    const t = tools[i]!;
    let options = [...t.options.filter((o) => o.id !== opt.id), opt];
    while (options.length > 3) {
      const drop = options.findIndex((o, k) => k < options.length - 1 && o.id !== t.chosen && (o.verified === false || o.via === "computer"));
      options = options.filter((_, k) => k !== (drop >= 0 ? drop : options.length - 2));
    }
    tools[i] = { ...t, options };
  }
  return { tools, stepId, optionId: opt.id };
}

function modelsOf(home: string): ModelConfig {
  try {
    return loadModelConfig(home);
  } catch {
    return { ...DEFAULT_MODELS };
  }
}

async function build(ctx: ConnectionsContext, info: ConnectionInfo, body: Record<string, unknown>): Promise<Response> {
  for (const k of Object.keys(body)) if (k !== "insightId") return error(400, "bad_request", `${k} is not a build field (send {} or { "insightId": ... })`);
  if (body.insightId !== undefined && (typeof body.insightId !== "string" || !/^ins_[A-Za-z0-9_-]{1,64}$/.test(body.insightId))) return error(400, "bad_request", "insightId must be an insight id");
  const a = await ctx.analysis();
  const insight = typeof body.insightId === "string" ? a.insights.find((i) => i.id === body.insightId) : a.insights.find((i) => insightTouches(i, info));
  if (insight === undefined) {
    if (typeof body.insightId === "string") return error(404, "not_found", "unknown insight id");
    return error(409, "conflict", `Offload has not seen you work in ${info.name} yet. Pick one of your tasks to build it with ${info.name}.`);
  }
  const user = readUserContext(ctx.home).context;
  const now = ctx.now;
  let wf: WorkflowJson;
  try {
    wf = isGeneralInsight(a, insight.id)
      ? (await draftGeneralWorkflow({ home: ctx.home, analysis: a, insightId: insight.id, model: ctx.model, models: modelsOf(ctx.home), now, ...(user === undefined ? {} : { user }) })).workflow
      : draftWorkflow({ home: ctx.home, analysis: a, insightId: insight.id, now }).workflow;
  } catch (err) {
    if (err instanceof NotFoundError) return error(404, "not_found", err.message);
    throw err;
  }
  // Pick the connection for the step it fits, as the person's own pick.
  const template = wf.plan === undefined;
  const idx = readUniverse(ctx.home);
  let tools = wf.tools ?? [];
  let pick = optionFor(tools, info);
  if (pick === null && idx !== null) {
    const added = addUniverseOption(wf, idx, info, new Set());
    if (added !== null) {
      tools = added.tools;
      pick = { stepId: added.stepId, optionId: added.optionId };
    }
  }
  if (pick !== null) tools = chooseTool(tools, pick.stepId, pick.optionId, template) ?? tools;
  // A tool approved field by field: its fields are read (read-only) so the dry run can show every one of them. The
  // demo (stub model) never runs Composio: it uses a cached schema or says the fields are not fetched yet.
  if (pick !== null && isGenericVerb(pick.optionId) && ctx.modelLabel === "real") await fetchSchema({ home: ctx.home, runner: ctx.resolver.deps.runner, env: ctx.env, now, slug: pick.optionId.slice(GENERIC_VERB_PREFIX.length) });
  wf = updateWorkflow(
    ctx.home,
    wf.id,
    (w) => {
      w.tools = tools;
      w.lastDryRunHash = null;
      if (w.status === "active") w.status = "ready_for_review";
    },
    now(),
  );
  const dr = await dryRun({ home: ctx.home, analysis: a, workflowId: wf.id, model: ctx.model, modelLabel: ctx.modelLabel, now });
  const general = dr.general;
  const commits = (general?.instances ?? []).map((i) => i.commit).filter((c): c is NonNullable<typeof c> => c !== null);
  const chosen = pick === null ? null : (tools.find((t) => t.stepId === pick!.stepId)?.chosen ?? null);
  const res: ConnectionBuildDTO = {
    version: API_VERSION,
    connectionId: info.id,
    workflow: detailOf(ctx.home, readWorkflow(ctx.home, wf.id)!, connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub"), ctx.now()),
    dryRun: { instances: general?.instances.length ?? dr.instances.length, commitTool: commits[0]?.tool ?? chosen, missing: [...new Set(commits.flatMap((c) => c.missing ?? []))], sent: 0, warnings: [...dr.warnings] },
  };
  return json(200, res);
}

// ---------- universe refresh ----------

/** One sync at a time per home. */
const refreshing = new Map<string, Promise<unknown>>();

/** Starts one background re-sync (real model only; read-only commands). False when it cannot or need not run. */
export function startUniverseRefresh(ctx: Pick<ConnectionsContext, "home" | "env" | "now" | "modelLabel" | "resolver" | "background" | "log">): boolean {
  if (ctx.modelLabel !== "real") return false;
  if (refreshing.has(ctx.home)) return true;
  const p = syncUniverse({ home: ctx.home, runner: ctx.resolver.deps.runner, env: ctx.env, now: ctx.now, log: ctx.log })
    .catch((err: unknown) => ctx.log(`brain: Composio app list not refreshed: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => refreshing.delete(ctx.home));
  refreshing.set(ctx.home, p);
  ctx.background(p);
  return true;
}

// ---------- the router ----------

export async function connectionsRoute(req: Request, path: string, url: URL, ctx: ConnectionsContext): Promise<Response | null> {
  if (path !== "/connections" && !path.startsWith("/connections/")) return null;
  const get = req.method === "GET" || req.method === "HEAD";
  if (path === "/connections") {
    if (!get) return error(405, "method_not_allowed", "use GET");
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length > Q_MAX) return error(400, "bad_request", `q is at most ${Q_MAX} characters`);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 60 : /^\d{1,3}$/.test(rawLimit) ? Math.min(300, Math.max(1, Number(rawLimit))) : -1;
    if (limit < 0) return error(400, "bad_request", "limit must be a number from 1 to 300");
    return json(200, listConnections(ctx, q, limit));
  }
  if (path === "/connections/universe") {
    if (!get) return error(405, "method_not_allowed", "use GET");
    return json(200, universeDTO(readUniverse(ctx.home), ctx.now()));
  }
  if (path === "/connections/universe/refresh") {
    if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
    const started = startUniverseRefresh(ctx);
    return json(200, { ...universeDTO(readUniverse(ctx.home), ctx.now()), started, ...(started ? {} : { reason: "The app list is refreshed only with the real model (the demo never runs Composio)." }) });
  }
  const m = /^\/connections\/([^/]+)(?:\/(setup|test|build))?$/.exec(path);
  if (m === null) return error(404, "not_found");
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]!);
  } catch {
    return error(404, "not_found", "unknown connection id");
  }
  const info = connectionInfo(raw, readUniverse(ctx.home));
  if (info === null) return error(404, "not_found", "unknown connection id");
  const action = m[2];
  if (action === undefined) {
    if (!get) return error(405, "method_not_allowed", "use GET");
    return json(200, await detail(ctx, info));
  }
  if (req.method !== "POST") return error(405, "method_not_allowed", "use POST");
  const body = await jsonBody(req);
  if (body instanceof Response) return body;
  if (action === "setup") {
    let rec: ConnectionRecord;
    try {
      rec = parseSetup(info.id, info.toolkit, body, ctx.now());
    } catch (err) {
      if (err instanceof SetupError) return error(400, "bad_request", err.message);
      throw err;
    }
    writeConnection(ctx.home, rec);
    if (rec.method === "composio") {
      try {
        return json(200, await ctx.withChain(await ctx.linker.start(info.id, { method: "composio", restart: body.restart === true })));
      } catch (err) {
        if (err instanceof LinkNotFound) return error(404, "not_found", "unknown connection id");
        throw err;
      }
    }
    // A connector server is checked right away (tools/list, nothing called); an API key when the person presses Test.
    if (rec.method === "mcp") await runTest(ctx, info, rec);
    return json(200, await detail(ctx, info));
  }
  if (action === "test") {
    const rec = readConnections(ctx.home)[info.id] ?? (info.toolkit === null ? undefined : { id: info.id, method: "composio" as const, toolkit: info.toolkit, startedAt: ctx.now(), test: null });
    if (rec === undefined) return error(409, "conflict", `${info.name} is not set up yet.`);
    return json(200, await runTest(ctx, info, rec));
  }
  return build(ctx, info, body);
}
