import type { App, Deps } from "../app.ts";
import type { Tx } from "../db/pool.ts";
import { withLookup, withTenant } from "../db/tenant.ts";
import { invalid, unauthorized } from "../schema/http.ts";
import { verifyWebhook } from "./webhook.ts";

interface DirectoryUser {
  id: string;
  directory_id?: string;
  emails?: Array<{ primary?: boolean; value?: string }>;
  email?: string;
  first_name?: string | null;
  last_name?: string | null;
  state?: string;
  role?: { slug?: string } | null;
  custom_attributes?: Record<string, unknown> | null;
}

interface DirectoryGroup {
  id: string;
  name?: string;
}

/** IdP roles we accept. `owner` is never granted from the IdP (ADR 0102 §6); it is set in-app by an owner. */
const IDP_ROLES = new Set(["admin", "dept_lead", "member", "auditor"]);
const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const SYSTEM = { type: "system" as const, id: null, accessRole: null };

function primaryEmail(u: DirectoryUser): string | null {
  const e = u.emails?.find((x) => x.primary)?.value ?? u.emails?.[0]?.value ?? u.email;
  return typeof e === "string" && e.includes("@") ? e.slice(0, 254) : null;
}

function displayName(u: DirectoryUser, email: string): string {
  const n = [u.first_name, u.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
  return (n || email).slice(0, 120);
}

async function upsertUser(tx: Tx, deps: Deps, u: DirectoryUser, deleted: boolean): Promise<void> {
  const email = primaryEmail(u);
  const [existing] = await tx`select id, access_role, state from people
    where directory_user_id = ${u.id} or (directory_user_id is null and ${email}::text is not null and lower(email) = lower(${email}))
    order by (directory_user_id is null) limit 1`;
  const idpRole = u.role?.slug && IDP_ROLES.has(u.role.slug) ? u.role.slug : null;
  const j = u.custom_attributes?.jurisdiction;
  const jurisdiction = typeof j === "string" && JURISDICTION.test(j) ? j : null;
  let personId: string;
  if (existing) {
    personId = existing.id;
    // An owner keeps owner whatever the IdP says; nobody becomes owner from the IdP.
    const role = existing.access_role === "owner" ? "owner" : (idpRole ?? existing.access_role);
    await tx`update people set directory_user_id = ${u.id}, access_role = ${role},
        email = coalesce(${email}, email), display_name = coalesce(${email ? displayName(u, email) : null}, display_name),
        jurisdiction = coalesce(${jurisdiction}, jurisdiction)
      where id = ${personId}`;
  } else {
    if (!email || deleted) return;
    const [p] = await tx`insert into people (tenant_id, email, display_name, access_role, jurisdiction, source,
        directory_user_id)
      values (current_setting('app.tenant_id')::uuid, ${email}, ${displayName(u, email)}, ${idpRole ?? "member"},
        ${jurisdiction ?? "ZZ"}, 'directory', ${u.id})
      returning id`;
    personId = p!.id;
  }
  const inactive = deleted || (u.state !== undefined && u.state !== "active");
  const [now] = await tx`select state from people where id = ${personId}`;
  if (inactive && now && (now.state === "active" || now.state === "leaving")) {
    await deps.ports.continuity.freeze(tx, personId, { source: "directory", detail: deleted ? "deleted" : "inactive" });
  }
  // After the freeze: writing an audit event takes the tenant's audit-chain lock, which stays last (lock order,
  // modules/broker/broker.ts); the freeze takes row locks through the broker.
  await deps.ports.audit.write(tx, {
    actor: SYSTEM,
    action: "person.directory_sync",
    subjectPersonId: personId,
    resource: { type: "person", id: personId },
    detail: { directoryUserId: u.id, state: u.state ?? null, deleted },
  });
}

async function groupMembership(tx: Tx, deps: Deps, u: DirectoryUser, g: DirectoryGroup, added: boolean): Promise<void> {
  const [person] = await tx`select id, department_id from people where directory_user_id = ${u.id}`;
  if (!person) return;
  // By the IdP's group id only: a name is whatever an IdP admin types, so it could impersonate a mapped group.
  const [m] = await tx`select department_id from department_group_mappings where directory_group = ${g.id}`;
  if (!m) return;
  if (added) {
    await tx`update people set department_id = ${m.department_id} where id = ${person.id}`;
  } else if (person.department_id === m.department_id) {
    await tx`update people set department_id = null where id = ${person.id}`;
  } else return;
  await deps.ports.audit.write(tx, {
    actor: SYSTEM,
    action: "person.directory_sync",
    subjectPersonId: person.id,
    resource: { type: "person", id: person.id },
    detail: { group: g.id, departmentId: m.department_id, added },
  });
}

/** `POST /webhooks/workos`: Directory Sync events (ADR 0102 §6-7). The signature is the only credential. */
export function directoryRoutes(app: App, deps: Deps): void {
  app.post("/webhooks/workos", async (c) => {
    const raw = await c.req.text();
    const now = deps.clock.now();
    if (!(await verifyWebhook(deps.config.workos.webhookSecret, c.req.header("WorkOS-Signature"), raw, now))) {
      throw unauthorized("bad webhook signature");
    }
    let evt: { id: string; event: string; data: Record<string, unknown> };
    try {
      evt = JSON.parse(raw);
    } catch {
      throw invalid("body is not valid JSON");
    }
    const v = deps.validator.validate("offload/control/workos-event.json", evt);
    if (!v.ok) throw invalid("not a WorkOS event", v.errors);
    if (!evt.event.startsWith("dsync.")) return c.body(null, 204);

    const data = evt.data;
    const user = (evt.event.startsWith("dsync.group.") ? data.user : data) as DirectoryUser | undefined;
    const directoryId = (data.directory_id ?? user?.directory_id) as string | undefined;
    if (typeof directoryId !== "string" || !user || typeof user.id !== "string") return c.body(null, 204);
    const tenantId = await withLookup(deps.db, "lookup_workos_directory", directoryId, async (tx) => {
      const [t] = await tx`select id from tenants where workos_directory_id = ${directoryId}`;
      return t?.id as string | undefined;
    });
    if (!tenantId) return c.body(null, 204);

    await withTenant(deps.db, { tenantId, accessRole: "system" }, async (tx) => {
      // WorkOS redelivers until it sees a 2xx: each event id is applied once (in this transaction, so a failed
      // attempt leaves no mark and the retry still applies).
      const [fresh] = await tx`insert into directory_events (tenant_id, event_id, received_at)
        values (${tenantId}, ${evt.id}, ${new Date(now)}) on conflict do nothing returning event_id`;
      if (!fresh) return;
      switch (evt.event) {
        case "dsync.user.created":
        case "dsync.user.updated":
          return upsertUser(tx, deps, user, false);
        case "dsync.user.deleted":
          return upsertUser(tx, deps, user, true);
        case "dsync.group.user_added":
        case "dsync.group.user_removed": {
          const g = data.group as DirectoryGroup | undefined;
          if (g && typeof g.id === "string") await groupMembership(tx, deps, user, g, evt.event.endsWith("added"));
          return;
        }
      }
    });
    return c.body(null, 204);
  });
}
