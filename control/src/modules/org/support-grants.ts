import type { App, Deps } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";

/** `POST /v1/support-grants`: a time-boxed, owner-approved support access grant (ADR 0102 §8). */
export function supportGrantRoutes(app: App, deps: Deps): void {
  app.post("/v1/support-grants", async (c) => {
    const req = await body<{ hours: number; readOnly?: boolean }>(c, deps, "offload/control/support-grant-request.json");
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      const readOnly = req.readOnly ?? true;
      const expiresAt = now + req.hours * 3600_000;
      const [g] = await tx`insert into support_grants (tenant_id, granted_by, hours, read_only, created_at, expires_at)
        values (current_setting('app.tenant_id')::uuid, ${p.personId}, ${req.hours}, ${readOnly}, ${new Date(now)},
          ${new Date(expiresAt)})
        returning id`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "support_grant.create",
        resource: { type: "support_grant", id: g!.id },
        detail: { hours: req.hours, readOnly },
      });
      return { id: g!.id as string, hours: req.hours, readOnly, createdAt: now, expiresAt };
    });
    return reply(c, deps, 201, out, "offload/control/support-grant.json");
  });
}
