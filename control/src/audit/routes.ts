import type { App, Deps } from "../app.ts";
import { reply, tenantTx } from "../app.ts";
import { isUuid } from "../db/tenant.ts";
import { invalid, page, pageParams } from "../schema/http.ts";
import { listAudit, verifyChain } from "./audit.ts";

function tsParam(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw invalid(`${name} must be epoch ms`);
  return n;
}

/** `GET /v1/audit-log` and `/verify` (ADR 0108 §5). Readers: owner, admin, auditor (verify: owner, auditor). */
export function auditRoutes(app: App, deps: Deps): void {
  app.get("/v1/audit-log", async (c) => {
    const { limit, cursor } = pageParams(c);
    const action = c.req.query("action");
    if (action !== undefined && !/^[a-z_]+\.[a-z_]+$/.test(action)) throw invalid("bad action");
    const subject = c.req.query("subjectPersonId");
    if (subject !== undefined && !isUuid(subject)) throw invalid("subjectPersonId must be a uuid");
    const afterSeq = typeof cursor?.seq === "number" ? cursor.seq : 0;
    const out = await tenantTx(c, deps, async (tx) => {
      const r = await listAudit(tx, {
        ...(action ? { action } : {}),
        ...(subject ? { subjectPersonId: subject } : {}),
        ...(c.req.query("from") !== undefined ? { from: tsParam(c.req.query("from"), "from")! } : {}),
        ...(c.req.query("to") !== undefined ? { to: tsParam(c.req.query("to"), "to")! } : {}),
        afterSeq,
        limit: limit + 1,
      });
      const seqs = r.seqs;
      const p = page(r.events, limit, () => ({ seq: seqs[limit - 1] ?? 0 }));
      return p;
    });
    return reply(c, deps, 200, out, "offload/control/audit-event-list.json");
  });

  app.get("/v1/audit-log/verify", async (c) => {
    const out = await tenantTx(c, deps, (tx) => verifyChain(tx));
    return reply(c, deps, 200, out, "offload/control/audit-verify.json");
  });
}
