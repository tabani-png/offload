// s05 routes: workflows, dry run, approval, run, pause/resume, delete, connectors (brain/API.md).
// s05c: GET/PUT /workflows/:id/tone (the style card) and /workflows/:id/skill (SKILL.md text only).
// s09b: GET /workflows/:id/dry-runs/latest (the last sealed dry run, opened for the response only).
// Writes are POST/PUT/DELETE with a JSON body of at most 64 KB. The approval gate itself lives in workflows/gate.ts.
import type { Analysis } from "../analyze.ts";
import { loadConnectorsConfig, toMcpServers, type Env } from "../connectors/config.ts";
import { DEMO_SEND_REFUSED, simulatedOnly, type Method } from "../connectors/link.ts";
import { knownTargets, rememberTargets, toChainDTO, type ChainResolver } from "../connectors/chain.ts";
import type { Planner } from "../connectors/computer/claude.ts";
import type { ComputerDriver } from "../connectors/computer/driver.ts";
import type { ComputerSessions } from "../connectors/computer/session.ts";
import { targetForProfile } from "../connectors/targets.ts";
import { buildChain } from "../workflows/chain-executor.ts";
import { declaredActions } from "../workflows/runner.ts";
import type { Model } from "../models/model.ts";
import { draftWorkflow, NotFoundError } from "../workflows/drafter.ts";
import { dryRun, DryRunError, readLastDryRun } from "../workflows/dryrun.ts";
import type { ExecResult, Executor } from "../workflows/executor.ts";
import { disableAutoRun, enableAutoRun, partitionForAuto } from "../workflows/autorun.ts";
import type { Batch } from "../workflows/batch.ts";
import { approveBatch, executeBatch, holdBatch, prepareLiveBatch, releaseUnknown, requestCancel, RunError, splitBatch } from "../workflows/runner.ts";
import { batchSummary, connectorStatus, connectorsResponse, detailOf, summaryOf } from "../workflows/service.ts";
import { deleteWorkflow, listWorkflows, readBatch, readWorkflow, updateWorkflow, WORKFLOW_ID_RE } from "../workflows/store.ts";
import { applySkillUpdate, SkillEditError, skillDTO } from "../workflows/skill.ts";
import { loadTonePack, MAX_TONE_CARD_BYTES, readStyleCard, writeStyleCard, type StyleCard } from "../tone/pack.ts";
import { toneMeasured } from "../tone/style.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { error, json } from "./http.ts";
import { API_VERSION, type ApproveResponse, type ConnectorChainDTO, type ModelLabel, type RunResponse, type ToneCardDTO, type WorkflowsResponse } from "./types.ts";

export const MAX_BODY_BYTES = 64 * 1024;

export interface WorkflowContext {
  home: string;
  env: Env;
  model: Model;
  /** s09b: "stub" when `model` is the deterministic test model, else "real". */
  modelLabel: ModelLabel;
  executor: Executor;
  now: () => number;
  analysis: () => Promise<Analysis>;
  /** Background work (sending an approved batch). The server keeps the promise so tests can wait. */
  background: (p: Promise<unknown>) => void;
  /** s13: the connector chain (resolver, per-method executors, computer use). Absent = the s10e single-executor path. */
  chain?: ChainContext;
}

export interface ChainContext {
  resolver: ChainResolver;
  /** Replace a method's executor (tests). */
  executors?: Partial<Record<Method, Executor>>;
  computer?: { driver: ComputerDriver; planner: Planner; sessions: ComputerSessions };
  /** Send through the chain even with the stub model (tests). Default: real model only. */
  always?: boolean;
  log?: (line: string) => void;
}

/** s13: chains for GET /connectors: every catalog id and every app target of the current insights. Stub: probed
 * (deterministic). Real: from the cache, expired ones refreshed in the background; `refresh` probes now. */
export async function connectorChains(ctx: WorkflowContext, a: Analysis, refresh: boolean): Promise<ConnectorChainDTO[] | undefined> {
  const chain = ctx.chain;
  if (chain === undefined) return undefined;
  const apps = a.insights.map((i) => targetForProfile(i.profile)).filter((t) => !t.catalog);
  rememberTargets(ctx.home, apps, ctx.now());
  const targets = [...knownTargets(ctx.home, ctx.now()).filter((t) => t.catalog), ...apps.filter((t, i) => apps.findIndex((x) => x.id === t.id) === i)];
  const simulated = ctx.modelLabel === "stub";
  const out: ConnectorChainDTO[] = [];
  for (const t of targets) {
    let d = chain.resolver.peek(t.id);
    const expired = d === null || d.expiresAt <= ctx.now();
    if (simulated || refresh) d = await chain.resolver.resolve(t, { refresh });
    else if (expired) ctx.background(chain.resolver.resolve(t));
    if (d !== null) out.push(toChainDTO(t, d, simulated));
  }
  return out;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: "bad_request" | "not_found" | "conflict" | "payload_too_large" | "method_not_allowed",
    message: string,
  ) {
    super(message);
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", `body over ${MAX_BODY_BYTES} bytes`);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", `body over ${MAX_BODY_BYTES} bytes`);
  if (text.trim() === "") return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(400, "bad_request", "content-type must be application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_request", "body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "bad_request", "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

const methods = (req: Request, ...allowed: string[]) => {
  if (!allowed.includes(req.method) && !(req.method === "HEAD" && allowed.includes("GET"))) throw new HttpError(405, "method_not_allowed", `use ${allowed.join(" or ")}`);
};

function mustWorkflow(home: string, id: string) {
  const wf = WORKFLOW_ID_RE.test(id) ? readWorkflow(home, id) : null;
  if (wf === null) throw new HttpError(404, "not_found", "unknown workflow id");
  return wf;
}

/** Handles /workflows* and /connectors. Returns null for other paths. */
export async function workflowRoute(req: Request, path: string, ctx: WorkflowContext): Promise<Response | null> {
  if (path !== "/connectors" && path !== "/workflows" && !path.startsWith("/workflows/")) return null;
  try {
    return await route(req, path, ctx);
  } catch (err) {
    if (err instanceof HttpError) return error(err.status, err.code, err.message);
    if (err instanceof NotFoundError || err instanceof DryRunError) return error(404, "not_found", err.message);
    if (err instanceof RunError) return error(err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400, err.code, err.message);
    if (err instanceof SkillEditError) return error(400, "bad_request", err.message);
    throw err;
  }
}

async function route(req: Request, path: string, ctx: WorkflowContext): Promise<Response> {
  const status = () => connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub", ctx.now());

  if (path === "/connectors") {
    methods(req, "GET");
    const a = await ctx.analysis();
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    return json(200, connectorsResponse(a, ctx.home, ctx.env, ctx.modelLabel === "stub", await connectorChains(ctx, a, refresh), ctx.now()));
  }
  if (path === "/workflows") {
    methods(req, "GET");
    const st = status();
    const res: WorkflowsResponse = { version: API_VERSION, workflows: listWorkflows(ctx.home).map((w) => summaryOf(ctx.home, w, st, ctx.now())) };
    return json(200, res);
  }
  if (path === "/workflows/draft") {
    methods(req, "POST");
    const b = await body(req);
    if (typeof b.insightId !== "string" || !/^ins_[A-Za-z0-9_-]{1,64}$/.test(b.insightId)) throw new HttpError(400, "bad_request", "insightId is required");
    const { workflow, created } = draftWorkflow({ home: ctx.home, analysis: await ctx.analysis(), insightId: b.insightId, now: ctx.now });
    return json(created ? 201 : 200, detailOf(ctx.home, workflow, status(), ctx.now()));
  }

  const latest = /^\/workflows\/([^/]+)\/dry-runs\/latest$/.exec(path);
  if (latest !== null) {
    methods(req, "GET");
    const wf = mustWorkflow(ctx.home, latest[1]!);
    // Opened with the day's brain key for this response only; a purged (older than 7 local days) one reads as none.
    const last = readLastDryRun(ctx.home, wf.id, ctx.now());
    if (last === null) throw new HttpError(404, "not_found", "no dry run in the last 7 days: run one");
    return json(200, last);
  }

  const m = /^\/workflows\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (m === null) throw new HttpError(404, "not_found", "unknown path");
  const id = m[1]!;
  const action = m[2];

  if (action === undefined) {
    methods(req, "GET", "DELETE");
    const wf = mustWorkflow(ctx.home, id);
    if (req.method === "DELETE") {
      // Stop a running batch before the folder goes (REVIEW-1 M2).
      requestCancel(ctx.home, wf.id);
      deleteWorkflow(ctx.home, wf.id);
      return json(200, { version: API_VERSION, deleted: wf.id });
    }
    return json(200, detailOf(ctx.home, wf, status(), ctx.now()));
  }

  if (action === "tone" || action === "skill") {
    methods(req, "GET", "PUT");
    const wf = mustWorkflow(ctx.home, id);
    if (action === "skill") return json(200, req.method === "PUT" ? applySkillUpdate(ctx.home, wf.id, await body(req), ctx.now()) : skillDTO(ctx.home, wf));
    if (req.method === "PUT") return json(200, toneDTO(ctx, wf, writeStyleCard(ctx.home, wf.bucket, toneText(await body(req)))));
    return json(200, toneDTO(ctx, wf, readStyleCard(ctx.home, wf.bucket)));
  }

  methods(req, "POST");
  const wf = mustWorkflow(ctx.home, id);
  const b = await body(req);
  const now = ctx.now();

  switch (action) {
    case "dry-run": {
      const limit = b.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) throw new HttpError(400, "bad_request", "limit must be an integer in [1, 50]");
      return json(200, await dryRun({ home: ctx.home, analysis: await ctx.analysis(), workflowId: wf.id, model: ctx.model, modelLabel: ctx.modelLabel, now: ctx.now, ...(limit === undefined ? {} : { limit }) }));
    }
    case "run": {
      let batch = await prepareLiveBatch({ home: ctx.home, workflowId: wf.id, model: ctx.model, now: ctx.now });
      let held: Batch | null = null;
      // Auto-run sends only what is pinned and unchanged (REVIEW-2 N1); the rest waits in a held batch.
      if (readWorkflow(ctx.home, wf.id)?.autoRun === true) {
        const d = dispatchAuto(ctx, wf.id, batch, ctx.now(), (l) => console.error(l));
        batch = d.sending ?? d.held ?? batch;
        held = d.sending === null ? null : d.held;
      }
      const res: RunResponse = { version: API_VERSION, workflowId: wf.id, batch: batchSummary(batch), items: batch.items.map((i) => ({ key: i.key, to: i.to, subject: i.subject, body: i.body, warnings: [...i.warnings] })), held: held === null ? null : batchSummary(held) };
      return json(201, res);
    }
    case "approve": {
      if (typeof b.batchHash !== "string" || !/^[0-9a-f]{64}$/.test(b.batchHash)) throw new HttpError(400, "bad_request", "batchHash (64 hex chars) is required");
      const hash = b.batchHash;
      // A live batch can only be approved when its connectors can actually be reached.
      const pre = readWorkflow(ctx.home, wf.id)!;
      const missing = summaryOf(ctx.home, pre, status(), ctx.now()).connectors.filter((c) => c.required && c.status !== "connected");
      const isLive = readBatch(ctx.home, wf.id, hash, now)?.kind === "live";
      if (isLive && missing.length > 0) throw new HttpError(409, "conflict", `connect ${missing.map((c) => c.name).join(", ")} first (brain/CONNECTORS.md)`);
      // s10e: a demo sign-in (stub model) has no server behind it: a live batch is never approved on one.
      if (isLive && demoOnly(ctx, pre.connectors).length > 0) throw new HttpError(409, "conflict", DEMO_SEND_REFUSED);
      const { batch, workflow, token } = approveBatch(ctx.home, wf.id, hash, now);
      if (batch.kind === "live") ctx.background(sendBatch(ctx, wf.id, hash, token, workflow.connectors));
      const res: ApproveResponse = { version: API_VERSION, workflowId: wf.id, batchHash: hash, kind: batch.kind, result: batch.kind === "live" ? "sending" : "activated", workflow: summaryOf(ctx.home, readWorkflow(ctx.home, wf.id)!, status(), ctx.now()) };
      return json(200, res);
    }
    case "release": {
      // Explicit user action: these recipients' sends are "unknown" and the user confirms they did not go out.
      if (typeof b.batchHash !== "string" || !/^[0-9a-f]{64}$/.test(b.batchHash)) throw new HttpError(400, "bad_request", "batchHash (64 hex chars) is required");
      const keys = b.keys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 500 || !keys.every((k) => typeof k === "string" && k.length <= 320)) throw new HttpError(400, "bad_request", "keys (the recipient addresses to release) are required");
      const batch = releaseUnknown(ctx.home, wf.id, b.batchHash, keys as string[], now);
      return json(200, { version: API_VERSION, workflowId: wf.id, batch: batchSummary(batch) });
    }
    case "pause":
    case "resume": {
      // Pausing stops a running batch before its next item (REVIEW-1 M2); the gate also re-reads the status.
      if (action === "pause") requestCancel(ctx.home, wf.id);
      const updated = updateWorkflow(ctx.home, wf.id, (w) => {
        if (action === "pause") {
          w.status = "paused";
          w.pausedAt = now;
        } else if (w.status === "paused") {
          w.status = w.activatedAt === null ? "ready_for_review" : "active";
          w.pausedAt = null;
          // s09b: slots missed while paused are not caught up by the run loop.
          w.lastScheduledAt = now;
        }
      }, now);
      return json(200, summaryOf(ctx.home, updated, status(), ctx.now()));
    }
    case "auto-run": {
      if (typeof b.enabled !== "boolean") throw new HttpError(400, "bad_request", "enabled (boolean) is required");
      // On: pin the recipient rows, facts.md, the tone card and SKILL.md (again, when already on). The summary's
      // autoRunPin shows what was pinned. Off: drop the pin and stop an auto batch before its next item (N5).
      const updated = b.enabled ? enableAutoRun(ctx.home, wf.id, now) : disableAutoRun(ctx.home, wf.id, now);
      if (!b.enabled) requestCancel(ctx.home, wf.id, { autoOnly: true });
      return json(200, summaryOf(ctx.home, updated, status(), ctx.now()));
    }
    default:
      throw new HttpError(404, "not_found", "unknown workflow action");
  }
}

// Control characters other than tab, newline and carriage return.
const CARD_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** The card text of a PUT body, validated: only `text`, a non-blank string of at most MAX_TONE_CARD_BYTES. */
function toneText(b: Record<string, unknown>): string {
  for (const k of Object.keys(b)) if (k !== "text") throw new HttpError(400, "bad_request", `${k} is not a tone card field (send { text })`);
  if (typeof b.text !== "string") throw new HttpError(400, "bad_request", "text (the style card markdown) is required");
  if (b.text.trim() === "") throw new HttpError(400, "bad_request", "text must not be blank");
  if (Buffer.byteLength(b.text, "utf8") > MAX_TONE_CARD_BYTES) throw new HttpError(413, "payload_too_large", `a style card is at most ${MAX_TONE_CARD_BYTES} bytes`);
  if (CARD_CONTROL_RE.test(b.text)) throw new HttpError(400, "bad_request", "text has control characters");
  return b.text;
}

function toneDTO(ctx: WorkflowContext, wf: WorkflowJson, card: StyleCard): ToneCardDTO {
  // s10e: "Your voice" measured in code from the tone pack's sent emails of this bucket (null without a pack).
  const pack = loadTonePack(ctx.home, ctx.now());
  const measured = pack === null ? null : toneMeasured(wf.bucket, pack.corpus.filter((e) => e.bucket === wf.bucket));
  return { version: API_VERSION, workflowId: wf.id, bucket: card.bucket, text: card.text, edited: card.edited, path: card.path, updatedAt: card.updatedAt, maxBytes: MAX_TONE_CARD_BYTES, measured };
}

export interface AutoDispatch {
  /** The batch auto-run approved and handed to the sender, or null. */
  sending: Batch | null;
  /** The pending batch that waits for review (new or changed recipients, a changed file, connectors), or null. */
  held: Batch | null;
}

/**
 * Auto-run on a freshly drafted (or existing) pending live batch, shared by the run loop and POST /run (REVIEW-2 N1):
 * pinned and unchanged recipients are approved as their own batch (an auto approval, N5) and sent; new or changed
 * ones are split into a pending batch with a review reason; a changed pinned file, a batch drafted before the pin or a
 * missing connector holds the whole batch.
 */
export function dispatchAuto(ctx: WorkflowContext, id: string, batch: Batch, now: number, log: (line: string) => void): AutoDispatch {
  const wf = readWorkflow(ctx.home, id);
  if (wf === null || wf.status !== "active" || !wf.autoRun || batch.state !== "pending" || batch.kind !== "live") return { sending: null, held: batch };
  const missing = summaryOf(ctx.home, wf, connectorStatus(ctx.home, ctx.env, ctx.modelLabel === "stub", now), now).connectors.filter((c) => c.required && c.status !== "connected");
  if (missing.length > 0) {
    log(`brain: ${id}: auto-run batch waits: connect ${missing.map((c) => c.name).join(", ")}`);
    return { sending: null, held: batch };
  }
  // s10e: connected only by a demo sign-in: auto-run never sends from it.
  if (demoOnly(ctx, wf.connectors).length > 0) {
    log(`brain: ${id}: auto-run batch waits: demo sign-in only, nothing is sent`);
    return { sending: null, held: batch };
  }
  const p = partitionForAuto(ctx.home, wf, batch);
  // Auto-run on with nothing pinned (set by hand in workflow.json): every recipient is new to it.
  if (wf.autoRunPin == null) return { sending: null, held: holdBatch(ctx.home, batch, { newRecipients: batch.items.length, changedRecipients: 0, changedFiles: [] }) };
  if (p.stale) return { sending: null, held: batch };
  const review = { newRecipients: p.newItems.length, changedRecipients: p.changedItems.length, changedFiles: p.changedFiles, ...(p.unfilledItems.length === 0 ? {} : { unfilledNames: p.unfilledItems.length }) };
  if (p.changedFiles.length > 0) return { sending: null, held: holdBatch(ctx.home, batch, review) };
  let sendable: Batch | null = batch;
  let held: Batch | null = null;
  if (p.newItems.length + p.changedItems.length + p.unfilledItems.length > 0) {
    const split = splitBatch(ctx.home, batch, new Set(p.eligible.map((i) => i.key)), review, now);
    sendable = split.kept;
    held = split.held;
    log(`brain: ${id}: auto-run held ${review.newRecipients} new and ${review.changedRecipients} changed recipient(s)${p.unfilledItems.length === 0 ? "" : ` and ${p.unfilledItems.length} draft(s) with an unfilled name`} for review`);
  }
  if (sendable === null) return { sending: null, held };
  const { workflow, token } = approveBatch(ctx.home, id, sendable.hash, now, { auto: true });
  ctx.background(sendBatch(ctx, id, sendable.hash, token, workflow.connectors));
  return { sending: sendable, held };
}

/** s10e: required connectors that count as connected only through a demo sign-in (stub model; none otherwise). */
export function demoOnly(ctx: Pick<WorkflowContext, "home" | "env" | "modelLabel">, connectors: ReadonlyArray<{ id: string; required: boolean }>): string[] {
  if (ctx.modelLabel !== "stub") return [];
  return simulatedOnly(ctx.home, ctx.env, connectors.filter((c) => c.required).map((c) => c.id));
}

/** s10e: stands in for the executor when a required connector is a demo sign-in. It never calls a tool, so the gate
 * sees nothing and every item ends failed_before_send (runner.ts), with this reason in the batch results. */
export const DEMO_EXECUTOR: Executor = {
  async execute(): Promise<ExecResult> {
    throw new Error(DEMO_SEND_REFUSED);
  },
};

/** Sends one live batch through the gate with the connectors.json MCP servers. Used by approve, run and the s09b run loop. */
export async function sendBatch(ctx: WorkflowContext, id: string, hash: string, token: string | null, connectors: ReadonlyArray<{ id: string; required: boolean }>): Promise<void> {
  // s10e: the one choke point every send path goes through. A demo sign-in has no server: the real executor is
  // never started for it and no tool call can happen.
  if (demoOnly(ctx, connectors).length > 0) {
    console.error(`brain: ${id}: not sent: a required connector is a demo sign-in`);
    await executeBatch({ home: ctx.home, workflowId: id, hash, token, executor: DEMO_EXECUTOR, mcpServers: {}, servers: {}, now: ctx.now });
    return;
  }
  const { config } = loadConnectorsConfig(ctx.home);
  // s13: the connector chain (real model, or a test that asks for it): MCP -> Composio -> API -> computer use, one
  // gate and one item journal for every method, auto-fallback only for items never attempted.
  const chain = ctx.chain;
  if (chain !== undefined && (ctx.modelLabel === "real" || chain.always === true)) {
    const wf = readWorkflow(ctx.home, id);
    const build =
      wf === null
        ? null
        : await buildChain({
            home: ctx.home,
            env: ctx.env,
            resolver: chain.resolver,
            config,
            actions: declaredActions(wf),
            mcpExecutor: ctx.executor,
            // s17: items approved field by field get their tool's schema checked fresh before the gate is built.
            ...(() => {
              const b = readBatch(ctx.home, id, hash, ctx.now());
              return b === null ? {} : { batchItems: b.items };
            })(),
            ...(chain.executors === undefined ? {} : { executors: chain.executors }),
            ...(chain.computer === undefined ? {} : { computer: chain.computer }),
            ...(chain.log === undefined ? {} : { log: chain.log }),
          }).catch((err: unknown) => {
            console.error("brain: cannot build the connector chain for", id, err instanceof Error ? err.message : err);
            return null;
          });
    if (build !== null && build.methods.length > 0) {
      await executeBatch({ home: ctx.home, workflowId: id, hash, token, executor: build.executor, mcpServers: build.mcpServers, servers: build.servers, policies: build.policies, now: ctx.now });
      return;
    }
  }
  let mcpServers;
  try {
    mcpServers = config === null ? {} : toMcpServers(config, ctx.env, connectors.filter((c) => c.required).map((c) => c.id));
  } catch (err) {
    console.error("brain: cannot resolve MCP servers for", id, err instanceof Error ? err.message : err);
    mcpServers = {};
  }
  // The gate allows a tool only on a server that covers its connector, per connectors.json.
  const servers: Record<string, string[]> = {};
  for (const name of Object.keys(mcpServers)) servers[name] = [...(config?.servers[name]?.catalog ?? [])];
  await executeBatch({ home: ctx.home, workflowId: id, hash, token, executor: ctx.executor, mcpServers, servers, now: ctx.now });
}
