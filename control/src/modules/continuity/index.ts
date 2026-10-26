/**
 * S2-10 continuity module (ADR 0107): the offboarding state machine, freeze, hand-overs, successors, role identities
 * as successors, the personal-LinkedIn rule on exit. Provides `ContinuityPort` (replacing the S2-01 default). The
 * frozen port (ports.ts) names only `freeze`; the rest (`runAs`, `checkRun`, `sweep`, ...) is the same object, bound to
 * the app's deps when routes are mounted, and reached by other modules with `continuityOf(deps.ports)`.
 *
 * When routes are mounted it also gates the two places a run is decided (ADR 0113 §1), through their public ports:
 * `registry.isRunnableBy` is false while a frozen/departed person's hand-over of the workflow is not ready, and
 * `broker.proposeBatch` refuses (`forbidden`, audited) a run as or by a frozen/departed person or of a held workflow.
 */
import type { Deps, Job, ModuleDef } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { withTenant } from "../../db/tenant.ts";
import type { ContinuityPort, Ports } from "../../ports.ts";
import type { Broker, ProposeResult } from "../broker/broker.ts";
import type { RegistryApi } from "../registry/port.ts";
import { checkable, createContinuity, type Continuity } from "./continuity.ts";
import { continuityRoutes } from "./routes.ts";

export type { Continuity, HandoverDto, RunIdentity, RunCheck, Refusal, SweepResult } from "./continuity.ts";
export { IllegalTransition, transition, canTransition } from "./states.ts";

export function continuityOf(ports: { continuity: ContinuityPort }): Continuity {
  const c = ports.continuity as Partial<Continuity>;
  if (c.isContinuity !== true) throw new Error("the S2-10 continuity module is not loaded");
  return c as Continuity;
}

/** Until routes are mounted (no deps yet): refuse rather than half-freeze. */
const unbound: ContinuityPort = {
  async freeze() {
    throw new Error("continuity: not bound to the app yet");
  },
};

/** `registry.isRunnableBy` with the hand-over hold in front of it; every other member is the registry's own. */
function gateRegistry(ports: Ports, c: Continuity): void {
  const reg = ports.registry as Partial<RegistryApi>;
  if (typeof reg.isRunnableBy !== "function") return;
  const base = reg.isRunnableBy;
  ports.registry = {
    ...reg,
    workflowsOf: ports.registry.workflowsOf,
    async isRunnableBy(tx: Tx, workflowId: string, version: number, runner) {
      if ((await c.held(tx, workflowId)) !== null) return false;
      return base(tx, workflowId, version, runner);
    },
  } as RegistryApi;
}

/** `broker.proposeBatch` with the continuity check in front of it (its own transaction, so the refusal's audit stays). */
function gateBroker(deps: Deps, c: Continuity): void {
  const b = deps.ports.broker as Partial<Broker>;
  if (b.isFullBroker !== true || typeof b.proposeBatch !== "function") return;
  const full = b as Broker;
  const proposeBatch: Broker["proposeBatch"] = async (tenantId, run, items): Promise<ProposeResult> => {
    if (checkable(run)) {
      const refusal = await withTenant(deps.db, { tenantId, accessRole: "system" }, (tx) => c.checkRun(tx, run));
      if (refusal) return { ok: false, code: refusal.code, message: refusal.message, tripped: null };
    }
    return full.proposeBatch(tenantId, run, items);
  };
  // Copies property descriptors, not values, so the broker's getters (`lockRetries`) stay live.
  const gated = Object.create(Object.getPrototypeOf(full), {
    ...Object.getOwnPropertyDescriptors(full),
    proposeBatch: { value: proposeBatch, enumerable: true, writable: true, configurable: true },
  }) as Broker;
  deps.ports.broker = gated;
}

export const sweepJob: Job & { run(deps: Deps, tenantId?: string): Promise<void> } = {
  name: "continuity.sweep",
  schedule: "*/15 * * * *",
  async run(deps: Deps, tenantId?: string) {
    if (!tenantId) throw new Error("continuity.sweep runs once per tenant: pass the tenant id");
    await continuityOf(deps.ports).sweep(tenantId);
  },
};

const continuity: ModuleDef = {
  name: "continuity",
  provides: { continuity: unbound },
  jobs: [sweepJob],
  routes(app, deps) {
    let full: Continuity | null = null;
    // Bind in place of the placeholder; a test's or another wiring's explicit override wins.
    if (deps.ports.continuity === unbound) {
      full = createContinuity(deps);
      deps.ports.continuity = full;
      gateRegistry(deps.ports, full);
      gateBroker(deps, full);
    }
    continuityRoutes(app, deps, () => full ?? continuityOf(deps.ports));
  },
};

export default continuity;
