/**
 * S2-07 commit broker module: batches, approvals, the item journal, kill switches (ADR 0105 §3, ADR 0106 §4).
 * Provides `BrokerPort`. The frozen port (ports.ts) names only `revokeTokensOf` and `killSwitchActive`; the full broker
 * (`proposeBatch`, `approve`, `commitApproved`, `revokeTokensFor`, `stopRunsFor`, ...) is the same object, bound to
 * the app's deps when routes are mounted, and reached by other modules with `brokerOf(deps.ports)`.
 */
import type { ModuleDef } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import type { BrokerPort } from "../../ports.ts";
import { createBroker, type Broker } from "./broker.ts";
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

const broker: ModuleDef = {
  name: "broker",
  provides: { broker: unbound },
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
