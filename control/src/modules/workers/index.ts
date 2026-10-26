/**
 * S2-09 cloud workers (ADR 0105, ADR 0106 §4-7, ADR 0112): Managed Agents provisioning, sessions and their event
 * streams, custom tools to the commit broker, cron deployments, the kill-switch sweep, session retention and the
 * morning digest. Provides `WorkersPort`; the full orchestrator (`Workers`) is the same object once routes are
 * mounted, reached by other modules and tests with `workersOf(deps.ports)`.
 */
import type { Deps, Job, ModuleDef } from "../../app.ts";
import type { WorkersPort } from "../../ports.ts";
import { digestRoutes } from "./digest.ts";
import { createWorkers, pauseWorkersOf, workersOf, type Workers } from "./orchestrator.ts";
import { workerRoutes } from "./routes.ts";

export { workersOf, createWorkers } from "./orchestrator.ts";
export type { Workers, CredentialSource } from "./orchestrator.ts";
export { digestText, buildDigest } from "./digest.ts";

/** Until routes are mounted: pausing works in the caller's transaction; nothing reaches Managed Agents. */
const unbound: WorkersPort = {
  pauseFor: async (tx, personId) => (await pauseWorkersOf(tx, personId, Date.now(), "person_stopped")).length,
};

/** Jobs run once per tenant (ModuleDef contract); the tenant comes as a second argument, as in compliance. */
const job = (name: string, schedule: string, fn: (w: Workers, tenantId: string) => Promise<unknown>): Job & { run(deps: Deps, tenantId?: string): Promise<void> } => ({
  name,
  schedule,
  async run(deps: Deps, tenantId?: string) {
    if (!tenantId) throw new Error(`${name} runs once per tenant: pass the tenant id`);
    await fn(workersOf(deps.ports), tenantId);
  },
});

const workers: ModuleDef = {
  name: "workers",
  provides: { workers: unbound },
  routes(app, deps) {
    const full = createWorkers(deps);
    if (deps.ports.workers === unbound) deps.ports.workers = full;
    const get = () => (deps.ports.workers === full ? full : workersOf(deps.ports));
    workerRoutes(app, deps, get);
    digestRoutes(app, deps);
  },
  jobs: [
    job("workers.reconcile", "*/5 * * * *", (w, t) => w.reconcile(t)),
    job("workers.poll_deployments", "* * * * *", (w, t) => w.pollDeployments(t)),
    job("workers.kill_sweep", "* * * * *", (w, t) => w.sweep(t)),
    // Restart recovery: its first tick after a start re-attaches every unfinished session (also run by reconcile).
    job("workers.recover", "* * * * *", (w, t) => w.recover(t)),
    job("workers.session_retention", "40 4 * * *", (w, t) => w.retention(t)),
  ],
};

export default workers;
