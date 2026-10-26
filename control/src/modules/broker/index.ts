/**
 * S2-07 commit broker module: batches, approvals, the item journal, kill switches (ADR 0105 §3, ADR 0106 §4).
 * Provides `BrokerPort`. The frozen port (ports.ts) names only `revokeTokensOf` and `killSwitchActive`; the full broker
 * (`proposeBatch`, `approve`, `commitApproved`, `revokeTokensFor`, `stopRunsFor`, ...) is the same object, bound to
 * the app's deps when routes are mounted, and reached by other modules with `brokerOf(deps.ports)`.
 */
import type { Deps, Job, ModuleDef } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import type { BrokerPort } from "../../ports.ts";
import { brokerOf, createBroker, type Broker } from "./broker.ts";
import { batchRoutes, killRoutes } from "./routes.ts";

export { brokerOf, createBroker } from "./broker.ts";
export type { Broker, ProposeRun, ProposeResult, CommitSummary } from "./broker.ts";
export { ApiExecutor, ComposioCliExecutor, McpExecutor } from "./executors.ts";

/** Until routes are mounted (no deps yet): kill-switch reads work, revocation is refused rather than silently skipped. */
const unbound: BrokerPort = {
  async killSwitchActive(tx: Tx, target) {
    if (target.personId === undefined && target.workflowId === undefined) return true;
    const [r] = await tx`select 1 from kill_switches where active and (scope = 'tenant'
        or (scope = 'person' and target_id = ${target.personId ?? null}::uuid)
        or (scope = 'workflow' and target_id = ${target.workflowId ?? null}::uuid)) limit 1`;
    return r !== undefined;
  },
  async revokeTokensOf() {
    throw new Error("broker: not bound to the app yet");
  },
};

/**
 * Every minute, per tenant: `sending` rows the broker stopped during become `unknown` (never retried), then approved
 * items whose send-window time has come run. The core has no scheduler yet; whatever runs `jobs` (S2-12 / ops) runs it
 * once per tenant. `Job.run(deps)` carries no tenant, so the tenant is a second argument; without one the job refuses.
 */
export const commitDueJob: Job & { run(deps: Deps, tenantId?: string): Promise<void> } = {
  name: "broker.commit_due",
  schedule: "* * * * *",
  async run(deps: Deps, tenantId?: string) {
    if (!tenantId) throw new Error("broker.commit_due runs once per tenant: pass the tenant id");
    const b = brokerOf(deps.ports);
    await b.reconcile(tenantId);
    await b.runDue(tenantId);
  },
};

const broker: ModuleDef = {
  name: "broker",
  provides: { broker: unbound },
  jobs: [commitDueJob],
  routes(app, deps) {
    let full: Broker | null = null;
    const get = () => (full ??= createBroker(deps));
    // Bind the full broker in place of the placeholder; a test's or another wiring's explicit override wins.
    if (deps.ports.broker === unbound) deps.ports.broker = get();
    batchRoutes(app, deps, get);
    killRoutes(app, deps, get);
  },
};

export default broker;
