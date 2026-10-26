// Runner: prepare a live batch (pick recipients, draft in tone), approve exactly one batch hash, execute it
// through an Executor with the gate, then log what was really sent. The gate decides; this file wires it and keeps
// the durable record (REVIEW-1 H2/H3/M2/L1/L2/L5):
//   - one run per workflow at a time: a file lock in $OFFLOAD_HOME/locks/<id>.lock around prepare and execute;
//   - the chosen recipients are reserved on disk (preparing.json) before the first model call;
//   - every item has a state written BEFORE its send (pending -> sending -> sent | failed_before_send | unknown);
//     sent and unknown count as contacted and are never re-sent unless the user releases them (releaseUnknown);
//   - pause and delete cancel a running batch: the gate re-checks before every call and the executor is aborted;
//   - a batch runs only from `approved` (or `pending` with auto-run on), and its approval is used up when it starts;
//   - s10b N1: auto-run sends on its own only what autorun.ts says is pinned and unchanged;
//   - s10b N5: an auto run (auto path, or approved by the run loop) stops before its next item when auto-run goes off;
//   - s10b privacy: every address the gate lets a send go to is written to contacted.ledger (sha256, no address)
//     before the send, so "never write twice" holds after the sealed batch is purged at 7 days.
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { addressHash, autoSendable, pinFiles, rowHash } from "./autorun.ts";
import { join } from "node:path";
import type { Model } from "../models/model.ts";
import { draftInTone } from "../tone/draft.ts";
import { readPlaybook } from "../playbook/store.ts";
import { NameMap } from "../privacy/names.ts";
import { readNamePolicy, signNames } from "../privacy/policy.ts";
import { loadTonePack } from "../tone/pack.ts";
import { DEFAULT_SERVERS, type ToolPolicy } from "./allowlist.ts";
import { makeBatch, type Batch, type BatchItem, type ItemState } from "./batch.ts";
import { crmLines, contactedFrom, type CrmEntry } from "./scripts/crm-log.ts";
import { pickNext, readRecipients } from "./scripts/recipients.ts";
import { isPlanWorkflow, planLiveItems, PlanLiveError, rowKey, type ItemRow } from "./plan-live.ts";
import { queryText } from "../plan/read-source.ts";
import { recordRead, type SourceFetcher } from "./read-fetch.ts";
import type { RunSourceDTO } from "../api/s14-types.ts";
import type { Executor, ToolCallRecord } from "./executor.ts";
import { parseFacts, renderSubject } from "./facts.ts";
import { createGate, type GateAction, type ServerMap } from "./gate.ts";
import { batchIntact, deleteApproval, gateLogPath, listBatches, readApprovals, readBatch, readText, readWorkflow, removeBatch, saveApproval, saveBatch, updateWorkflow, workflowDir, workflowExists, WorkflowGoneError, writePrivate } from "./store.ts";
import type { WorkflowJson } from "./types.ts";

export class RunError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "bad_request",
  ) {
    super(message);
  }
}

// ---------- single flight ----------

const heldLocks = new Set<string>();
const lockPath = (home: string, id: string) => {
  workflowDir(home, id); // validates the id
  return join(home, "locks", `${id}.lock`);
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the per-workflow run lock or throws RunError("conflict"). A lock left by a dead process is taken over. */
export function acquireLock(home: string, id: string): { release(): void } {
  const p = lockPath(home, id);
  mkdirSync(join(home, "locks"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomBytes(6).toString("hex") }));
      closeSync(fd);
      heldLocks.add(p);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          heldLocks.delete(p);
          rmSync(p, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder: { pid?: number } = {};
      try {
        holder = JSON.parse(readFileSync(p, "utf8")) as { pid?: number };
      } catch {
        // A lock file being written right now: treat it as held.
      }
      const pid = typeof holder.pid === "number" ? holder.pid : null;
      const stale = pid !== null && (pid === process.pid ? !heldLocks.has(p) : !pidAlive(pid));
      if (!stale || attempt > 0) throw new RunError("another run of this workflow is in progress", "conflict");
      console.error(`brain: taking over the stale run lock of ${id} (pid ${pid} is gone)`);
      rmSync(p, { force: true });
    }
  }
  throw new RunError("another run of this workflow is in progress", "conflict");
}

// ---------- cancel ----------

const running = new Map<string, { ac: AbortController; auto: boolean }>();
/** s27: dry runs reading their source (no run lock): every one of them is stopped by pause and delete too. */
const previews = new Map<string, Set<AbortController>>();
const runKey = (home: string, id: string) => `${home}\u0000${id}`;

/** Pause and delete call this: the running prepare or batch stops before its next item and the executor is aborted.
 * `autoOnly` (auto-run turned off, REVIEW-2 N5): only a run that auto-run started is stopped. */
export function requestCancel(home: string, id: string, opts: { autoOnly?: boolean } = {}): boolean {
  let hit = false;
  if (opts.autoOnly !== true) {
    for (const ac of previews.get(runKey(home, id)) ?? []) {
      ac.abort(new Error("workflow paused or deleted"));
      hit = true;
    }
  }
  const r = running.get(runKey(home, id));
  if (r === undefined || (opts.autoOnly === true && !r.auto)) return hit;
  r.ac.abort(new Error(opts.autoOnly === true ? "auto-run was turned off" : "workflow paused or deleted"));
  return true;
}

/** s27: a dry run's cancellation, like a run's: aborted by pause and delete; `cancelled()` also re-reads the workflow
 * (deleted, or paused after the dry run started). */
export function registerPreview(home: string, id: string): { signal: AbortSignal; cancelled: () => string | null; done: () => void } {
  const ac = new AbortController();
  const key = runKey(home, id);
  const set = previews.get(key) ?? new Set<AbortController>();
  set.add(ac);
  previews.set(key, set);
  const pausedAtStart = readWorkflow(home, id)?.status === "paused";
  return {
    signal: ac.signal,
    cancelled: () => {
      if (ac.signal.aborted) return "the workflow was paused or deleted";
      if (!workflowExists(home, id)) return "the workflow was deleted";
      if (!pausedAtStart && readWorkflow(home, id)?.status === "paused") return "the workflow is paused";
      return null;
    },
    done: () => {
      set.delete(ac);
      if (set.size === 0) previews.delete(key);
    },
  };
}

function register(home: string, id: string, auto = false): { ac: AbortController; done: () => void; setAuto: (a: boolean) => void } {
  const ac = new AbortController();
  const rec = { ac, auto };
  running.set(runKey(home, id), rec);
  return { ac, done: () => void (running.get(runKey(home, id)) === rec && running.delete(runKey(home, id))), setAuto: (a) => void (rec.auto = a) };
}

function cancelReason(home: string, id: string, ac: AbortController, auto = false): string | null {
  if (ac.signal.aborted) return auto && readWorkflow(home, id)?.autoRun === false ? "auto-run was turned off" : "the workflow was paused or deleted";
  if (!workflowExists(home, id)) return "the workflow was deleted";
  const wf = readWorkflow(home, id);
  if (wf?.status === "paused") return "the workflow is paused";
  if (auto && wf?.autoRun !== true) return "auto-run was turned off";
  return null;
}

// ---------- contacted ledger ----------

export const ledgerPath = (home: string, id: string) => join(workflowDir(home, id), "contacted.ledger");

/** One line per event, `contacted <hash>` (written before a send is allowed) or `released <hash>` (the user said an
 * unknown send did not go out). No address, only addressHash. */
export function appendLedger(home: string, id: string, email: string, op: "contacted" | "released"): void {
  appendFileSync(ledgerPath(home, id), `${op} ${addressHash(id, email)}\n`, { mode: 0o600 });
}

/** Address hashes whose last ledger line is `contacted`. */
export function ledgerContacted(home: string, id: string): Set<string> {
  const out = new Set<string>();
  const p = ledgerPath(home, id);
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^(contacted|released) ([0-9a-f]{64})$/.exec(line.trim());
    if (m === null) continue;
    if (m[1] === "contacted") out.add(m[2]!);
    else out.delete(m[2]!);
  }
  return out;
}

// ---------- contacted ----------

const stateOf = (b: Batch, key: string): ItemState => b.itemStates?.[key]?.state ?? "pending";

/** Everyone who must not get a new email: CRM "sent" rows plus every item of every live batch that is not provably unsent. */
export function contactedKeys(home: string, id: string, crmLog: string, now: number): Set<string> {
  const contacted = contactedFrom(readText(home, id, crmLog) ?? "");
  for (const b of listBatches(home, id, now)) if (b.kind === "live") for (const i of b.items) if (stateOf(b, i.key) !== "failed_before_send") contacted.add(i.key);
  return contacted;
}

function finalState(b: Batch): Batch["state"] {
  const states = b.items.map((i) => stateOf(b, i.key));
  if (states.every((s) => s === "sent")) return "sent";
  if (states.every((s) => s === "failed_before_send")) return "failed";
  return "partial";
}

/** Under the lock nobody else is sending: an item still "sending" lost its result (crash). It becomes unknown. */
function recoverStale(home: string, id: string, now: number): void {
  for (const b of listBatches(home, id, now)) {
    if (b.kind !== "live" || b.itemStates === undefined) continue;
    let changed = false;
    for (const [k, rec] of Object.entries(b.itemStates)) {
      if (rec.state !== "sending") continue;
      b.itemStates[k] = { ...rec, state: "unknown", at: now, error: "interrupted before a result was recorded" };
      changed = true;
    }
    if (b.state === "sending") {
      for (const i of b.items) if (stateOf(b, i.key) === "pending") b.itemStates[i.key] = { state: "failed_before_send", at: now };
      b.state = finalState(b);
      changed = true;
    }
    if (changed) saveBatch(home, b);
  }
}

// ---------- prepare ----------

export const pendingLiveBatch = (home: string, id: string, now: number = Date.now()): Batch | null => listBatches(home, id, now).find((b) => b.kind === "live" && b.state === "pending") ?? null;

export interface PrepareOptions {
  home: string;
  workflowId: string;
  model: Model;
  now?: () => number;
  /** s27: reads a plan workflow's source (its read step) through the connector chain, read only. Absent = the list. */
  read?: SourceFetcher;
}

/** s27: no source in the recordings: the person's list, said plainly. */
export const NO_SOURCE_WORDS = (list: string) => `Offload has not seen where these values come from, so it uses your list ${list}: one line per row to enter.`;

const preparingPath = (home: string, id: string) => join(workflowDir(home, id), "preparing.json");

/** Drafts the next live batch and stores it as pending. Returns the existing pending batch when there is one. */
export async function prepareLiveBatch(o: PrepareOptions): Promise<Batch> {
  const now = (o.now ?? Date.now)();
  if (readWorkflow(o.home, o.workflowId) === null) throw new RunError(`no workflow ${o.workflowId}`, "not_found");
  const lock = acquireLock(o.home, o.workflowId);
  const { ac, done } = register(o.home, o.workflowId);
  let reserved = false;
  try {
    const wf = readWorkflow(o.home, o.workflowId);
    if (wf === null) throw new RunError(`no workflow ${o.workflowId}`, "not_found");
    if (wf.status === "paused") throw new RunError("workflow is paused", "conflict");
    if (wf.status !== "active") throw new RunError("approve a dry run first: the workflow is not active", "conflict");
    recoverStale(o.home, wf.id, now);
    const pending = pendingLiveBatch(o.home, wf.id, now);
    if (pending !== null) return pending;
    // s26: a general plan workflow takes its items from the person's own list; no drafting, no model call.
    // s27: a workflow with a read source reads it first (read only, through the chain); the list is the fallback.
    if (isPlanWorkflow(wf)) {
      const list = wf.inputs.list;
      let source: RunSourceDTO = { kind: "list", name: list, via: null, message: NO_SOURCE_WORDS(list) };
      let read: { rows: ItemRow[]; name: string; line: string } | undefined;
      if (wf.read !== undefined) {
        const name = wf.read.targetName;
        if (o.read === undefined) {
          source = { kind: "list", name: list, via: null, message: `Reading ${name} is not set up on this Mac yet, so these values are from your list ${list}.` };
        } else {
          const done = contactedKeys(o.home, wf.id, wf.inputs.crmLog, now);
          const ledger = ledgerContacted(o.home, wf.id);
          const r = await o.read.fetch({
            wf,
            now,
            logPath: gateLogPath(o.home, wf.id),
            signal: ac.signal,
            cancelled: () => cancelReason(o.home, wf.id, ac),
            // Done rows are dropped before any limit (PR #35 review): a source with more rows than one batch is
            // worked through to the end.
            keep: (fields) => {
              const k = rowKey(wf.id, fields);
              return !done.has(k) && !ledger.has(addressHash(wf.id, k));
            },
          });
          if (!r.ok && r.status === "cancelled") throw new RunError(r.message, "conflict");
          recordRead(o.home, wf.id, r, now);
          if (r.ok) {
            source = { kind: "read", name, via: r.via, message: r.message };
            read = { rows: r.rows.map((fields, i) => ({ line: i + 1, fields })), name, line: `${r.message.replace(/\.$/, "")}: ${queryText(wf.read)}.` };
          } else {
            source = { kind: "list", name: list, via: null, message: `Could not read ${name}: ${r.message} These values are from your list ${list}.` };
          }
        }
      }
      const why = cancelReason(o.home, wf.id, ac);
      if (why !== null) throw new RunError(`stopped while reading: ${why}`, "conflict");
      let items: BatchItem[];
      try {
        items = planLiveItems({ home: o.home, wf, done: contactedKeys(o.home, wf.id, wf.inputs.crmLog, now), ledger: ledgerContacted(o.home, wf.id), ...(read === undefined ? {} : { read }), ...(wf.read !== undefined && read === undefined ? { warning: source.message } : {}) });
      } catch (err) {
        if (err instanceof PlanLiveError) throw new RunError(wf.read !== undefined && read === undefined ? `${source.message.replace(/ These values are from your list .*$/, "").replace(/, so these values are from your list .*$/, ".")} ${err.message}` : err.message, err.code);
        throw err;
      }
      const batch: Batch = { ...makeBatch(wf.id, "live", items, now), source };
      saveBatch(o.home, batch);
      return batch;
    }
    if (wf.template !== "investor_outreach") throw new RunError(`live batches for ${wf.template} workflows are not built yet`, "bad_request");
    // A reservation left by a crashed prepare sent nothing (prepare has no side effects): drop it.
    if (existsSync(preparingPath(o.home, wf.id))) rmSync(preparingPath(o.home, wf.id), { force: true });

    const factsText = readText(o.home, wf.id, "facts.md") ?? "";
    const facts = parseFacts(factsText);
    const contacted = contactedKeys(o.home, wf.id, wf.inputs.crmLog, now);
    const rows = readRecipients(readText(o.home, wf.id, wf.inputs.list) ?? "");
    // Sent or unknown in a batch that was already purged (7 days): still never written to again.
    const ledger = ledgerContacted(o.home, wf.id);
    for (const r of rows) if (ledger.has(addressHash(wf.id, r.email))) contacted.add(r.email);
    const next = pickNext(rows, contacted, wf.batchSize);
    const draftedWith = pinFiles(o.home, wf);
    if (next.length === 0) throw new RunError(`nobody left to write to in ${wf.inputs.list}`, "conflict");
    // Reserved on disk before the first model await.
    writePrivate(preparingPath(o.home, wf.id), JSON.stringify({ keys: next.map((r) => r.email), at: now, pid: process.pid }) + "\n");
    reserved = true;
    const pack = loadTonePack(o.home, now) ?? { corpus: [], cards: {} };
    // s19: the workflow's messaging playbook, when it has one (auto-run pins playbook.json).
    const playbook = readPlaybook(o.home, wf.id);
    const items: BatchItem[] = [];
    // s18: one name map per run (stable placeholders across recipients); drafts come back with the real names, so the
    // batch the user approves (and its hash) is the real text.
    const names = new NameMap(readNamePolicy(o.home, signNames(factsText)));
    for (const r of next) {
      const why = cancelReason(o.home, wf.id, ac);
      if (why !== null) throw new RunError(`stopped while drafting: ${why}`, "conflict");
      const recipient = { email: r.email, firstName: r.firstName, lastName: r.lastName, org: r.org, notes: r.notes };
      const subject = renderSubject(facts.subject ?? wf.inputs.subjectTemplate, facts, recipient);
      const d = await draftInTone({ pack, bucket: wf.bucket, recipient, subject, facts: factsText, model: o.model, models: wf.models, playbook, names });
      items.push({ key: r.email, to: r.email, subject, body: d.body, warnings: d.warnings, sourceRowHash: rowHash(r) });
    }
    const why = cancelReason(o.home, wf.id, ac);
    if (why !== null) throw new RunError(`stopped while drafting: ${why}`, "conflict");
    const batch: Batch = { ...makeBatch(wf.id, "live", items, now), draftedWith };
    saveBatch(o.home, batch);
    return batch;
  } finally {
    if (reserved && workflowExists(o.home, o.workflowId)) rmSync(preparingPath(o.home, o.workflowId), { force: true });
    done();
    lock.release();
  }
}

// ---------- approve ----------

export interface ApproveResult {
  batch: Batch;
  workflow: WorkflowJson;
  /** Token for a live batch; the executor run must hold it. */
  token: string | null;
}

/**
 * Approves exactly `hash`. A dry-run batch marks the workflow reviewed (active) and is never sendable.
 * A live batch gets a fresh token stored for that hash only.
 */
export function approveBatch(home: string, workflowId: string, hash: string, now: number, opts: { auto?: boolean } = {}): ApproveResult {
  const wf = readWorkflow(home, workflowId);
  if (wf === null) throw new RunError(`no workflow ${workflowId}`, "not_found");
  const batch = readBatch(home, workflowId, hash, now);
  if (batch === null) throw new RunError(`no batch ${hash} in ${workflowId}`, "not_found");
  if (!batchIntact(batch)) throw new RunError("the batch file changed after it was drafted: draft a new batch", "conflict");
  if (batch.state !== "pending") throw new RunError(`batch is ${batch.state}, not pending`, "conflict");
  if (wf.status === "paused") throw new RunError("workflow is paused", "conflict");
  batch.state = "approved";
  batch.approvedAt = now;
  saveBatch(home, batch);
  if (batch.kind === "dry_run") {
    const updated = updateWorkflow(home, workflowId, (w) => {
      w.status = "active";
      w.activatedAt ??= now;
    }, now);
    return { batch, workflow: updated, token: null };
  }
  const token = randomBytes(32).toString("base64url");
  // auto: approved by auto-run (the run loop), not by you: it stops when auto-run goes off (REVIEW-2 N5).
  saveApproval(home, workflowId, hash, { token, approvedAt: now, ...(opts.auto === true ? { auto: true } : {}) });
  return { batch, workflow: wf, token };
}

/**
 * Splits a pending live batch into the items in `keep` and the rest: two new pending batches (content hashes change),
 * the original file removed. `held` gets `review` (why auto-run did not send it). Returns null for an empty side.
 */
export function splitBatch(home: string, b: Batch, keep: ReadonlySet<string>, review: NonNullable<Batch["review"]>, now: number): { kept: Batch | null; held: Batch | null } {
  if (b.kind !== "live" || b.state !== "pending") throw new RunError(`batch is ${b.state}, not pending`, "conflict");
  const lock = acquireLock(home, b.workflowId);
  try {
    const extra = { ...(b.draftedWith === undefined ? {} : { draftedWith: b.draftedWith }) };
    const keptItems = b.items.filter((i) => keep.has(i.key));
    const heldItems = b.items.filter((i) => !keep.has(i.key));
    const kept = keptItems.length === 0 ? null : { ...makeBatch(b.workflowId, "live", keptItems, b.createdAt), ...extra };
    const held = heldItems.length === 0 ? null : { ...makeBatch(b.workflowId, "live", heldItems, b.createdAt), ...extra, review };
    if (kept !== null) saveBatch(home, kept);
    if (held !== null) saveBatch(home, held);
    if (kept?.hash !== b.hash && held?.hash !== b.hash) removeBatch(home, b.workflowId, b.hash);
    void now;
    return { kept, held };
  } finally {
    lock.release();
  }
}

/** Marks a pending batch as held by auto-run (why it did not send it). */
export function holdBatch(home: string, b: Batch, review: NonNullable<Batch["review"]>): Batch {
  const held = { ...b, review };
  saveBatch(home, held);
  return held;
}

// ---------- execute ----------

export interface ExecuteOptions {
  home: string;
  workflowId: string;
  hash: string;
  token: string | null;
  executor: Executor;
  /** Agent SDK MCP servers, resolved from connectors.json by the caller. */
  mcpServers?: Parameters<Executor["execute"]>[0]["mcpServers"];
  /** Server name -> catalog ids for those servers (connectors.json). Default: the gate's DEFAULT_SERVERS. */
  servers?: ServerMap;
  /** s13: dynamic gate policies of the connector chain (api operations, computer use), bound to their servers. */
  policies?: readonly ToolPolicy[];
  now?: () => number;
}

/** The side-effect actions a workflow's steps declare, as the gate sees them. */
export function declaredActions(wf: WorkflowJson): GateAction[] {
  const out: GateAction[] = [];
  for (const s of wf.steps) {
    if (!s.sideEffect || s.connector === null) continue;
    // s20 review 5: a UI commit (method computer) is declared as such: the gate lets only computer use do it.
    if (s.type === "send") out.push({ role: "send", connector: s.connector, ...(s.method === "computer" ? { method: "computer" as const } : {}) });
    else if (s.type === "log") out.push({ role: "log", connector: s.connector, ...(s.method === "computer" ? { method: "computer" as const } : {}) });
  }
  return out;
}

/** Runs the side-effect steps of one batch through the gate, then writes results and the CRM log. */
export async function executeBatch(o: ExecuteOptions): Promise<Batch> {
  const now = o.now ?? Date.now;
  if (readWorkflow(o.home, o.workflowId) === null) throw new RunError("no such workflow or batch", "not_found");
  const lock = acquireLock(o.home, o.workflowId);
  const { ac, done, setAuto } = register(o.home, o.workflowId);
  try {
    const wf = readWorkflow(o.home, o.workflowId);
    if (wf === null || readBatch(o.home, o.workflowId, o.hash, now()) === null) throw new RunError("no such workflow or batch", "not_found");
    if (wf.status === "paused") throw new RunError("workflow is paused", "conflict");
    recoverStale(o.home, wf.id, now());
    const batch = readBatch(o.home, o.workflowId, o.hash, now())!;
    if (batch.kind !== "live") throw new RunError("dry-run batches are never executed", "conflict");
    if (!batchIntact(batch)) throw new RunError("the batch file changed after review: nothing was sent", "conflict");
    if (batch.state !== "approved" && batch.state !== "pending") throw new RunError(`batch is ${batch.state}: a batch never runs twice`, "conflict");
    const approvals = readApprovals(o.home, o.workflowId);
    const rec = approvals[o.hash];
    const approved = batch.state === "approved" && rec !== undefined && o.token !== null && rec.token === o.token;
    const auto = batch.state === "pending" && wf.autoRun;
    // REVIEW-2 N1: the auto path (no token) sends only a batch that is entirely pinned and unchanged; anything else
    // stays pending for review, untouched.
    if (!approved && auto && !autoSendable(o.home, wf, batch)) return batch;
    const autoRun = auto || (approved && rec?.auto === true);
    setAuto(autoRun);
    batch.itemStates ??= {};
    const states = batch.itemStates;
    if (!approved && !auto) {
      // Fail closed without calling the executor: nothing was attempted, so nothing was sent.
      for (const i of batch.items) if (stateOf(batch, i.key) === "pending") states[i.key] = { state: "failed_before_send", at: now() };
      batch.results.push({ key: "*", tool: "runner", ok: false, at: now(), error: `not run: batch is ${batch.state} and the run holds no valid approval${wf.autoRun ? "" : " (auto-run is off)"}` });
      batch.state = "failed";
      saveBatch(o.home, batch);
      return batch;
    }
    // The approval is used up now; the gate keeps an in-memory snapshot for this run only.
    const snapshot = { ...approvals };
    deleteApproval(o.home, o.workflowId, o.hash);
    for (const i of batch.items) states[i.key] ??= { state: "pending", at: now() };
    batch.state = "sending";
    saveBatch(o.home, batch);

    const persist = () => {
      try {
        saveBatch(o.home, batch);
      } catch (err) {
        if (!(err instanceof WorkflowGoneError)) throw err;
      }
    };
    const gate = createGate({
      workflowId: wf.id,
      mode: "live",
      batch,
      autoRun: wf.autoRun,
      runToken: approved ? o.token : null,
      approvals: (h) => snapshot[h],
      servers: o.servers ?? DEFAULT_SERVERS,
      ...(o.policies === undefined ? {} : { policies: o.policies }),
      actions: declaredActions(wf),
      ...(wf.inputs.crmSheet === undefined ? {} : { crmSheet: wf.inputs.crmSheet }),
      itemState: (k) => states[k]?.state,
      // Written to disk BEFORE the tool runs; if it cannot be written the gate denies the call.
      onAllow: (k, role, tool) => {
        if (role !== "send") return;
        appendLedger(o.home, wf.id, k, "contacted");
        states[k] = { state: "sending", at: now(), tool };
        saveBatch(o.home, batch);
      },
      cancelled: () => cancelReason(o.home, wf.id, ac, autoRun),
      logPath: gateLogPath(o.home, wf.id),
      now,
    });
    const onToolResult = (r: ToolCallRecord) => {
      if (!r.allowed || r.itemKey === undefined) return;
      batch.results.push({ key: r.itemKey, tool: r.tool, ok: r.ok, at: now(), ...(r.error === undefined ? {} : { error: r.error }) });
      if (r.role === "send" && states[r.itemKey]?.state === "sending") {
        // A failed tool call may still have sent: unknown, never failed_before_send.
        states[r.itemKey] = { state: r.ok ? "sent" : "unknown", at: now(), tool: r.tool, ...(r.error === undefined ? {} : { error: r.error }) };
      }
      persist();
    };
    try {
      await o.executor.execute({
        batch,
        gate,
        model: wf.models.cheap,
        cwd: workflowDir(o.home, wf.id),
        signal: ac.signal,
        onToolResult,
        actions: declaredActions(wf),
        ...(wf.inputs.crmSheet === undefined ? {} : { crmSheet: wf.inputs.crmSheet }),
        ...(o.mcpServers === undefined ? {} : { mcpServers: o.mcpServers }),
      });
    } catch (err) {
      batch.results.push({ key: "*", tool: "executor", ok: false, at: now(), error: err instanceof Error ? err.message : String(err) });
    }
    for (const i of batch.items) {
      const s = stateOf(batch, i.key);
      if (s === "sending") states[i.key] = { ...states[i.key]!, state: "unknown", at: now(), error: states[i.key]?.error ?? "no result came back from the tool" };
      else if (s === "pending") states[i.key] = { state: "failed_before_send", at: now() };
    }
    batch.state = finalState(batch);
    if (!workflowExists(o.home, wf.id)) return batch;
    persist();
    const status = (k: string): CrmEntry["status"] => (stateOf(batch, k) === "sent" ? "sent" : stateOf(batch, k) === "unknown" ? "unknown" : "failed");
    const entries = batch.items.map((i) => ({ at: now(), email: i.to, subject: i.subject, batch: batch.hash, status: status(i.key) }));
    try {
      appendFileSync(join(workflowDir(o.home, wf.id), wf.inputs.crmLog), crmLines(entries), { mode: 0o600 });
    } catch (err) {
      console.error("brain: CRM log not written:", err instanceof Error ? err.message : err);
    }
    return batch;
  } finally {
    done();
    lock.release();
  }
}

// ---------- release (explicit user action) ----------

/** The user confirms these unknown items were not sent: they become failed_before_send and eligible again. */
export function releaseUnknown(home: string, workflowId: string, hash: string, keys: readonly string[], now: number): Batch {
  if (keys.length === 0) throw new RunError("name at least one recipient to release", "bad_request");
  const lock = acquireLock(home, workflowId);
  try {
    const b = readBatch(home, workflowId, hash, now);
    if (b === null || b.kind !== "live") throw new RunError(`no live batch ${hash} in ${workflowId}`, "not_found");
    for (const raw of keys) {
      const k = raw.toLowerCase();
      if (stateOf(b, k) !== "unknown") throw new RunError(`${k} is not unknown in this batch (it is ${b.items.some((i) => i.key === k) ? stateOf(b, k) : "not in it"})`, "bad_request");
    }
    for (const raw of keys) {
      const k = raw.toLowerCase();
      b.itemStates![k] = { ...b.itemStates![k]!, state: "failed_before_send", at: now, releasedAt: now };
    }
    saveBatch(home, b);
    for (const raw of keys) appendLedger(home, workflowId, raw.toLowerCase(), "released");
    return b;
  } finally {
    lock.release();
  }
}
