/**
 * The worker orchestrator (ADR 0105, ADR 0106 §4-7, ADR 0112): provisions Managed Agents environments, vaults,
 * agents and deployments; runs sessions and consumes their event streams; answers every permission request and
 * custom tool call; hands proposals to the broker; enforces kill switches, budgets and the tenant monthly cap; records
 * run outcomes. It never commits anything: commits are the broker's, after an approval by hash.
 *
 * Event handling is exactly-once per (session, event id): an event is acted on, then recorded in `session_events`;
 * a replayed or re-listed event that is already recorded is skipped. The stream is opened before the first event is
 * sent; after a drop the stream is reopened first and the missed events are listed from the cursor, so nothing is
 * lost between the two.
 *
 * LOCK ORDER. Worker rows are step 9 of the broker's lock order (broker.ts header): every broker lock comes before
 * them, the tenant's audit-chain lock after them. Within step 9 every transaction here takes, in this order and
 * never back up it: the tenant's `offload_workers_budget:<tenant>` advisory lock (run admission: the monthly cap's
 * check and its reservation, the run insert, are one critical section; the run route takes it before its worker row),
 * the worker's `offload_worker_sync:<worker>` advisory lock (held over a sync's remote calls; then
 * `offload_worker_provision:<tenant>` while provisioning; ADR 0112 §13), the runner's `offload_cloud_device:<person>` advisory lock, then worker_runs rows, then workers rows, then
 * deployments rows; two rows of one table in id order. Audit events are written after the last row lock.
 * Broker calls made inside these transactions (loadBatch, dto, killSwitchActive) only read and queue no audit.
 *
 * DURABILITY. Nothing is marked done before the remote call succeeded: an interrupt is requested in the deciding
 * transaction (`interrupt_sent_at`) and confirmed after Managed Agents accepted it (`interrupt_delivered_at`);
 * undelivered interrupts are retried by every sweep with backoff, and while one is requested no event of the run is
 * acted on. Nothing lives only in memory: `recover` (the per-minute `workers.recover` job, so also the first minute
 * after a start, and every reconcile tick) re-attaches a consumer to every unfinished session, fails a run whose
 * session id was never recorded after SESSION_RECORD_TIMEOUT_MS (releasing its budget), delivers pending interrupts
 * and reports ended runs to their overnight policy (`policy_reported_at`). One orchestrator process per tenant.
 */
import type { Deps, Principal } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { ms } from "../../db/pool.ts";
import { isUuid, withTenant } from "../../db/tenant.ts";
import { HttpError, conflict, invalid, notFound, type ErrorCode } from "../../schema/http.ts";
import { sha256Hex, ulid } from "../../schema/encoding.ts";
import type { WorkersPort } from "../../ports.ts";
import { brokerOf } from "../broker/index.ts";
import type { ProposeRun } from "../broker/index.ts";
import metrics from "../metrics/index.ts";
import { nightOf } from "../policies/evaluate.ts";
import { rolePolicyOf } from "../policies/repo.ts";
import type { RegistryApi } from "../registry/port.ts";
import { isTimezone, scheduleProblem } from "./cron.ts";
import { managedAgentsFromEnv, type ManagedAgentsApi, type SessionEvent, type UserEvent } from "./managed-agents.ts";
import { loadDeployment, loadRun, loadWorker, runRow, workerRow, type RunRow, type RunState, type StopReason, type WorkerRow } from "./repo.ts";
import { PROPOSE_INPUT, localValidator } from "./schemas.ts";
import {
  agentParams, budgetOf, confirmMcp, environmentParams, httpsUrl, mcpServersFor, runMessage, type McpServer, type ReadConnection,
} from "./tools.ts";

export const SESSION_RETENTION_DAYS = 30;
export const MAX_RECONNECTS = 5;
export const FAILURES_TO_PAUSE = 2;
/** A run whose session id is still unrecorded this long after it started is failed (the session, if any, is idle). */
export const SESSION_RECORD_TIMEOUT_MS = 10 * 60_000;
/** Retry delay of an undelivered interrupt: 30 s doubling per failed attempt, at most 15 minutes. */
export const interruptBackoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
const ERRORS_SESSION_MAY_RUN = new Set(["stream_lost", "stream_unavailable", "orchestrator_error"]);

/** Read credentials for a connection (deployment wiring: OAuth / KMS). Returning null creates no credential. */
export type CredentialSource = (c: { id: string; kind: string; externalRef: string }) => Promise<{ token: string; mcpServerUrl: string } | null>;

export interface StartOpts {
  trigger: "manual" | "schedule";
  runnerPersonId: string;
  inputs: { recipients?: string[]; context?: string } | null;
}

export interface Workers extends WorkersPort {
  isFullWorkers: true;
  configure(o: { api?: ManagedAgentsApi; credentials?: CredentialSource | null; retentionDays?: number }): void;
  /** Creates what a `provisioning` worker needs, then makes the remote deployment match (async callers: dispatch). */
  reconcile(tenantId: string, workerId?: string): Promise<void>;
  dispatchReconcile(tenantId: string, workerId: string): void;
  /** Route path: checks (tx), inserts the run, then creates the session and consumes it in the background. */
  startRun(tx: Tx, tenantId: string, worker: WorkerRow, o: StartOpts): Promise<RunRow>;
  dispatchRun(tenantId: string, run: RunRow, worker: WorkerRow, inputs: StartOpts["inputs"]): void;
  /** Tests: start a run without the route's checks (a run that began just before a kill switch). */
  startRunUnchecked(tenantId: string, workerId: string, o: StartOpts): Promise<string>;
  /** Re-attaches a consumer to a run's session (no-op if the run ended or is being consumed). */
  resume(tenantId: string, runId: string): Promise<void>;
  pollDeployments(tenantId: string): Promise<void>;
  /** Kill-switch enforcement for every scope: interrupts running sessions in scope, pauses deployments. */
  sweep(tenantId: string): Promise<void>;
  interruptAll(tenantId: string, scope: { tenant: true } | { personId: string } | { workflowId: string }): Promise<number>;
  retention(tenantId: string): Promise<number>;
  /** Restart recovery (see DURABILITY above); safe to repeat. */
  recover(tenantId: string): Promise<void>;
  /** Run admission's tenant-wide lock (lock order step 9, first). Callers take it before any worker row. */
  lockBudget(tx: Tx): Promise<void>;
  /** The worker's sync lock (lock order step 9, after the budget lock), for a transaction that rewrites its deployment. */
  lockWorkerSync(tx: Tx, workerId: string): Promise<void>;
  monthSpent(tx: Tx, excludeRunId?: string): Promise<{ spent: number; cap: number }>;
  idle(): Promise<void>;
  /** Stops every consumer (process exit, tests). Sessions keep running on the platform; resume re-attaches. */
  shutdown(): void;
}

export function workersOf(ports: { workers: WorkersPort }): Workers {
  const w = ports.workers as Partial<Workers>;
  if (w.isFullWorkers !== true) throw new Error("workers: the orchestrator is not bound to the app yet");
  return w as Workers;
}

const SERVICE = { type: "system" as const, id: null, accessRole: null };
const WEB_CAPABILITY = "web.research";
const BASH_CAPABILITY = "sandbox.bash";
const DAY_MS = 86_400_000;

/** Pauses a person's workers and their deployments, in the caller's transaction (ADR 0106 §4, ADR 0107). */
export async function pauseWorkersOf(tx: Tx, personId: string, now: number, reason: string): Promise<string[]> {
  // The person's unfinished runs: the interrupt is requested here, in the caller's transaction, so it survives a
  // restart; the orchestrator delivers it (at once if bound, else on the next sweep). Runs before workers.
  const mine = tx`select id from workers where owner_person_id = ${personId} or (identity_type = 'person' and identity_id = ${personId})`;
  const runs = await tx`select id from worker_runs where ended_at is null and interrupt_sent_at is null
    and (runner_person_id = ${personId} or worker_id in (${mine})) order by id for update`;
  if (runs.length > 0) {
    await tx`update worker_runs set interrupt_sent_at = ${new Date(now)} where id in ${tx(runs.map((r: { id: string }) => r.id))}`;
  }
  // Lock order: the rows in id order before the update (two of these can run at once for overlapping workers).
  await tx`select id from workers where state in ('ready', 'provisioning')
    and (owner_person_id = ${personId} or (identity_type = 'person' and identity_id = ${personId})) order by id for update`;
  const rows = await tx`update workers set state = 'paused', paused_reason = ${reason}, updated_at = ${new Date(now)}
    where state in ('ready', 'provisioning') and (owner_person_id = ${personId} or (identity_type = 'person' and identity_id = ${personId}))
    returning id`;
  const ids = rows.map((r: { id: string }) => r.id);
  if (ids.length > 0) {
    await tx`update deployments set desired_status = 'paused', updated_at = ${new Date(now)}
      where worker_id in ${tx(ids)} and desired_status = 'active'`;
  }
  return ids;
}

function hostsOf(servers: Record<string, McpServer>): string[] {
  return Object.values(servers).map((s) => new URL(s.url).hostname);
}

/** web.research domains from a connection's external_ref: hostnames or https URLs, comma separated. */
export function domainsOf(ref: string): string[] {
  const out: string[] = [];
  for (const part of ref.split(",").map((x) => x.trim()).filter(Boolean)) {
    const host = httpsUrl(part)?.hostname ?? (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(part) ? part.toLowerCase() : null);
    if (host && !out.includes(host)) out.push(host);
  }
  return out.slice(0, 64);
}

const OUTCOME: Record<RunState, "success" | "failed" | "cancelled" | "capped" | null> = {
  done: "success",
  waiting_approval: "success",
  idle: "success",
  capped: "capped",
  failed: "failed",
  interrupted: "cancelled",
  running: null,
};
export const outcomeOf = (s: RunState) => OUTCOME[s];

function safeCode(s: string): string {
  const c = s.toLowerCase().replace(/[^a-z_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
  return c.length > 0 ? c : "error";
}

function text(t: string) {
  return [{ type: "text" as const, text: t }];
}

export function createWorkers(deps: Deps): Workers {
  let api: ManagedAgentsApi = managedAgentsFromEnv();
  let credentials: CredentialSource | null = null;
  let retentionDays = SESSION_RETENTION_DAYS;
  const now = () => deps.clock.now();
  const audit = (tx: Tx, e: Parameters<Deps["ports"]["audit"]["write"]>[1]) => deps.ports.audit.write(tx, e);
  const service = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
    withTenant(deps.db, { tenantId, principalId: null, principalPersonId: null, accessRole: "service" }, fn);
  const broker = () => brokerOf(deps.ports);
  const registry = () => deps.ports.registry as RegistryApi;
  const inflight = new Set<Promise<unknown>>();
  // Consumers live as long as their session: they are not "work in flight" while they wait for the next event.
  const consuming = new Map<string, AbortController>();
  // Runs whose session this process is creating: recovery leaves them to openSession (which sends the first message).
  const opening = new Set<string>();
  let busy = 0;
  // One provisioning at a time per tenant: the environment is shared and must not be created twice.
  const tenantLocks = new Map<string, Promise<unknown>>();

  function track<T>(p: Promise<T>): Promise<T> {
    const q = p.catch((e) => {
      console.error(`workers: ${(e as Error).message}`);
    });
    inflight.add(q);
    void q.finally(() => inflight.delete(q));
    return p;
  }

  function locked<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const prev = tenantLocks.get(tenantId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    tenantLocks.set(tenantId, next.catch(() => undefined));
    return next;
  }

  // ---------- provisioning ----------

  interface Plan {
    servers: Record<string, McpServer>;
    readConns: ReadConnection[];
    webDomains: string[] | null;
    bash: boolean;
    model: string;
    name: string;
    skillMd: string;
  }

  async function plan(tx: Tx, w: WorkerRow): Promise<{ ok: true; plan: Plan } | { ok: false; reason: string }> {
    const v = await registry().getVersion(tx, w.workflowId, w.version);
    if (!v || v.state !== "role") return { ok: false, reason: "the workflow version is not a live role version" };
    const policy = await rolePolicyOf(tx, w.jobRoleId);
    if (!policy) return { ok: false, reason: "the job role has no role policy" };
    const bindings = (await registry().bindingsFor(tx, w.workflowId, w.version)).filter((b) => !b.disabled);
    const readConns: ReadConnection[] = [];
    let webDomains: string[] | null = null;
    for (const b of bindings) {
      if (b.stepClass !== "read" || b.connectionId === null) continue;
      const [c] = await tx`select id, kind, external_ref from connections where id = ${b.connectionId}`;
      if (!c) return { ok: false, reason: `read step ${b.stepId} is bound to a connection that no longer exists` };
      if (b.capability === WEB_CAPABILITY) {
        webDomains = [...(webDomains ?? []), ...domainsOf(c.external_ref as string)].filter((x, i, a) => a.indexOf(x) === i);
        continue;
      }
      readConns.push({ id: c.id as string, kind: c.kind as string, externalRef: c.external_ref as string });
    }
    const m = mcpServersFor(readConns);
    if (!m.ok) return { ok: false, reason: m.reason };
    return {
      ok: true,
      plan: {
        servers: m.servers,
        readConns,
        webDomains,
        bash: bindings.some((b) => b.capability === BASH_CAPABILITY),
        model: policy.models.steps,
        name: v.definition.name,
        skillMd: v.definition.skillMd,
      },
    };
  }

  async function failProvision(tenantId: string, workerId: string, reason: string): Promise<void> {
    await service(tenantId, async (tx) => {
      await tx`update workers set state = 'failed', failed_reason = ${reason.slice(0, 300)}, updated_at = ${new Date(now())}
        where id = ${workerId} and state = 'provisioning'`;
      await audit(tx, { actor: SERVICE, action: "worker.provision_failed", resource: { type: "worker", id: workerId }, detail: { reason: reason.slice(0, 300) } });
    });
  }

  async function provisionOne(tenantId: string, workerId: string): Promise<void> {
    const prep = await service(tenantId, async (tx) => {
      const w = await loadWorker(tx, workerId);
      if (!w || w.state !== "provisioning") return null;
      const p = await plan(tx, w);
      return { w, p };
    });
    if (!prep) return;
    const { w, p } = prep;
    if (!p.ok) return failProvision(tenantId, workerId, p.reason);
    const pl = p.plan;
    try {
      // Environment: one per tenant, hosts = every live worker's read hosts.
      const env = await service(tenantId, async (tx) => {
        const [e] = await tx`select environment_id, allowed_hosts from worker_environments`;
        const others = await tx`select mcp_servers from workers where state in ('ready', 'paused') and id <> ${workerId}`;
        const hosts = [...new Set([...hostsOf(pl.servers), ...others.flatMap((o: { mcp_servers: Record<string, McpServer> }) => hostsOf(o.mcp_servers))])].sort();
        return { id: (e?.environment_id as string | undefined) ?? null, hosts, prior: (e?.allowed_hosts as string[] | undefined) ?? null };
      });
      let environmentId = env.id;
      if (environmentId === null) {
        environmentId = (await api.createEnvironment(environmentParams(tenantId, env.hosts))).id;
      } else if (JSON.stringify(env.prior) !== JSON.stringify(env.hosts)) {
        await api.updateEnvironment(environmentId, environmentParams(tenantId, env.hosts));
      }
      await service(tenantId, (tx) => tx`insert into worker_environments (tenant_id, environment_id, allowed_hosts, updated_at)
        values (current_setting('app.tenant_id')::uuid, ${environmentId}, ${env.hosts}::jsonb, ${new Date(now())})
        on conflict (tenant_id) do update set environment_id = excluded.environment_id, allowed_hosts = excluded.allowed_hosts, updated_at = excluded.updated_at`);
      // Vault: one per job role, read credentials only.
      const vault = await service(tenantId, async (tx) => {
        const [v] = await tx`select vault_id, credential_connection_ids from worker_vaults where job_role_id = ${w.jobRoleId}`;
        const [jr] = await tx`select name from job_roles where id = ${w.jobRoleId}`;
        return { id: (v?.vault_id as string | undefined) ?? null, have: (v?.credential_connection_ids as string[] | undefined) ?? [], name: (jr?.name as string | undefined) ?? "job role" };
      });
      let vaultId = vault.id;
      if (vaultId === null) {
        vaultId = (await api.createVault({ display_name: `Offload ${vault.name}`.slice(0, 255), metadata: { offload_job_role_id: w.jobRoleId } })).id;
        await service(tenantId, (tx) => tx`insert into worker_vaults (tenant_id, job_role_id, vault_id, created_at)
          values (current_setting('app.tenant_id')::uuid, ${w.jobRoleId}, ${vaultId}, ${new Date(now())}) on conflict do nothing`);
      }
      const added: string[] = [];
      if (credentials) {
        for (const c of pl.readConns) {
          if (vault.have.includes(c.id)) continue;
          const cred = await credentials(c);
          if (!cred) continue;
          await api.createCredential(vaultId, { display_name: `read ${c.kind}`, auth: { type: "static_bearer", token: cred.token, mcp_server_url: cred.mcpServerUrl } });
          added.push(c.id);
          // Recorded one by one: a stop mid-loop repeats at most the one credential in flight.
          await service(tenantId, (tx) => tx`update worker_vaults set credential_connection_ids = credential_connection_ids || ${[c.id]}::jsonb where job_role_id = ${w.jobRoleId}`);
        }
      }
      const agent = await api.createAgent(
        agentParams({ name: pl.name, version: w.version, model: pl.model, skillMd: pl.skillMd, servers: pl.servers, tools: { bash: pl.bash, webDomains: pl.webDomains }, workerId }),
      );
      await service(tenantId, async (tx) => {
        await tx`update workers set state = 'ready', agent_id = ${agent.id}, agent_version = ${agent.version}, environment_id = ${environmentId},
            vault_id = ${vaultId}, mcp_servers = ${pl.servers}::jsonb, updated_at = ${new Date(now())}
          where id = ${workerId} and state = 'provisioning'`;
        await audit(tx, {
          actor: SERVICE,
          action: "worker.provisioned",
          resource: { type: "worker", id: workerId },
          detail: { agentId: agent.id, agentVersion: agent.version, environmentId, vaultId, mcpServers: Object.keys(pl.servers), credentials: added.length },
        });
      });
    } catch (e) {
      await failProvision(tenantId, workerId, `Managed Agents: ${(e as Error).message}`);
    }
  }

  async function syncDeployment(tenantId: string, workerId: string): Promise<void> {
    const s = await service(tenantId, async (tx) => ({ w: await loadWorker(tx, workerId), d: await loadDeployment(tx, workerId) }));
    const { w, d } = s;
    if (!w || !d) return;
    const set = (fields: { deploymentId?: string | null; remote?: string; stale?: string[] }) =>
      service(tenantId, (tx) => tx`update deployments set
          deployment_id = ${fields.deploymentId === undefined ? d.deploymentId : fields.deploymentId},
          remote_status = ${fields.remote ?? d.remote},
          stale_deployment_ids = ${fields.stale ?? d.stale}::jsonb, updated_at = ${new Date(now())}
        where worker_id = ${workerId}`);
    // Archived on the platform is not forgotten: remote_deployments keeps polling it until it is drained.
    const archived = (id: string) =>
      service(tenantId, (tx) => tx`update remote_deployments set archived_at = coalesce(archived_at, ${new Date(now())}) where deployment_id = ${id}`);
    for (const old of d.stale) {
      await api.archiveDeployment(old);
      await archived(old);
      d.stale = d.stale.filter((x) => x !== old);
      await set({ stale: d.stale });
    }
    if (d.desired === "archived") {
      if (d.deploymentId && d.remote !== "archived") {
        await api.archiveDeployment(d.deploymentId);
        await archived(d.deploymentId);
        await set({ remote: "archived" });
      }
      return;
    }
    if (!d.deploymentId) {
      if (w.state !== "ready" || d.desired !== "active" || d.holdReason !== null || !w.agentId || !w.environmentId) return;
      // A create started earlier never got its answer recorded: the platform may run a deployment Offload does not
      // know. Never create a second one; a person resolves it (ADR 0112 §13).
      if (d.createKey !== null) return unconfirmedDeployment(tenantId, w.id, d);
      // The marker (and its key, sent as metadata) is committed before the remote call.
      const key = crypto.randomUUID();
      const [claimed] = await service(tenantId, (tx) => tx`update deployments set create_key = ${key}, create_started_at = ${new Date(now())}
        where worker_id = ${workerId} and deployment_id is null and create_key is null returning worker_id`);
      if (!claimed) return;
      let created: { id: string };
      try {
        created = await api.createDeployment({
          name: `offload-${w.id}`,
          agent: { type: "agent", id: w.agentId, version: w.agentVersion ?? 1 },
          environment_id: w.environmentId,
          vault_ids: w.vaultId ? [w.vaultId] : [],
          budget: budgetOf(w.sessionBudgetCents),
          schedule: { type: "cron", expression: d.cron, timezone: d.timezone },
          initial_events: [runMessage({ runId: "", workflow: w.workflowId, inputs: null, scheduled: true })],
          metadata: { offload_worker_id: w.id, offload_create_key: key },
        });
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        if (typeof status === "number" && status >= 400 && status < 500) {
          // Refused: nothing was made. The next reconcile tries again.
          await service(tenantId, (tx) => tx`update deployments set create_key = null, create_started_at = null where worker_id = ${workerId} and create_key = ${key}`);
          console.error(`workers: deployment of worker ${w.id} refused: ${(e as Error).message}`);
          return;
        }
        // No answer (5xx, timeout, network): it may exist. The key stays.
        return unconfirmedDeployment(tenantId, w.id, { ...d, createKey: key });
      }
      await service(tenantId, async (tx) => {
        await tx`update deployments set deployment_id = ${created.id}, remote_status = 'active', create_key = null,
            create_started_at = null, updated_at = ${new Date(now())} where worker_id = ${workerId} and create_key = ${key}`;
        // Tracked until drained, with the budget its sessions are created with.
        await tx`insert into remote_deployments (tenant_id, deployment_id, worker_id, budget_cents, created_at)
          values (current_setting('app.tenant_id')::uuid, ${created.id}, ${workerId}, ${w.sessionBudgetCents}, ${new Date(now())}) on conflict do nothing`;
      });
      await service(tenantId, (tx) => audit(tx, { actor: SERVICE, action: "worker.deployment", resource: { type: "worker", id: w.id }, detail: { deploymentId: created.id, cron: d.cron, timezone: d.timezone } }));
      return;
    }
    const want = w.state === "ready" && d.desired === "active" && d.holdReason === null ? "active" : "paused";
    if (want === "paused" && d.remote === "active") {
      await api.pauseDeployment(d.deploymentId);
      await set({ remote: "paused" });
    } else if (want === "active" && d.remote === "paused") {
      await api.unpauseDeployment(d.deploymentId);
      await set({ remote: "active" });
    }
  }

  /** Flags an unconfirmed remote create once: an audit event and a log line for a person to resolve. */
  async function unconfirmedDeployment(tenantId: string, workerId: string, d: { createKey: string | null; createAlertedAt: number | null }): Promise<void> {
    if (d.createAlertedAt !== null) return;
    const flagged = await service(tenantId, async (tx) => {
      const [u] = await tx`update deployments set create_alerted_at = ${new Date(now())} where worker_id = ${workerId} and create_alerted_at is null
        returning create_key, create_started_at`;
      if (!u) return false;
      await audit(tx, {
        actor: SERVICE,
        action: "worker.deployment_unconfirmed",
        resource: { type: "worker", id: workerId },
        detail: { createKey: u.create_key as string, startedAt: ms(u.create_started_at as Date) },
      });
      return true;
    });
    if (flagged) console.error(`workers: worker ${workerId}: a deployment create (key ${d.createKey}) got no answer; it may exist on Managed Agents (metadata offload_create_key). No second create until a person resolves it.`);
  }

  /**
   * One worker's remote state, serialized: in this process per tenant (one pool connection waits at a time), across
   * processes by the advisory lock `offload_worker_sync:<worker>` (lock order step 9, right after the budget lock),
   * held over the remote calls; provisioning also takes `offload_worker_provision:<tenant>` (the tenant's one
   * environment). Every path that syncs a deployment comes through here.
   */
  function syncWorker(tenantId: string, workerId: string, provision: boolean): Promise<void> {
    return locked(tenantId, () =>
      service(tenantId, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${"offload_worker_sync:" + workerId}))`;
        if (provision) {
          const [x] = await tx`select state from workers where id = ${workerId}`;
          if (x?.state === "provisioning") {
            await tx`select pg_advisory_xact_lock(hashtext(${"offload_worker_provision:" + tenantId}))`;
            await provisionOne(tenantId, workerId);
          }
        }
        await syncDeployment(tenantId, workerId);
      }),
    );
  }

  async function reconcile(tenantId: string, workerId?: string): Promise<void> {
    if (!workerId) await recover(tenantId);
    const ids = workerId
      ? [workerId]
      : await service(tenantId, async (tx) => (await tx`select id from workers where state <> 'retired' or id in (select worker_id from deployments where remote_status <> desired_status) order by created_at`).map((r: { id: string }) => r.id));
    for (const id of ids) {
      // One worker's failure does not stop the others.
      try {
        await syncWorker(tenantId, id, true);
      } catch (e) {
        console.error(`workers: reconcile of worker ${id}: ${(e as Error).message}`);
      }
    }
  }

  // ---------- runs ----------

  async function lockBudget(tx: Tx): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtext('offload_workers_budget:' || current_setting('app.tenant_id')))`;
  }

  async function monthSpent(tx: Tx, excludeRunId?: string): Promise<{ spent: number; cap: number }> {
    const [t] = await tx`select monthly_worker_budget_cents, reporting_timezone from tenants where id = current_setting('app.tenant_id')::uuid`;
    const tz = (t?.reporting_timezone as string | undefined) ?? "UTC";
    // This month in the tenant's reporting timezone; a running session counts at its whole budget, and so does the
    // session of a run that ended because we lost it, until it is confirmed stopped (settleLost).
    const [s] = await tx`select coalesce(sum(case when ended_at is null or session_unsettled then greatest(cost_cents, budget_cents) else cost_cents end), 0)::bigint as spent
      from worker_runs where date_trunc('month', started_at at time zone ${tz}) = date_trunc('month', ${new Date(now())}::timestamptz at time zone ${tz})
        and id <> ${excludeRunId ?? ""}`;
    return { spent: Number(s!.spent), cap: Number(t?.monthly_worker_budget_cents ?? 0) };
  }

  async function overnightPolicyFor(tx: Tx, w: WorkerRow, runner: string): Promise<string | null> {
    // The active overnight policy of this workflow version that the run's identity owns (role identities: any).
    const [p] = await tx`select id from overnight_policies where workflow_id = ${w.workflowId} and version = ${w.version} and state = 'active'
      and (${w.identityType} = 'role_identity' or owner_person_id = ${runner}) order by id limit 1`;
    return (p?.id as string | undefined) ?? null;
  }

  async function insertRun(
    tx: Tx,
    w: WorkerRow,
    o: StartOpts & { deploymentRunRef?: string; deploymentId?: string; budgetCents?: number; sessionRef?: string; state?: RunState; errorCode?: string; startedAt?: string },
  ): Promise<RunRow> {
    // A scheduled run imported from the platform started when the platform started it (dr.created_at), not when we
    // polled: the digest window, the month it is charged to and its outcome follow that time. Never in the future.
    const given = o.startedAt !== undefined ? Date.parse(o.startedAt) : NaN;
    const startedAt = Number.isFinite(given) ? Math.min(given, now()) : now();
    const id = ulid(startedAt);
    const runner = w.identityType === "person" ? w.identityId : o.runnerPersonId;
    const policyId = o.trigger === "schedule" ? await overnightPolicyFor(tx, w, runner) : null;
    // ADR 0105 §7: recipients come from the run's input set; a scheduled run's only set is its overnight allowlist.
    // Fail closed: no trusted recipients is the empty set, never a missing one (the broker skips a missing set).
    const recipients: string[] = o.trigger === "schedule" ? [] : (o.inputs?.recipients ?? []);
    const ended = o.state !== undefined && o.state !== "running";
    const [r] = await tx`insert into worker_runs (tenant_id, id, worker_id, trigger, runner_person_id, input_recipients, overnight,
        overnight_policy_id, started_at, ended_at, state, stop_reason, error_code, budget_cents, session_ref, deployment_run_ref, deployment_id)
      values (current_setting('app.tenant_id')::uuid, ${id}, ${w.id}, ${o.trigger}, ${runner}, ${recipients}::jsonb,
        ${o.trigger === "schedule"}, ${policyId}, ${new Date(startedAt)}, ${ended ? new Date(now()) : null}, ${o.state ?? "running"},
        ${ended ? "error" : null}, ${o.errorCode ?? null}, ${o.budgetCents ?? w.sessionBudgetCents}, ${o.sessionRef ?? ""}, ${o.deploymentRunRef ?? null},
        ${o.deploymentId ?? null})
      returning *`;
    return runRow(r!);
  }

  /** The registry gate a manual run passes (startRun): the version is live and the worker's identity runs it. */
  function eligible(tx: Tx, w: WorkerRow): Promise<boolean> {
    return registry().isRunnableBy(tx, w.workflowId, w.version, w.identityType === "person" ? { personId: w.identityId } : { identityId: w.identityId });
  }

  /**
   * Why a scheduled session may not run, by the gates a manual run passes, in startRun's order: kill switch, worker
   * state, eligibility, the monthly cap (a session the platform already started counts at its budget).
   */
  async function scheduledRefusal(tx: Tx, w: WorkerRow, runner: string, run: RunRow): Promise<"kill_switch_active" | "worker_not_ready" | "ineligible" | "budget_exceeded" | null> {
    if (await killedFor(tx, w, runner)) return "kill_switch_active";
    if (w.state !== "ready") return "worker_not_ready";
    if (!(await eligible(tx, w))) return "ineligible";
    const { spent, cap } = await monthSpent(tx, run.id);
    return spent + run.budgetCents > cap ? "budget_exceeded" : null;
  }

  /** What holds a ready worker's active deployment paused now (budget, eligibility), or null. */
  async function holdOf(tx: Tx, w: WorkerRow): Promise<"budget_exceeded" | "ineligible" | null> {
    if (!(await eligible(tx, w))) return "ineligible";
    const { spent, cap } = await monthSpent(tx);
    return spent + w.sessionBudgetCents > cap ? "budget_exceeded" : null;
  }

  /**
   * Keeps enforcing the scheduled-run gates on active deployments: a deployment is held paused while its worker is
   * ineligible or the cap leaves no session, and released when it may run again. The remote pause/unpause is the
   * sync's (durable: desired vs remote, retried every tick).
   */
  async function refreshHolds(tenantId: string): Promise<void> {
    const changed = await service(tenantId, async (tx) => {
      const out: string[] = [];
      for (const row of await tx`select w.*, d.hold_reason from workers w join deployments d on d.tenant_id = w.tenant_id and d.worker_id = w.id
          where d.desired_status = 'active' and w.state = 'ready' order by w.id`) {
        const w = workerRow(row);
        const hold = await holdOf(tx, w);
        if (hold === ((row.hold_reason as string | null) ?? null)) continue;
        await tx`update deployments set hold_reason = ${hold}, updated_at = ${new Date(now())} where worker_id = ${w.id}`;
        out.push(w.id);
      }
      return out;
    });
    for (const id of changed) await syncWorker(tenantId, id, false);
  }

  async function killedFor(tx: Tx, w: { workflowId: string; identityType: string; identityId: string }, runner: string): Promise<boolean> {
    const b = deps.ports.broker;
    if (await b.killSwitchActive(tx, { personId: runner, workflowId: w.workflowId })) return true;
    return w.identityType === "person" && w.identityId !== runner ? b.killSwitchActive(tx, { personId: w.identityId }) : false;
  }

  async function startRun(tx: Tx, _tenantId: string, w: WorkerRow, o: StartOpts): Promise<RunRow> {
    const runner = w.identityType === "person" ? w.identityId : o.runnerPersonId;
    if (await killedFor(tx, w, runner)) throw new HttpError(409, "kill_switch_active", "a kill switch stops this worker");
    if (w.state !== "ready") throw conflict(`this worker is ${w.state}`);
    const runnable = await registry().isRunnableBy(tx, w.workflowId, w.version, w.identityType === "person" ? { personId: w.identityId } : { identityId: w.identityId });
    if (!runnable) throw conflict("this workflow version can no longer run as this identity");
    // Check and reservation (the insert below) under the tenant's admission lock; the route took it first already.
    await lockBudget(tx);
    const { spent, cap } = await monthSpent(tx);
    if (spent + w.sessionBudgetCents > cap) {
      throw new HttpError(409, "budget_exceeded", "this month's cloud budget would be exceeded by one more session");
    }
    const run = await insertRun(tx, w, o);
    await audit(tx, {
      actor: SERVICE,
      action: "worker.run_start",
      subjectPersonId: run.runnerPersonId,
      resource: { type: "worker_run", id: run.id },
      detail: { workerId: w.id, trigger: o.trigger, budgetCents: w.sessionBudgetCents },
    });
    return run;
  }

  /** After the route's transaction has committed: create the session and consume it. */
  function dispatchRun(tenantId: string, run: RunRow, w: WorkerRow, inputs: StartOpts["inputs"]): void {
    void track(openSession(tenantId, run.id, runMessage({ runId: run.id, workflow: w.workflowId, inputs, scheduled: false })));
  }

  async function openSession(tenantId: string, runId: string, first: ReturnType<typeof runMessage>): Promise<void> {
    opening.add(runId);
    try {
      await openSessionOnce(tenantId, runId, first);
    } finally {
      opening.delete(runId);
    }
  }

  async function openSessionOnce(tenantId: string, runId: string, first: ReturnType<typeof runMessage>): Promise<void> {
    const s = await service(tenantId, async (tx) => {
      const run = await loadRun(tx, runId);
      return run ? { run, w: (await loadWorker(tx, run.workerId))! } : null;
    });
    if (!s || s.run.state !== "running") return;
    let sessionId: string;
    try {
      const created = await api.createSession({
        agent: { type: "agent", id: s.w.agentId!, version: s.w.agentVersion ?? 1 },
        environment_id: s.w.environmentId!,
        vault_ids: s.w.vaultId ? [s.w.vaultId] : [],
        // The budget the run reserved at admission (a raise after it does not reach this session).
        budget: budgetOf(s.run.budgetCents),
        title: `Offload run ${runId}`,
        metadata: { offload_run_id: runId, offload_worker_id: s.w.id },
      });
      sessionId = created.id;
    } catch (e) {
      await finish(tenantId, runId, "failed", "error", "session_create_failed");
      console.error(`workers: session for run ${runId} not created: ${(e as Error).message}`);
      return;
    }
    // A session nobody sends a first message to stays idle: if the run ended meanwhile (recovery timed it out), the
    // session is left unrecorded and inert.
    const rec = await service(tenantId, async (tx) => {
      // The first message is stored with the session id: a process that stops before sending it leaves it to recovery.
      const [u] = await tx`update worker_runs set session_ref = ${sessionId}, first_message = ${first}::jsonb where id = ${runId} and ended_at is null
        returning interrupt_sent_at`;
      if (!u) return null;
      await tx`insert into session_cursors (tenant_id, session_id, run_id) values (current_setting('app.tenant_id')::uuid, ${sessionId}, ${runId})
        on conflict do nothing`;
      return { interrupt: u.interrupt_sent_at !== null };
    });
    if (!rec) return;
    if (rec.interrupt) {
      // Stopped before the session existed: deliver the interrupt, never the first message.
      await deliverInterrupt(tenantId, runId, sessionId);
      void consume(tenantId, runId);
      return;
    }
    void consume(tenantId, runId, first);
  }

  // ---------- the event consumer ----------

  interface Ctx {
    tenantId: string;
    run: RunRow;
    w: WorkerRow;
    sessionId: string;
    bash: boolean;
  }

  async function ctxOf(tenantId: string, runId: string): Promise<Ctx | null> {
    return service(tenantId, async (tx) => {
      const run = await loadRun(tx, runId);
      if (!run || run.sessionRef === "") return null;
      const w = (await loadWorker(tx, run.workerId))!;
      const bindings = await registry().bindingsFor(tx, w.workflowId, w.version);
      return { tenantId, run, w, sessionId: run.sessionRef, bash: bindings.some((b) => !b.disabled && b.capability === BASH_CAPABILITY) };
    });
  }

  async function consume(tenantId: string, runId: string, first?: ReturnType<typeof runMessage>): Promise<void> {
    if (consuming.has(runId)) return;
    const ac = new AbortController();
    consuming.set(runId, ac);
    busy += 1;
    let waiting = false;
    const wait = () => {
      if (!waiting) busy -= 1;
      waiting = true;
    };
    const work = () => {
      if (waiting) busy += 1;
      waiting = false;
    };
    try {
      const ctx = await ctxOf(tenantId, runId);
      if (!ctx || ctx.run.state !== "running") return;
      const sid = ctx.sessionId;
      let stream: AsyncIterable<SessionEvent>;
      try {
        // Stream first (ADR 0105 §6): nothing the session does after our first event can be missed.
        stream = await api.streamEvents(sid, ac.signal);
        // Shut down while the stream was opening: send nothing; recovery sends the stored first message.
        if (ac.signal.aborted) return;
        if (first) {
          // Stopped while the stream opened: the first message is never sent; the log shows how the session idled.
          if (!(await sendFirst(ctx, first)) && (await catchUp(ctx))) return;
        } else {
          const pending = await pendingFirst(ctx);
          if (pending) await sendFirst(ctx, pending);
          if (await catchUp(ctx)) return;
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        await finish(tenantId, runId, "failed", "error", "stream_unavailable");
        console.error(`workers: run ${runId}: ${(e as Error).message}`);
        return;
      }
      for (let reconnects = 0; ; ) {
        try {
          wait();
          for await (const ev of stream) {
            work();
            if (await handle(ctx, ev)) return;
            wait();
          }
          work();
          // Shut down (process exit, restart): the session keeps running and recovery re-attaches; never end it here.
          if (ac.signal.aborted) return;
        } catch (e) {
          work();
          if (ac.signal.aborted) return;
          console.error(`workers: run ${runId}: stream dropped: ${(e as Error).message}`);
        }
        reconnects += 1;
        await service(tenantId, (tx) => tx`update session_cursors set reconnects = reconnects + 1 where session_id = ${sid}`);
        if (reconnects > MAX_RECONNECTS) {
          await finish(tenantId, runId, "failed", "error", "stream_lost");
          return;
        }
        try {
          stream = await api.streamEvents(sid, ac.signal);
          if (await catchUp(ctx)) return;
        } catch (e) {
          console.error(`workers: run ${runId}: reconnect failed: ${(e as Error).message}`);
          stream = (async function* () {})();
        }
      }
    } catch (e) {
      console.error(`workers: run ${runId}: ${(e as Error).message}`);
      if (ac.signal.aborted) return;
      await finish(tenantId, runId, "failed", "error", "orchestrator_error").catch(() => undefined);
    } finally {
      work();
      busy -= 1;
      ac.abort();
      consuming.delete(runId);
    }
  }

  /**
   * Sends work to a run's session unless the run has ended or its interrupt is requested. The run's row lock is held
   * across the send, and every interrupt request updates that row: a request made first is seen here, one made during
   * the send waits for it and is delivered after it. So no work ever reaches a session after its interrupt.
   */
  async function sendUnlessStopped(ctx: Ctx, events: UserEvent[] | [ReturnType<typeof runMessage>], after?: (tx: Tx) => Promise<unknown>): Promise<boolean> {
    return service(ctx.tenantId, async (tx) => {
      const [r] = await tx`select interrupt_sent_at, ended_at from worker_runs where id = ${ctx.run.id} for update`;
      if (!r || r.interrupt_sent_at !== null || r.ended_at !== null) return false;
      await api.sendEvents(ctx.sessionId, events as UserEvent[]);
      if (after) await after(tx);
      return true;
    });
  }

  /** The run's first message, unless the run was stopped first. False when it was not sent. */
  async function sendFirst(ctx: Ctx, first: ReturnType<typeof runMessage>): Promise<boolean> {
    return sendUnlessStopped(ctx, [first], (tx) => tx`update worker_runs set first_sent_at = coalesce(first_sent_at, ${new Date(now())}) where id = ${ctx.run.id}`);
  }

  /**
   * The stored first message if it never reached the session (a process stopped between recording the session and
   * sending it). The session's own event log decides: a user.message there means it was sent and only the mark was
   * lost, so it is never sent twice. Nothing for scheduled runs (the platform sends theirs) or stopped runs.
   */
  async function pendingFirst(ctx: Ctx): Promise<ReturnType<typeof runMessage> | null> {
    const [r] = await service(ctx.tenantId, (tx) => tx`select first_message, first_sent_at, interrupt_sent_at from worker_runs where id = ${ctx.run.id}`);
    if (!r || r.first_message === null || r.first_sent_at !== null || r.interrupt_sent_at !== null) return null;
    if ((await api.listEvents(ctx.sessionId)).some((e) => e.type === "user.message")) {
      await service(ctx.tenantId, (tx) => tx`update worker_runs set first_sent_at = coalesce(first_sent_at, ${new Date(now())}) where id = ${ctx.run.id}`);
      return null;
    }
    return r.first_message as ReturnType<typeof runMessage>;
  }

  /**
   * Lists the session's whole event log and handles the events not yet handled (by event id). No time cursor: the
   * list filter compares processed_at, and an event processed late can sort before one already handled, so any
   * cursor could skip it. True when the run ended.
   */
  async function catchUp(ctx: Ctx): Promise<boolean> {
    const done = new Set(
      ((await service(ctx.tenantId, (tx) => tx`select event_id from session_events where session_id = ${ctx.sessionId}`)) as Array<{ event_id: string }>).map((r) => r.event_id),
    );
    for (const ev of await api.listEvents(ctx.sessionId)) {
      if (typeof ev?.id === "string" && done.has(ev.id)) continue;
      if (await handle(ctx, ev)) return true;
    }
    return false;
  }

  async function seen(ctx: Ctx, ev: SessionEvent): Promise<boolean> {
    const [r] = await service(ctx.tenantId, (tx) => tx`select 1 from session_events where session_id = ${ctx.sessionId} and event_id = ${ev.id}`);
    return r !== undefined;
  }

  async function mark(ctx: Ctx, ev: SessionEvent): Promise<void> {
    await service(ctx.tenantId, async (tx) => {
      await tx`insert into session_events (tenant_id, session_id, event_id, type, handled_at)
        values (current_setting('app.tenant_id')::uuid, ${ctx.sessionId}, ${ev.id}, ${ev.type.slice(0, 64)}, ${new Date(now())}) on conflict do nothing`;
      // last_processed_at is informational only: catch-up never filters by it (see catchUp).
      await tx`update session_cursors set last_event_id = ${ev.id},
          last_processed_at = greatest(coalesce(last_processed_at, ''), ${ev.processed_at ?? ""})
        where session_id = ${ctx.sessionId}`;
    });
  }

  /** A reply to the session (tool confirmation or result): never after the run's interrupt (sendUnlessStopped). */
  async function send(ctx: Ctx, e: UserEvent): Promise<void> {
    await sendUnlessStopped(ctx, [e]);
  }

  const ACTIONABLE = new Set(["agent.mcp_tool_use", "agent.tool_use", "agent.custom_tool_use"]);

  /** Acts on one event, then records it. True when the run has ended. */
  async function handle(ctx: Ctx, ev: SessionEvent): Promise<boolean> {
    if (typeof ev?.id !== "string" || typeof ev.type !== "string") return false;
    if (await seen(ctx, ev)) return false;
    const ended = await act(ctx, ev);
    await mark(ctx, ev);
    return ended;
  }

  /** Requests the run's interrupt (durable) and delivers it unless it is delivered already or its retry is not due. */
  async function interrupt(ctx: Ctx): Promise<void> {
    const [r] = await service(ctx.tenantId, (tx) => tx`update worker_runs set interrupt_sent_at = coalesce(interrupt_sent_at, ${new Date(now())})
      where id = ${ctx.run.id} returning interrupt_delivered_at, interrupt_next_at`);
    if (!r || r.interrupt_delivered_at !== null) return;
    if (r.interrupt_next_at !== null && (r.interrupt_next_at as Date).getTime() > now()) return;
    await deliverInterrupt(ctx.tenantId, ctx.run.id, ctx.sessionId);
  }

  /**
   * Sends one user.interrupt and records the outcome: delivered (also when the session no longer exists), or one more
   * failed attempt and the time of the next one. Never throws; the request stays until it is delivered.
   */
  async function deliverInterrupt(tenantId: string, runId: string, sessionId: string): Promise<boolean> {
    try {
      await api.sendEvents(sessionId, [{ type: "user.interrupt" }]);
    } catch (e) {
      const msg = (e as Error).message;
      if (!/404|not[ _]found/i.test(msg)) {
        console.error(`workers: interrupt of run ${runId} not delivered: ${msg}`);
        await service(tenantId, async (tx) => {
          const [u] = await tx`update worker_runs set interrupt_attempts = interrupt_attempts + 1 where id = ${runId} returning interrupt_attempts`;
          await tx`update worker_runs set interrupt_next_at = ${new Date(now() + interruptBackoffMs(Number(u?.interrupt_attempts ?? 1)))} where id = ${runId}`;
        });
        return false;
      }
    }
    await service(tenantId, (tx) => tx`update worker_runs set interrupt_delivered_at = ${new Date(now())}, interrupt_next_at = null
      where id = ${runId} and interrupt_delivered_at is null`);
    return true;
  }

  /** Delivers every requested, undelivered interrupt whose retry is due; re-attaches a consumer to unfinished runs. */
  async function deliverPending(tenantId: string): Promise<number> {
    const due = (await service(tenantId, (tx) => tx`select id, session_ref, ended_at from worker_runs
      where interrupt_sent_at is not null and interrupt_delivered_at is null and session_ref <> '' and session_deleted_at is null
        and (interrupt_next_at is null or interrupt_next_at <= ${new Date(now())}) order by id`)) as Array<{ id: string; session_ref: string; ended_at: Date | null }>;
    let n = 0;
    for (const r of due) {
      if (await deliverInterrupt(tenantId, r.id, r.session_ref)) n += 1;
      // If no consumer is attached (another process, a restart), attach one so the run ends as interrupted.
      if (r.ended_at === null && !consuming.has(r.id) && !opening.has(r.id)) void consume(tenantId, r.id);
    }
    return n;
  }

  async function act(ctx: Ctx, ev: SessionEvent): Promise<boolean> {
    if (ACTIONABLE.has(ev.type)) {
      // While an interrupt is requested (delivered or not), no event of the run is acted on.
      const stop = await service(ctx.tenantId, async (tx) => {
        const [r] = await tx`select interrupt_sent_at from worker_runs where id = ${ctx.run.id}`;
        if (r?.interrupt_sent_at) return "interrupted";
        if (await killedFor(tx, ctx.w, ctx.run.runnerPersonId)) return "kill";
        // The registry gate keeps holding while a session runs (workflow retired, identity left the job role).
        return (await eligible(tx, ctx.w)) ? null : "ineligible";
      });
      if (stop !== null) {
        await interrupt(ctx);
        return false;
      }
    }
    switch (ev.type) {
      case "agent.mcp_tool_use":
        return mcpToolUse(ctx, ev);
      case "agent.tool_use":
        return toolUse(ctx, ev);
      case "agent.custom_tool_use":
        await customToolUse(ctx, ev);
        return false;
      case "session.usage": {
        const cost = Number((ev as { list_cost?: { amount?: string } }).list_cost?.amount ?? NaN);
        if (Number.isInteger(cost) && cost >= 0) {
          await service(ctx.tenantId, (tx) => tx`update worker_runs set cost_cents = greatest(cost_cents, ${cost}) where id = ${ctx.run.id}`);
        }
        return false;
      }
      case "session.error": {
        const t = (ev as { error?: { type?: string } }).error?.type;
        if (typeof t === "string") await service(ctx.tenantId, (tx) => tx`update worker_runs set error_code = ${safeCode(t)} where id = ${ctx.run.id}`);
        return false;
      }
      case "session.status_idle": {
        const why = ev.stop_reason?.type;
        if (why === "requires_action") return false;
        if (why === "budget_reached") return finish(ctx.tenantId, ctx.run.id, "capped", "budget_reached", null);
        if (why === "end_turn") return finish(ctx.tenantId, ctx.run.id, null, "end_turn", null);
        return finish(ctx.tenantId, ctx.run.id, "failed", "error", safeCode(why ?? "unknown_stop"));
      }
      case "session.status_terminated":
      case "session.deleted":
        return finish(ctx.tenantId, ctx.run.id, "failed", "error", ev.type === "session.deleted" ? "session_deleted" : "terminated");
      default:
        return false;
    }
  }

  async function mcpToolUse(ctx: Ctx, ev: SessionEvent): Promise<boolean> {
    const server = String(ev.mcp_server_name ?? "");
    const tool = String(ev.name ?? "");
    const decision = confirmMcp(ctx.w.mcpServers, server, tool, (ev.input ?? {}) as Record<string, unknown>);
    const perm = ev.evaluated_permission;
    if (perm === undefined || perm === "ask") {
      await send(ctx, decision.result === "allow" ? { type: "user.tool_confirmation", tool_use_id: ev.id, result: "allow" } : { type: "user.tool_confirmation", tool_use_id: ev.id, result: "deny", deny_message: decision.deny_message });
      return false;
    }
    if (perm === "allow" && decision.result === "deny") {
      // The platform ran a tool we would have denied: configuration drift. Stop the session.
      await service(ctx.tenantId, (tx) => tx`update worker_runs set error_code = 'policy_drift' where id = ${ctx.run.id}`);
      await interrupt(ctx);
    }
    return false;
  }

  async function toolUse(ctx: Ctx, ev: SessionEvent): Promise<boolean> {
    if (ev.evaluated_permission !== undefined && ev.evaluated_permission !== "ask") return false;
    const name = String(ev.name ?? "");
    const allow = name === "bash" && ctx.bash;
    await send(
      ctx,
      allow
        ? { type: "user.tool_confirmation", tool_use_id: ev.id, result: "allow" }
        : {
            type: "user.tool_confirmation",
            tool_use_id: ev.id,
            result: "deny",
            deny_message: name === "bash" ? "Not allowed: bash is off for this workflow." : `Not allowed: ${name} needs no confirmation in a cloud run.`,
          },
    );
    return false;
  }

  async function customToolUse(ctx: Ctx, ev: SessionEvent): Promise<void> {
    const reply = (body: unknown, isError = false) =>
      send(ctx, { type: "user.custom_tool_result", custom_tool_use_id: ev.id, content: text(typeof body === "string" ? body : JSON.stringify(body)), ...(isError ? { is_error: true } : {}) });
    const input = (ev.input ?? {}) as Record<string, unknown>;
    switch (ev.name) {
      case "offload_propose_batch":
        return propose(ctx, input, reply);
      case "offload_report": {
        const summary = typeof input.summary === "string" ? input.summary.slice(0, 2000) : null;
        if (summary === null) return reply({ error: "validation_failed", message: "summary must be a string" }, true);
        await service(ctx.tenantId, (tx) => tx`update worker_runs set summary = ${summary} where id = ${ctx.run.id}`);
        // The run DTO (GET /v1/worker-runs/{id}) shows the summary; the digest schema has no field for it.
        return reply("Recorded with this run.");
      }
      case "offload_need_human": {
        const q = typeof input.question === "string" ? input.question.trim().slice(0, 500) : "";
        if (q === "") return reply({ error: "validation_failed", message: "question must be a non-empty string" }, true);
        // Stored with its time where the run DTO and the digest read it; only a stored question is promised to a person.
        const [stored] = await service(ctx.tenantId, (tx) => tx`update worker_runs set questions = questions || ${[q]}::jsonb,
              question_asked_at = question_asked_at || ${[now()]}::jsonb
            where id = ${ctx.run.id} and jsonb_array_length(questions) < 20 returning id`);
        if (!stored) {
          return reply({ error: "limit_reached", message: "This run already asked 20 questions; this one was not recorded. Continue with what you can do without the answer." }, true);
        }
        return reply("A person will see this question with this run and in their morning digest. Continue with what you can do without the answer.");
      }
      default:
        return reply(`There is no such tool: ${String(ev.name).slice(0, 64)}. Your tools are offload_propose_batch, offload_report and offload_need_human.`, true);
    }
  }

  async function propose(ctx: Ctx, input: Record<string, unknown>, reply: (b: unknown, e?: boolean) => Promise<void>): Promise<void> {
    const errors = localValidator().validate(PROPOSE_INPUT, input);
    if (errors) return reply({ error: "validation_failed", message: `items must be [{capability, fields: [[label, value], ...]}]: ${errors.slice(0, 3).join("; ")}` }, true);
    const w = ctx.w;
    if (!w.commitConnectionId) return reply({ error: "forbidden", message: "this workflow has no commit step, so nothing can be proposed" }, true);
    const raw = (input.items as Array<{ capability: string; fields: Array<[string, string]> }>);
    const items = raw.map((it) => ({ key: (it.fields.find(([l]) => l === "to")?.[1] ?? "").trim().toLowerCase(), capability: it.capability, fields: it.fields }));
    // Every value below comes from the run's trusted context, never from the model.
    const r = ctx.run;
    const run: ProposeRun = {
      runId: r.id,
      workflowId: w.workflowId,
      version: w.version,
      jobRoleId: w.jobRoleId,
      runtime: "cloud",
      identity: { type: w.identityType, id: w.identityId },
      runnerPersonId: r.runnerPersonId,
      connectionId: w.commitConnectionId,
      overnight: r.overnight,
      ...(r.overnightPolicyId ? { overnightPolicyId: r.overnightPolicyId } : {}),
      // Always a set (empty when nothing is trusted): a missing set would turn the broker's recipient check off.
      inputRecipients: r.inputRecipients,
      templateHash: w.templateHash,
    };
    const res = await broker().proposeBatch(ctx.tenantId, run, items);
    if (!res.ok) {
      if (res.tripped && r.overnightPolicyId) await recordTrip(ctx.tenantId, r.id, r.overnightPolicyId, res.tripped);
      return reply({ error: res.code, message: res.message }, true);
    }
    await service(ctx.tenantId, async (tx) => {
      await tx`insert into worker_run_batches (tenant_id, run_id, batch_hash, items, auto_approved, policy_id, at)
        values (current_setting('app.tenant_id')::uuid, ${r.id}, ${res.batchHash}, ${items.length}, ${res.autoApproved},
          ${res.overnightEvaluation?.policyId ?? null}, ${new Date(now())}) on conflict do nothing`;
    });
    if (res.overnightEvaluation?.result === "trip" && res.overnightEvaluation.reason) {
      await recordTrip(ctx.tenantId, r.id, res.overnightEvaluation.policyId, res.overnightEvaluation.reason);
    }
    return reply({ batchHash: res.batchHash, state: res.state });
  }

  async function recordTrip(tenantId: string, runId: string, policyId: string, reason: string): Promise<void> {
    await service(tenantId, (tx) => tx`insert into worker_run_trips (tenant_id, run_id, policy_id, reason, at)
      values (current_setting('app.tenant_id')::uuid, ${runId}, ${policyId}, ${reason.slice(0, 200)}, ${new Date(now())}) on conflict do nothing`);
  }

  // ---------- ending a run ----------

  async function cloudDevice(tx: Tx, personId: string): Promise<string> {
    // Two runs of one person can end at once: one device each, never two.
    await tx`select pg_advisory_xact_lock(hashtext(${"offload_cloud_device:" + personId}))`;
    const [d] = await tx`select device_id from worker_cloud_devices where person_id = ${personId}`;
    if (d) return d.device_id as string;
    // ADR 0112 §5: a revoked device with no usable key, so it can never authenticate.
    const [n] = await tx`insert into devices (tenant_id, person_id, name, app_version, public_key_jwk, enrolled_at, state, revoked_at)
      values (current_setting('app.tenant_id')::uuid, ${personId}, 'Offload cloud', 'cloud', ${{ kty: "none", use: "offload-cloud-runtime" }}::jsonb,
        ${new Date(now())}, 'revoked', ${new Date(now())}) returning id`;
    await tx`insert into worker_cloud_devices (tenant_id, person_id, device_id) values (current_setting('app.tenant_id')::uuid, ${personId}, ${n!.id})`;
    return n!.id as string;
  }

  async function emitOutcome(tx: Tx, r: RunRow, w: WorkerRow): Promise<void> {
    const outcome = outcomeOf(r.state);
    if (outcome === null || r.endedAt === null) return;
    const b = broker();
    const items = { total: 0, sent: 0, failedBeforeSend: 0, unknown: 0, pending: 0 };
    let first: string | null = null;
    let policy = false;
    for (const row of await tx`select batch_hash, auto_approved from worker_run_batches where run_id = ${r.id} order by at, batch_hash`) {
      const batch = await b.loadBatch(tx, row.batch_hash as string);
      if (!batch) continue;
      first ??= batch.hash;
      if (Number(row.auto_approved) > 0) policy = true;
      for (const it of (await b.dto(tx, batch, false)).items) {
        items.total += 1;
        if (it.state === "sent") items.sent += 1;
        else if (it.state === "failed_before_send") items.failedBeforeSend += 1;
        else if (it.state === "unknown") items.unknown += 1;
        else if (it.state === "pending" || it.state === "sending") items.pending += 1;
      }
    }
    const seq = r.outcomeSeq + 1;
    await tx`update worker_runs set outcome_seq = ${seq} where id = ${r.id}`;
    const object = {
      id: r.id,
      kind: "run_outcome",
      createdAt: now(),
      runId: r.id,
      workflowId: w.workflowId,
      version: w.version,
      runtime: "cloud",
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      outcome,
      items,
      batchHash: first,
      approverKind: policy ? "policy" : null,
      overnightPolicyId: r.overnightPolicyId,
      costCents: r.costCents,
      errorCode: r.errorCode,
      overnight: r.overnight,
    };
    const v = deps.validator.validate("offload/stage2/run-outcome.schema.json", object);
    if (!v.ok) throw new Error(`run outcome for ${r.id} breaks run-outcome.schema.json: ${v.errors.join("; ")}`);
    const deviceId = await cloudDevice(tx, r.runnerPersonId);
    const [p] = await tx`select access_role, dept_lead_of, jurisdiction from people where id = ${r.runnerPersonId}`;
    const principal: Principal = {
      kind: "device",
      tenantId: (await tx`select current_setting('app.tenant_id') as t`)[0]!.t as string,
      personId: r.runnerPersonId,
      deviceId,
      accessRole: p!.access_role as Principal["accessRole"],
      departmentScope: (p!.dept_lead_of as string[]) ?? [],
      jurisdiction: p!.jurisdiction as string,
    };
    // The S2-05 handler interface: the same code path a device's run outcome takes after ingest, as the runner's
    // (cloud) device, so the metrics tables' person check holds. The settings are put back after.
    const [prev] = await tx`select current_setting('app.principal_person_id', true) as p`;
    await tx`select set_config('app.sync_seq', ${String(seq)}, true), set_config('app.principal_person_id', ${r.runnerPersonId}, true)`;
    try {
      await metrics.syncHandlers!.run_outcome!(tx, object, { principal, deps });
    } finally {
      await tx`select set_config('app.principal_person_id', ${(prev?.p as string | null) ?? ""}, true)`;
    }
  }

  /** Ends a run (`state` null: done or waiting_approval by its batches). Always true (the run has ended). */
  async function finish(tenantId: string, runId: string, state: RunState | null, stopReason: StopReason, errorCode: string | null): Promise<boolean> {
    const pre = await service(tenantId, (tx) => loadRun(tx, runId));
    if (!pre || pre.endedAt !== null) return true;
    let cost: number | null = null;
    if (pre.sessionRef !== "") {
      try {
        const amount = Number((await api.retrieveSession(pre.sessionRef)).usage?.list_cost?.amount ?? NaN);
        if (Number.isInteger(amount) && amount >= 0) cost = amount;
      } catch {
        // cost stays what session.usage reported
      }
    }
    const after = await service(tenantId, async (tx) => {
      // The runner's lock first (emitOutcome's cloud device takes it too), then rows: one lock order, no deadlock.
      await tx`select pg_advisory_xact_lock(hashtext(${"offload_cloud_device:" + pre.runnerPersonId}))`;
      const r = await loadRun(tx, runId, true);
      if (!r || r.endedAt !== null) return null;
      const w = (await loadWorker(tx, r.workerId, true))!;
      let final: RunState = state ?? "done";
      if (state === null) {
        if (r.interruptSentAt !== null) final = "interrupted";
        else {
          const b = broker();
          for (const row of await tx`select batch_hash from worker_run_batches where run_id = ${runId}`) {
            const batch = await b.loadBatch(tx, row.batch_hash as string);
            if (batch?.state === "pending") final = "waiting_approval";
          }
        }
      }
      if (final === "failed" && r.interruptSentAt !== null) final = "interrupted";
      // Ended here because we lost the session, not because it stopped: it may still be running, so its interrupt is
      // requested with the end and delivered (and retried) by the sweep, and its budget stays reserved until the
      // session is confirmed stopped and its final cost read (settleLost).
      const stopIt = r.sessionRef !== "" && errorCode !== null && ERRORS_SESSION_MAY_RUN.has(errorCode);
      const [u] = await tx`update worker_runs set state = ${final}, stop_reason = ${stopReason}, ended_at = ${new Date(now())},
          error_code = coalesce(${errorCode}, error_code), cost_cents = greatest(cost_cents, ${cost ?? 0}), session_unsettled = ${stopIt},
          interrupt_sent_at = case when ${stopIt} then coalesce(interrupt_sent_at, ${new Date(now())}) else interrupt_sent_at end
        where id = ${runId} returning *`;
      const ended = runRow(u!);
      let paused = false;
      if (ended.trigger === "schedule") paused = await countResult(tx, w, final !== "failed");
      await emitOutcome(tx, ended, w);
      await audit(tx, {
        actor: SERVICE,
        action: "worker.run_end",
        subjectPersonId: ended.runnerPersonId,
        resource: { type: "worker_run", id: runId },
        detail: { workerId: w.id, state: final, stopReason, costCents: ended.costCents, errorCode: ended.errorCode },
      });
      return { ended, w, paused };
    });
    if (!after) return true;
    const { ended, w, paused } = after;
    if (ended.overnightPolicyId) await reportPolicy(tenantId, ended.id, ended.overnightPolicyId, ended.state !== "failed", ended.costCents);
    if (paused) await syncWorker(tenantId, w.id, false);
    return true;
  }

  /**
   * An ended run's result to its overnight policy, then `policy_reported_at` (act, then mark: a crash in between
   * reports it twice, which can only trip the breaker early, never hide a failure). Recovery reports what is left.
   */
  async function reportPolicy(tenantId: string, runId: string, policyId: string, ok: boolean, costCents: number): Promise<void> {
    try {
      const b = broker();
      const trip = await b.reportRunResult(tenantId, policyId, ok);
      if (trip) await recordTrip(tenantId, runId, policyId, trip);
      if (costCents > 0) {
        const t2 = await b.reportNightSignals(tenantId, policyId, { costCents });
        if (t2) await recordTrip(tenantId, runId, policyId, t2);
      }
      await service(tenantId, async (tx) => {
        // The cost this report counted; a cost that grew meanwhile (a settle) is added now, in this transaction.
        await tx`update worker_runs set policy_reported_at = ${new Date(now())}, policy_cost_cents = ${costCents} where id = ${runId}`;
        await addPolicyCostDelta(tx, runId);
      });
    } catch (e) {
      console.error(`workers: reporting run ${runId} to its overnight policy: ${(e as Error).message}`);
    }
  }

  /**
   * Adds the cost a run gained after its overnight-policy report to that policy's night counter, and moves the run's
   * mark (`policy_cost_cents`) in the same transaction: each cent is counted exactly once, also across a crash. The
   * counter row is the one `reportNightSignals` keeps (the night the run ended, in the tenant's timezone); that cost
   * path evaluates no breaker, and the broker port cannot join this transaction.
   */
  async function addPolicyCostDelta(tx: Tx, runId: string): Promise<void> {
    const [r] = await tx`select overnight_policy_id, policy_reported_at, policy_cost_cents, cost_cents, ended_at from worker_runs
      where id = ${runId} for update`;
    if (!r || r.overnight_policy_id === null || r.policy_reported_at === null || r.policy_cost_cents === null || r.ended_at === null) return;
    const delta = Number(r.cost_cents) - Number(r.policy_cost_cents);
    if (delta <= 0) return;
    const [t] = await tx`select reporting_timezone from tenants where id = current_setting('app.tenant_id')::uuid`;
    const tz0 = (t?.reporting_timezone as string | undefined) ?? "UTC";
    const night = nightOf((r.ended_at as Date).getTime(), isTimezone(tz0) ? tz0 : "UTC");
    await tx`insert into overnight_counters (tenant_id, policy_id, night, dry_run, evaluated)
      values (current_setting('app.tenant_id')::uuid, ${r.overnight_policy_id}, ${night}::date, false, false) on conflict do nothing`;
    await tx`update overnight_counters set budget_cents = budget_cents + ${delta} where policy_id = ${r.overnight_policy_id} and night = ${night}::date`;
    await tx`update worker_runs set policy_cost_cents = cost_cents where id = ${runId}`;
  }

  /** Consecutive failures of scheduled runs (ADR 0105 §5): two in a row pause the worker and its deployment. */
  async function countResult(tx: Tx, w: WorkerRow, ok: boolean): Promise<boolean> {
    if (ok) {
      await tx`update workers set consecutive_failures = 0 where id = ${w.id}`;
      return false;
    }
    const [u] = await tx`update workers set consecutive_failures = consecutive_failures + 1 where id = ${w.id} returning consecutive_failures, state`;
    const failures = Number(u!.consecutive_failures);
    if (failures < FAILURES_TO_PAUSE || u!.state !== "ready") return false;
    await tx`update workers set state = 'paused', paused_reason = 'consecutive_failures', updated_at = ${new Date(now())} where id = ${w.id}`;
    await tx`update deployments set desired_status = 'paused', updated_at = ${new Date(now())} where worker_id = ${w.id} and desired_status = 'active'`;
    await audit(tx, { actor: SERVICE, action: "worker.auto_pause", resource: { type: "worker", id: w.id }, detail: { reason: "consecutive_failures", failures } });
    return true;
  }

  // ---------- deployments: the platform's scheduled runs ----------

  async function pollDeployments(tenantId: string): Promise<void> {
    // Every deployment Offload made that is not drained: the current one and replaced or removed ones, so a session
    // an old deployment started just before it was archived is still imported, accounted, swept and recovered.
    const deps0 = await service(tenantId, async (tx) =>
      (await tx`select worker_id, deployment_id, last_run_seen_at, budget_cents, archived_at from remote_deployments
        where drained_at is null order by deployment_id`) as Array<{ worker_id: string; deployment_id: string; last_run_seen_at: string | null; budget_cents: number; archived_at: Date | null }>,
    );
    for (const d of deps0) {
      const listedAt = now();
      // created_at[gte] the newest created_at seen (the field the filter compares): a run created in that same instant
      // but listed later is not skipped; one already imported is skipped by its deployment_run_ref below.
      const runs = (await api.listDeploymentRuns(d.deployment_id, d.last_run_seen_at ?? undefined)).sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const dr of runs) {
        const started = await service(tenantId, async (tx) => {
          const [dup] = await tx`select id from worker_runs where deployment_run_ref = ${dr.id}`;
          const failed = Boolean(dr.error) || !dr.session_id;
          const w0 = await loadWorker(tx, d.worker_id);
          // Lock order (step 9): the tenant's admission lock (a started session is checked against the monthly cap
          // and reserved), the runner's cloud-device lock (emitOutcome takes it), the worker row, then its deployment;
          // audit last.
          if (w0 && !dup && !failed) await lockBudget(tx);
          if (w0 && !dup && failed) {
            await tx`select pg_advisory_xact_lock(hashtext(${"offload_cloud_device:" + (w0.identityType === "person" ? w0.identityId : w0.ownerPersonId)}))`;
          }
          const w = w0 ? await loadWorker(tx, d.worker_id, true) : null;
          await tx`update remote_deployments set last_run_seen_at = greatest(coalesce(last_run_seen_at, ''), ${dr.created_at}) where deployment_id = ${d.deployment_id}`;
          if (dup || !w) return null;
          if (dr.error || !dr.session_id) {
            const run = await insertRun(tx, w, { trigger: "schedule", runnerPersonId: w.ownerPersonId, inputs: null, deploymentRunRef: dr.id, deploymentId: d.deployment_id, budgetCents: Number(d.budget_cents), startedAt: dr.created_at, state: "failed", errorCode: safeCode(dr.error?.type ?? "no_session") });
            const paused = await countResult(tx, w, false);
            await emitOutcome(tx, run, w);
            await audit(tx, { actor: SERVICE, action: "worker.run_end", subjectPersonId: run.runnerPersonId, resource: { type: "worker_run", id: run.id }, detail: { workerId: w.id, state: "failed", errorCode: run.errorCode } });
            return { run, paused, attach: false, policy: run.overnightPolicyId };
          }
          // The session runs with the deployment's budget: that is what it reserves.
          const run = await insertRun(tx, w, { trigger: "schedule", runnerPersonId: w.ownerPersonId, inputs: null, deploymentRunRef: dr.id, deploymentId: d.deployment_id, budgetCents: Number(d.budget_cents), startedAt: dr.created_at, sessionRef: dr.session_id });
          await tx`insert into session_cursors (tenant_id, session_id, run_id) values (current_setting('app.tenant_id')::uuid, ${dr.session_id}, ${run.id}) on conflict do nothing`;
          await audit(tx, { actor: SERVICE, action: "worker.run_start", subjectPersonId: run.runnerPersonId, resource: { type: "worker_run", id: run.id }, detail: { workerId: w.id, trigger: "schedule", deploymentRun: dr.id } });
          // The platform already created this session: it passes a manual run's gates or it is stopped at once. The
          // stop is requested with the run (durable), delivered below and retried by the sweep; a budget or
          // eligibility refusal also holds the deployment paused so it fires no more paid sessions.
          const refusal = await scheduledRefusal(tx, w, run.runnerPersonId, run);
          if (refusal) {
            await tx`update worker_runs set error_code = ${refusal}, interrupt_sent_at = ${new Date(now())} where id = ${run.id}`;
            if (refusal === "budget_exceeded" || refusal === "ineligible") {
              await tx`update deployments set hold_reason = ${refusal}, updated_at = ${new Date(now())} where worker_id = ${w.id}`;
            }
          }
          return { run, paused: false, attach: true, refused: refusal !== null, policy: run.overnightPolicyId };
        });
        if (!started) continue;
        if (started.paused) await syncWorker(tenantId, d.worker_id, false);
        if (!started.attach) {
          if (started.policy) await reportPolicy(tenantId, started.run.id, started.policy, false, 0);
          continue;
        }
        if ("refused" in started && started.refused) {
          await deliverInterrupt(tenantId, started.run.id, started.run.sessionRef);
          await syncWorker(tenantId, d.worker_id, false);
        }
        void consume(tenantId, started.run.id);
      }
      // Drain: a deployment archived before this listing started fires no more; once every session it started has
      // been imported (above) and has ended, it is drained and no longer polled.
      if (d.archived_at !== null && d.archived_at.getTime() <= listedAt) {
        await service(tenantId, (tx) => tx`update remote_deployments set polled_after_archive_at = coalesce(polled_after_archive_at, ${new Date(listedAt)}),
            drained_at = case when not exists (select 1 from worker_runs r where r.deployment_id = ${d.deployment_id} and r.ended_at is null)
              then ${new Date(now())}::timestamptz else null end
          where deployment_id = ${d.deployment_id} and drained_at is null`);
      }
    }
  }

  // ---------- kill switches ----------

  async function interruptRuns(tenantId: string, pick: (tx: Tx, r: RunRow, w: WorkerRow) => Promise<boolean>): Promise<number> {
    const targets = await service(tenantId, async (tx) => {
      const out: RunRow[] = [];
      // Lock order: the runs in id order, before any other row (finish locks its run before its worker). A run whose
      // session is not recorded yet is requested too: openSession then delivers the interrupt, not the first message.
      for (const row of await tx`select * from worker_runs where state = 'running' and ended_at is null and interrupt_sent_at is null
          order by id for update`) {
        const r = runRow(row);
        const w = (await loadWorker(tx, r.workerId))!;
        if (await pick(tx, r, w)) out.push(r);
      }
      // Requested, not sent: delivery is confirmed separately (deliverPending), so a failed send is retried.
      for (const r of out) await tx`update worker_runs set interrupt_sent_at = ${new Date(now())} where id = ${r.id}`;
      return out;
    });
    await deliverPending(tenantId);
    return targets.length;
  }

  async function pauseDeploymentsWhere(tenantId: string, pick: (tx: Tx, w: WorkerRow) => Promise<boolean>, reason: string): Promise<void> {
    const ids = await service(tenantId, async (tx) => {
      const out: string[] = [];
      const paused: string[] = [];
      // Every row lock (workers, then deployments) before the first audit write, which takes the tenant's audit-chain
      // lock: one lock order with `finish`, which also locks its worker and deployment before auditing.
      const rows = await tx`select w.* from workers w join deployments d on d.tenant_id = w.tenant_id and d.worker_id = w.id
          where d.desired_status = 'active' or d.remote_status = 'active' order by w.id for update of w`;
      for (const row of rows) {
        const w = workerRow(row);
        if (!(await pick(tx, w))) continue;
        await tx`update deployments set desired_status = case when desired_status = 'archived' then desired_status else 'paused' end, updated_at = ${new Date(now())} where worker_id = ${w.id}`;
        if (w.state === "ready") {
          await tx`update workers set state = 'paused', paused_reason = ${reason}, updated_at = ${new Date(now())} where id = ${w.id}`;
          paused.push(w.id);
        }
        out.push(w.id);
      }
      for (const id of paused) await audit(tx, { actor: SERVICE, action: "worker.pause", resource: { type: "worker", id }, detail: { reason } });
      return out;
    });
    for (const id of ids) await syncWorker(tenantId, id, false);
  }

  async function sweep(tenantId: string): Promise<void> {
    // interruptRuns requests the new ones and delivers every due request (kill switch, person stopped, budget, lost).
    // A running session also stops when its worker is no longer eligible (the registry gate of startRun).
    await interruptRuns(tenantId, async (tx, r, w) => (await killedFor(tx, w, r.runnerPersonId)) || !(await eligible(tx, w)));
    await settleLost(tenantId);
    await pauseDeploymentsWhere(tenantId, (tx, w) => killedFor(tx, w, w.identityType === "person" ? w.identityId : w.ownerPersonId), "kill_switch");
    await refreshHolds(tenantId);
  }

  /**
   * Runs that ended because we lost their session keep their whole budget reserved (monthSpent) until the session is
   * confirmed stopped: terminated, gone, or idle after its interrupt was delivered. Then its final cost replaces the
   * reservation. Until then every sweep and recovery checks again.
   */
  async function settleLost(tenantId: string): Promise<void> {
    const due = (await service(tenantId, (tx) => tx`select id, session_ref, interrupt_delivered_at from worker_runs
      where session_unsettled and ended_at is not null order by id limit 200`)) as Array<{ id: string; session_ref: string; interrupt_delivered_at: Date | null }>;
    for (const r of due) {
      let cost: number | null = null;
      try {
        const s = await api.retrieveSession(r.session_ref);
        const stopped = s.status === "terminated" || (s.status === "idle" && r.interrupt_delivered_at !== null);
        if (!stopped) continue;
        const amount = Number(s.usage?.list_cost?.amount ?? NaN);
        if (Number.isInteger(amount) && amount >= 0) cost = amount;
      } catch (e) {
        const msg = (e as Error).message;
        if (!/404|not[ _]found/i.test(msg)) {
          console.error(`workers: settling run ${r.id}: ${msg}`);
          continue;
        }
        // The session no longer exists: it is stopped; the cost stays the last one observed.
      }
      // One transaction: the final cost, the run's outcome again (metrics keep the latest seq per run) and the cost
      // its overnight policy has not counted yet. Lock order as in finish: the runner's lock, then the run.
      await service(tenantId, async (tx) => {
        const [p] = await tx`select runner_person_id from worker_runs where id = ${r.id}`;
        if (!p) return;
        await tx`select pg_advisory_xact_lock(hashtext(${"offload_cloud_device:" + (p.runner_person_id as string)}))`;
        const run = await loadRun(tx, r.id, true);
        if (!run || !run.sessionUnsettled) return;
        const [u] = await tx`update worker_runs set session_unsettled = false, cost_cents = greatest(cost_cents, ${cost ?? 0})
          where id = ${r.id} returning *`;
        const settled = runRow(u!);
        if (settled.costCents !== run.costCents) await emitOutcome(tx, settled, (await loadWorker(tx, settled.workerId))!);
        await addPolicyCostDelta(tx, r.id);
      });
    }
  }

  async function interruptAll(tenantId: string, scope: { tenant: true } | { personId: string } | { workflowId: string }): Promise<number> {
    const match = (r: RunRow, w: WorkerRow) =>
      "tenant" in scope ? true : "personId" in scope ? r.runnerPersonId === scope.personId || (w.identityType === "person" && w.identityId === scope.personId) : w.workflowId === scope.workflowId;
    return interruptRuns(tenantId, async (_tx, r, w) => match(r, w));
  }

  // ---------- restart recovery ----------

  async function recover(tenantId: string): Promise<void> {
    const cutoff = new Date(now() - SESSION_RECORD_TIMEOUT_MS);
    const open = (await service(tenantId, (tx) => tx`select id, session_ref, started_at from worker_runs where ended_at is null order by id`)) as Array<{ id: string; session_ref: string; started_at: Date }>;
    for (const r of open) {
      if (opening.has(r.id)) continue;
      if (r.session_ref === "") {
        // The session id was never recorded (a crash between create and record, or create never ran): any such
        // session never got its first message, so it is idle; the run ends and its reserved budget is released.
        if (r.started_at < cutoff) await finish(tenantId, r.id, "failed", "error", "session_not_recorded");
        continue;
      }
      if (!consuming.has(r.id) && !opening.has(r.id)) void consume(tenantId, r.id);
    }
    await deliverPending(tenantId);
    await settleLost(tenantId);
    const unreported =(await service(tenantId, (tx) => tx`select id, overnight_policy_id, state, cost_cents from worker_runs
      where ended_at is not null and overnight_policy_id is not null and policy_reported_at is null order by id limit 200`)) as Array<{ id: string; overnight_policy_id: string; state: string; cost_cents: string | number }>;
    for (const r of unreported) await reportPolicy(tenantId, r.id, r.overnight_policy_id, r.state !== "failed", Number(r.cost_cents));
  }

  // ---------- retention ----------

  async function retention(tenantId: string): Promise<number> {
    const cutoff = new Date(now() - retentionDays * DAY_MS);
    const due = await service(tenantId, (tx) => tx`select id, session_ref from worker_runs
      where ended_at is not null and ended_at < ${cutoff} and session_deleted_at is null and session_ref <> '' order by ended_at limit 500`);
    let n = 0;
    for (const r of due as Array<{ id: string; session_ref: string }>) {
      try {
        await api.deleteSession(r.session_ref);
      } catch (e) {
        if (!/404|not found/i.test((e as Error).message)) {
          console.error(`workers: deleting session of run ${r.id}: ${(e as Error).message}`);
          continue;
        }
      }
      await service(tenantId, async (tx) => {
        // A deleted session is stopped: nothing is left to settle.
        await tx`update worker_runs set session_deleted_at = ${new Date(now())}, session_unsettled = false where id = ${r.id}`;
        await tx`delete from session_cursors where session_id = ${r.session_ref}`;
      });
      n += 1;
    }
    if (n > 0) await service(tenantId, (tx) => audit(tx, { actor: SERVICE, action: "worker.retention", resource: { type: "tenant", id: tenantId }, detail: { sessionsDeleted: n, olderThanDays: retentionDays } }));
    return n;
  }

  return {
    isFullWorkers: true,
    configure(o) {
      if (o.api) api = o.api;
      if (o.credentials !== undefined) credentials = o.credentials;
      if (o.retentionDays !== undefined) {
        if (!Number.isInteger(o.retentionDays) || o.retentionDays < 1 || o.retentionDays > SESSION_RETENTION_DAYS) throw new Error("retentionDays must be 1..30");
        retentionDays = o.retentionDays;
      }
    },
    async pauseFor(tx, personId) {
      const ids = await pauseWorkersOf(tx, personId, now(), "person_stopped");
      const [t] = await tx`select current_setting('app.tenant_id') as t`;
      const tenantId = t!.t as string;
      // After the caller's transaction: interrupt the person's sessions and pause their deployments remotely. This
      // runs in its own transactions and is safe to repeat; the kill sweep job covers anything it misses.
      setTimeout(() => {
        void track(
          (async () => {
            await interruptAll(tenantId, { personId });
            await pauseDeploymentsWhere(tenantId, async (_tx, w) => w.ownerPersonId === personId || (w.identityType === "person" && w.identityId === personId), "person_stopped");
          })(),
        );
      }, 0);
      return ids.length;
    },
    reconcile,
    dispatchReconcile(tenantId, workerId) {
      setTimeout(() => void track(reconcile(tenantId, workerId)), 0);
    },
    startRun,
    dispatchRun,
    async startRunUnchecked(tenantId, workerId, o) {
      const run = await service(tenantId, async (tx) => {
        await lockBudget(tx);
        return insertRun(tx, (await loadWorker(tx, workerId))!, o);
      });
      const w = await service(tenantId, async (tx) => (await loadWorker(tx, workerId))!);
      void track(openSession(tenantId, run.id, runMessage({ runId: run.id, workflow: w.workflowId, inputs: o.inputs, scheduled: false })));
      return run.id;
    },
    async resume(tenantId, runId) {
      void consume(tenantId, runId);
      await Promise.resolve();
    },
    pollDeployments,
    sweep,
    interruptAll,
    retention,
    recover,
    lockBudget,
    async lockWorkerSync(tx, workerId) {
      await tx`select pg_advisory_xact_lock(hashtext(${"offload_worker_sync:" + workerId}))`;
    },
    monthSpent,
    async idle() {
      // Quiescent: nothing scheduled or running, and every consumer is waiting for its next event (a few ticks in a
      // row, so an event already on its way is handled first).
      let calm = 0;
      for (let i = 0; i < 5000 && calm < 4; i++) {
        await new Promise((r) => setTimeout(r, 2));
        calm = inflight.size === 0 && busy === 0 ? calm + 1 : 0;
      }
    },
    shutdown() {
      for (const ac of consuming.values()) ac.abort();
    },
  };
}

export function templateHashOf(skillMd: string): string {
  return sha256Hex(skillMd);
}

export function scheduleOrThrow(s: { cron: string; timezone: string } | null | undefined): void {
  if (!s) return;
  const p = scheduleProblem(s.cron, s.timezone);
  if (p) throw invalid(p);
}

export function uuidOrNotFound(id: string | undefined): string {
  if (!id || !isUuid(id)) throw notFound();
  return id;
}

export type { ErrorCode };
