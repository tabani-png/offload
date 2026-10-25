// Read models for the API and CLI: workflow summaries and details, connector status, measured saving, dashboard.
import type { Analysis } from "../analyze.ts";
import {
  API_VERSION,
  type AutomationDTO,
  type AutomationStatus,
  type BatchSummaryDTO,
  type ConnectorsResponse,
  type DashboardResponse,
  type KeptFileDTO,
  type MeasuredSavingDTO,
  type WorkflowConnectorDTO,
  type WorkflowDetailDTO,
  type WorkflowState,
  type WorkflowSummaryDTO,
} from "../api/types.ts";
import { insightConnectors } from "../api/dto.ts";
import { CONNECTORS, connectorById } from "../connectors/catalog.ts";
import { catalogStatus, loadConnectorsConfig, missingEnv, type ConnectorStatus, type Env } from "../connectors/config.ts";
import { readSim, withSimulated } from "../connectors/link.ts";
import { chainConnected } from "../connectors/chain.ts";
import type { ConnectorChainDTO } from "../api/types.ts";
import { roleOfTool } from "./allowlist.ts";
import type { Batch } from "./batch.ts";
import { pendingLiveBatch } from "./runner.ts";
import { nextCronRun } from "./schedule.ts";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readStyleCard } from "../tone/pack.ts";
import { BUCKETS } from "../tone/types.ts";
import { autoRunPinDTO, reviewSentence } from "./autorun.ts";
import { displayName } from "./labels.ts";
import { listBatches, listWorkflows, readText, workflowDir } from "./store.ts";
import type { WorkflowJson } from "./types.ts";

export function batchSummary(b: Batch): BatchSummaryDTO {
  const states = b.items.map((i) => b.itemStates?.[i.key]?.state);
  // Batches from before s05b have no item states: count allowlisted send results.
  const sent = b.itemStates === undefined ? new Set(b.results.filter((r) => r.ok && roleOfTool(r.tool) === "send").map((r) => r.key)).size : states.filter((s) => s === "sent").length;
  const unknown = states.filter((s) => s === "unknown").length;
  return { hash: b.hash, kind: b.kind, state: b.state, createdAt: b.createdAt, approvedAt: b.approvedAt, items: b.items.length, sent, unknown };
}

export function workflowConnectors(wf: WorkflowJson, status: Record<string, ConnectorStatus>): WorkflowConnectorDTO[] {
  return wf.connectors.map((c) => {
    const cat = connectorById(c.id);
    return { id: c.id, name: cat?.name ?? c.id, how: cat?.how ?? "none", required: c.required, status: status[c.id] ?? "missing" };
  });
}

/** What a connector is for in this workflow, for the needs-you sentence: its send step, its log step, or the rest. */
function purposeOf(wf: WorkflowJson, connectorId: string): string {
  const steps = wf.steps.filter((s) => s.connector === connectorId);
  if (steps.some((s) => s.type === "send")) return "send";
  if (steps.some((s) => s.type === "log")) return "log what it sent";
  return "run";
}

/** needsYou reasons are full sentences written for a person (s09b): "Connect Gmail so this can send." */
export function stateOf(wf: WorkflowJson, connectors: readonly WorkflowConnectorDTO[], pending: Batch | null): { state: WorkflowState; needsYou: string[] } {
  if (wf.status !== "active") return { state: wf.status, needsYou: [] };
  const needsYou: string[] = [];
  // s10b N1: a batch auto-run held back says why ("3 new recipients need your review.").
  if (pending !== null) needsYou.push(reviewSentence(pending) ?? `A new batch of ${pending.items.length} is ready for review.`);
  // s10b N2: a scheduled run that did not finish.
  if (wf.lastRunError) needsYou.push(`The last scheduled run did not finish: ${wf.lastRunError.reason.replace(/[.\s]+$/, "")}. It tries again at the next scheduled time.`);
  for (const c of connectors) {
    if (!c.required || c.status === "connected") continue;
    needsYou.push(`Connect ${c.name} so this can ${purposeOf(wf, c.id)}.${c.status === "missing_env" ? " Its sign-in setting is not set yet." : ""}`);
  }
  return { state: needsYou.length > 0 ? "needs_you" : "active", needsYou };
}

/** lastRunAt: createdAt of the newest live batch. nextRunAt: next due time of the cron schedule while the workflow is
 * active (needs_you included); null when manual, paused or not yet approved. */
export function runTimes(home: string, wf: WorkflowJson, now: number): { lastRunAt: number | null; nextRunAt: number | null } {
  const live = listBatches(home, wf.id, now).filter((b) => b.kind === "live");
  const lastRunAt = live.length === 0 ? null : Math.max(...live.map((b) => b.createdAt));
  const nextRunAt = wf.status === "active" && wf.schedule.type === "cron" ? nextCronRun(wf.schedule.cron, now) : null;
  return { lastRunAt, nextRunAt };
}

export function summaryOf(home: string, wf: WorkflowJson, status: Record<string, ConnectorStatus>, now: number = Date.now()): WorkflowSummaryDTO {
  const connectors = workflowConnectors(wf, status);
  const pending = pendingLiveBatch(home, wf.id, now);
  const { state, needsYou } = stateOf(wf, connectors, pending);
  return {
    id: wf.id,
    insightId: wf.insightId,
    taskId: wf.taskId,
    kind: wf.kind,
    name: displayName(home, wf, now),
    description: wf.description,
    state,
    needsYou,
    autoRun: wf.autoRun,
    createdAt: wf.createdAt,
    activatedAt: wf.activatedAt,
    connectors,
    estimatedHoursSavedPerWeek: wf.estimate.weeklyHoursSaved,
    arithmetic: wf.estimate.arithmetic,
    pendingBatch: pending === null ? null : batchSummary(pending),
    lastDryRunAt: wf.lastDryRunAt,
    ...runTimes(home, wf, now),
    autoRunPin: autoRunPinDTO(home, wf),
    lastRunError: wf.lastRunError ?? null,
  };
}

/** s14: `plan` (additive) for workflows built from any task profile (api/s14-types.ts WorkflowPlanDTO). */
export function detailOf(home: string, wf: WorkflowJson, status: Record<string, ConnectorStatus>, now: number = Date.now()): WorkflowDetailDTO & { plan?: WorkflowJson["plan"]; tools?: WorkflowJson["tools"] } {
  const pending = pendingLiveBatch(home, wf.id, now);
  return {
    ...summaryOf(home, wf, status, now),
    path: workflowDir(home, wf.id),
    skillMd: readText(home, wf.id, "SKILL.md") ?? "",
    facts: readText(home, wf.id, "facts.md") ?? "",
    steps: wf.steps.map((s) => ({ id: s.id, type: s.type, title: s.title, detail: s.detail, connector: s.connector, sideEffect: s.sideEffect, ...(s.script === undefined ? {} : { script: s.script }) })),
    schedule: wf.schedule,
    trigger: wf.trigger,
    batchSize: wf.batchSize,
    models: { ...wf.models },
    batches: listBatches(home, wf.id, now).map(batchSummary),
    pendingItems: (pending?.items ?? []).map((i) => ({ key: i.key, to: i.to, subject: i.subject, body: i.body, warnings: [...i.warnings] })),
    ...(wf.plan === undefined ? {} : { plan: wf.plan }),
    ...(wf.tools === undefined ? {} : { tools: wf.tools }),
  };
}

/** `simulated` (s10e): true only while the brain runs with the stub model; then demo sign-ins
 * (connect-sim.json, connectors/link.ts) count as connected. With the real model they are ignored. */
export function connectorStatus(home: string, env: Env, simulated = false, now: number = Date.now()): Record<string, ConnectorStatus> {
  const status = catalogStatus(loadConnectorsConfig(home).config, env);
  if (simulated) return withSimulated(status, home);
  // s13 (real model): a catalog id the connector chain can commit through (Composio CLI, a direct API, computer use)
  // counts as connected, from an unexpired decision in connector-chain.json.
  for (const id of chainConnected(home, now)) if (id in status) status[id] = "connected";
  return status;
}

// ---------- measured saving ----------

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const r1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;

/**
 * Observed hours/week on the task from the store: full stored days before the activation day vs full stored days
 * after it (the activation day itself is mixed and left out). null until both sides have at least one day.
 */
export function measuredSaving(a: Analysis, taskId: string, activatedAt: number | null): MeasuredSavingDTO | null {
  if (activatedAt === null) return null;
  const act = localDay(activatedAt);
  const before = a.windowDays.filter((d) => d < act);
  const after = a.windowDays.filter((d) => d > act);
  if (before.length === 0 || after.length === 0) return null;
  const minutes = (days: readonly string[]) => {
    const set = new Set(days);
    let ms = 0;
    for (const s of a.spans) if (set.has(s.day) && a.taskOfSpan.get(s.id) === taskId) ms += s.activeMs;
    return ms / 60_000;
  };
  const hb = r1(minutes(before) / 60);
  const ha = r1(minutes(after) / 60);
  const wb = r1((hb / before.length) * 7);
  const wa = r1((ha / after.length) * 7);
  const saved = r1(wb - wa);
  return {
    activatedAt,
    daysBefore: before.length,
    daysAfter: after.length,
    hoursPerWeekBefore: wb,
    hoursPerWeekAfter: wa,
    hoursSavedPerWeek: saved,
    arithmetic: `before: ${hb.toFixed(1)} h over ${before.length} days = ${wb.toFixed(1)} h/wk; after: ${ha.toFixed(1)} h over ${after.length} days = ${wa.toFixed(1)} h/wk → saves ${saved.toFixed(1)} h/wk`,
  };
}

// ---------- dashboard ----------

function legacyStatus(state: WorkflowState, wf: WorkflowJson): AutomationStatus {
  if (state === "paused") return "paused";
  if (state === "active" || state === "needs_you") return "approved";
  return wf.lastDryRunAt === null ? "draft" : "dry_run";
}

export function dashboard(a: Analysis, home: string, env: Env, now: number = Date.now(), simulated = false): DashboardResponse {
  const status = connectorStatus(home, env, simulated, now);
  const automations: AutomationDTO[] = listWorkflows(home).map((wf) => {
    const s = summaryOf(home, wf, status, now);
    const measured = measuredSaving(a, wf.taskId, wf.activatedAt);
    const insight = a.insights.find((i) => i.id === wf.insightId);
    return {
      id: wf.id,
      insightId: wf.insightId,
      name: s.name,
      status: legacyStatus(s.state, wf),
      connectors: insight === undefined ? wf.insight.connectors : insightConnectors(insight),
      estimatedHoursSavedPerWeek: wf.estimate.weeklyHoursSaved,
      measuredHoursSavedPerWeek: measured?.hoursSavedPerWeek ?? null,
      workflowId: wf.id,
      state: s.state,
      needsYou: s.needsYou,
      arithmetic: wf.estimate.arithmetic,
      measured,
      pendingBatch: s.pendingBatch,
      lastRunAt: s.lastRunAt,
      nextRunAt: s.nextRunAt,
      taskId: wf.taskId,
    };
  });
  const running = automations.filter((x) => x.state === "active" || x.state === "needs_you");
  const measuredOnes = running.filter((x) => x.measuredHoursSavedPerWeek !== null);
  const automated = new Set(automations.map((x) => x.insightId));
  return {
    version: API_VERSION,
    automations,
    totals: {
      estimatedHoursSavedPerWeek: r1(running.reduce((n, x) => n + x.estimatedHoursSavedPerWeek, 0)),
      measuredHoursSavedPerWeek: measuredOnes.length === 0 ? null : r1(measuredOnes.reduce((n, x) => n + (x.measuredHoursSavedPerWeek ?? 0), 0)),
    },
    suggestions: a.insights
      .filter((i) => !automated.has(i.id))
      .slice(0, 3)
      .map((i) => ({ insightId: i.id, name: i.label.name, weeklyHoursSaved: i.saving.weeklyHoursSaved })),
  };
}

// ---------- connectors ----------

export function connectorsResponse(a: Analysis, home: string, env: Env, simulated = false, chains?: ConnectorChainDTO[], now: number = Date.now()): ConnectorsResponse {
  const { config, errors, path } = loadConnectorsConfig(home);
  const real = catalogStatus(config, env);
  const status = simulated ? withSimulated(real, home) : connectorStatus(home, env, false, now);
  const sim = simulated ? readSim(home) : {};
  return {
    version: API_VERSION,
    configPath: path,
    configErrors: errors,
    servers: Object.entries(config?.servers ?? {}).map(([name, s]) => {
      const miss = missingEnv(s, env);
      return { name, transport: s.type, catalog: [...s.catalog], status: miss.length === 0 ? "connected" : "missing_env", missingEnv: miss };
    }),
    catalog: CONNECTORS.map((c) => ({
      id: c.id,
      name: c.name,
      how: c.how,
      status: status[c.id] ?? "missing",
      servers: Object.entries(config?.servers ?? {})
        .filter(([, s]) => s.catalog.includes(c.id))
        .map(([n]) => n),
      ...(simulated ? { simulated: sim[c.id] !== undefined && real[c.id] !== "connected" } : {}),
    })),
    insights: a.insights.map((i) => {
      const conns = [...(i.connectors.primary === null ? [] : [{ c: i.connectors.primary, role: "primary" as const }]), ...i.connectors.also.map((c) => ({ c, role: "also" as const }))];
      const list = conns.map(({ c, role }) => ({ id: c.id, name: c.name, role, status: status[c.id] ?? ("missing" as ConnectorStatus) }));
      return { insightId: i.id, name: i.label.name, ready: list.length > 0 && list.every((x) => x.status === "connected"), connectors: list };
    }),
    ...(chains === undefined ? {} : { chains }),
  };
}

// ---------- kept user files (s10b, REVIEW-2 privacy table) ----------

const KEPT_NOTES: Record<KeptFileDTO["kind"], string> = {
  recipients: "Your recipient list. Kept until you delete it; auto-run only sends to rows pinned when you turned it on.",
  facts: "The facts you wrote for drafts. Kept until you delete it.",
  send_log: "Your record of who was emailed, so nobody gets the same email twice. Kept until you delete it.",
  tone_card: "A tone card you edited. Kept until you delete it; cards you did not edit are deleted with the mail they came from after 7 days.",
};

/** Files with the user's own content that are not purged at 7 days: recipients.csv, facts.md, crm-log.csv per
 * workflow, and tone cards the user edited. Everything else holding observed or mail text is sealed and purged. */
export function keptFiles(home: string): KeptFileDTO[] {
  const out: KeptFileDTO[] = [];
  const add = (path: string, kind: KeptFileDTO["kind"], workflowId: string | null) => {
    if (!existsSync(path)) return;
    const st = statSync(path);
    out.push({ path, kind, workflowId, bytes: st.size, updatedAt: Math.round(st.mtimeMs), note: KEPT_NOTES[kind] });
  };
  for (const wf of listWorkflows(home)) {
    const dir = workflowDir(home, wf.id);
    add(join(dir, wf.inputs.list), "recipients", wf.id);
    add(join(dir, "facts.md"), "facts", wf.id);
    add(join(dir, wf.inputs.crmLog), "send_log", wf.id);
  }
  for (const b of BUCKETS) {
    const card = readStyleCard(home, b);
    if (card.text !== null && card.edited) add(card.path, "tone_card", null);
  }
  return out;
}
