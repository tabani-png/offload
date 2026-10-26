import type { ModuleDef } from "../../app.ts";
import { createRegistryPort } from "./port.ts";
import { registryRoutes } from "./routes.ts";
import { ingestProposal } from "./sync.ts";

const registryPort = createRegistryPort();

/** Workflow registry (SPEC S2-06, ADR 0104): proposals, immutable versions, promotion to a job role, SOP export. */
const registry: ModuleDef = {
  name: "registry",
  routes(app, deps) {
    registryRoutes(app, deps);
  },
  syncHandlers: { workflow_proposal: ingestProposal },
  provides: { registry: registryPort },
};

export default registry;
