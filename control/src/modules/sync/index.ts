import type { ModuleDef, Principal } from "../../app.ts";
import { principalOf, reply, tenantTx } from "../../app.ts";
import { forbidden } from "../../schema/http.ts";
import { deviceConfig } from "./config.ts";
import { ingest } from "./ingest.ts";

/**
 * Ingest (ADR 0103 server side): POST /v1/sync/batches and GET /v1/sync/config. Objects are dispatched to the
 * `syncHandlers` of the module that owns their kind (metrics owns the five metric kinds; registry and compliance
 * register workflow_proposal and notice_ack).
 */
const sync: ModuleDef = {
  name: "sync",
  routes(app, deps) {
    app.post("/v1/sync/batches", async (c) => reply(c, deps, 200, await ingest(c, deps), "offload/stage2/sync-receipt.schema.json"));

    app.get("/v1/sync/config", async (c) => {
      if (principalOf(c).kind !== "device") throw forbidden();
      const out = await tenantTx(c, deps, (tx, p) => deviceConfig(tx, deps, p as Extract<Principal, { kind: "device" }>));
      return reply(c, deps, 200, out, "offload/stage2/device-config.schema.json");
    });
  },
};

export default sync;
