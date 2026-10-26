/**
 * The RBAC matrix of plan/stage-2/API.md, as data (ADR 0102 §5). Every endpoint of every Stage 2 slice is listed here
 * once; later slices implement handlers but never edit this file. Columns: owner, admin, dept_lead, member, auditor,
 * device. Cells: "T" whole tenant, "Dp" own departments only, "S" self only, "F:x" only when sensitive feature x is
 * enabled (combinable with a scope: "Dp+F:x", "S+F:x"; a bare "F:x" has tenant scope), "-" denied.
 * Conditions finer than a cell (e.g. "admin cannot set owner") are in `note` and enforced by the handler.
 */

export type AccessRole = "owner" | "admin" | "dept_lead" | "member" | "auditor" | "service";
export type Column = "owner" | "admin" | "dept_lead" | "member" | "auditor" | "device";
export type SensitiveFeature = "per_person_views" | "working_time";
export type Scope = "T" | "Dp" | "S";
export type Cell = string;
/** How the caller proves who it is. Only `principal` rows are gated by role; the others carry their own credential. */
export type AuthKind = "principal" | "enrollment_code" | "device_key" | "webhook_signature" | "digest_link";

export interface Permission {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Distinguishes rows that share a path by the `scope` query parameter (`person:<id>` vs anything else). */
  variant?: "scope=person" | "scope=group";
  auth: AuthKind;
  roles: Record<Column, Cell>;
  note?: string;
}

export const COLUMNS: readonly Column[] = ["owner", "admin", "dept_lead", "member", "auditor", "device"];

const NONE: Record<Column, Cell> = { owner: "-", admin: "-", dept_lead: "-", member: "-", auditor: "-", device: "-" };

function row(
  method: Permission["method"],
  path: string,
  cells: [Cell, Cell, Cell, Cell, Cell, Cell],
  extra: Partial<Pick<Permission, "variant" | "note">> = {},
): Permission {
  const [owner, admin, dept_lead, member, auditor, device] = cells;
  return { method, path, auth: "principal", roles: { owner, admin, dept_lead, member, auditor, device }, ...extra };
}

function credential(method: Permission["method"], path: string, auth: AuthKind, note: string): Permission {
  return { method, path, auth, roles: NONE, note };
}

const PPV = "F:per_person_views";
const WT = "F:working_time";

export const PERMISSIONS: readonly Permission[] = [
  // Auth, devices, sync
  row("GET", "/auth/session", ["S", "S", "S", "S", "S", "-"]),
  row("POST", "/v1/devices/enrollment-codes", ["S", "S", "S", "S", "-", "-"]),
  credential("POST", "/v1/devices/enroll", "enrollment_code", "the one-time enrollment code is the credential"),
  credential("POST", "/v1/devices/challenge", "device_key", "nonce for a registered, active device"),
  credential("POST", "/v1/devices/token", "device_key", "ES256 signature over the nonce with the device key"),
  row("GET", "/v1/devices", ["T", "T", "-", "S", "-", "-"]),
  row("DELETE", "/v1/devices/:id", ["T", "T", "-", "S", "-", "-"]),
  row("GET", "/v1/sync/config", ["-", "-", "-", "-", "-", "S"]),
  row("POST", "/v1/sync/batches", ["-", "-", "-", "-", "-", "S"]),

  // Self-view
  row("GET", "/v1/me/data", ["S", "S", "S", "S", "S", "-"]),
  row("GET", "/v1/me/access-log", ["S", "S", "S", "S", "S", "-"]),
  row("POST", "/v1/me/notices/:id/ack", ["S", "S", "S", "S", "S", "-"]),
  row("GET", "/v1/me/export", ["S", "S", "S", "S", "S", "-"]),
  row("POST", "/v1/me/correction-requests", ["S", "S", "S", "S", "S", "-"]),
  row("GET", "/v1/me/digest", ["S", "S", "S", "S", "-", "-"]),
  row("POST", "/v1/me/baselines/:workflowId/:version/estimate", ["S", "S", "S", "S", "-", "-"]),

  // Org
  row("GET", "/v1/tenant", ["T", "T", "T", "T", "T", "-"]),
  row("PATCH", "/v1/tenant", ["T", "T", "-", "-", "-", "-"], {
    note: "admin: not identityAddon, not monthlyWorkerBudgetCents; groupFloor upward only; retention downward only",
  }),
  row("GET", "/v1/departments", ["T", "T", "T", "T", "T", "-"]),
  row("POST", "/v1/departments", ["T", "T", "-", "-", "-", "-"]),
  row("PATCH", "/v1/departments/:id", ["T", "T", "-", "-", "-", "-"]),
  row("DELETE", "/v1/departments/:id", ["T", "T", "-", "-", "-", "-"]),
  row("GET", "/v1/people", ["T", "T", "Dp", "-", "T", "-"]),
  row("GET", "/v1/people/:id", ["T", "T", "Dp", "S", "T", "-"]),
  row("PATCH", "/v1/people/:id", ["T", "T", "-", "-", "-", "-"], {
    note: "owner role only set or removed by owner; last owner 409",
  }),
  row("POST", "/v1/people/invite", ["T", "T", "-", "-", "-", "-"]),
  row("GET", "/v1/job-roles", ["T", "T", "Dp", "T", "T", "-"], { note: "member and auditor: read" }),
  row("POST", "/v1/job-roles", ["T", "T", "Dp", "-", "-", "-"], { note: "dept_lead: own departments" }),
  row("PATCH", "/v1/job-roles/:id", ["T", "T", "Dp", "-", "-", "-"], { note: "dept_lead: own departments" }),
  row("GET", "/v1/role-identities", ["T", "T", "Dp", "-", "T", "-"], { note: "dept_lead and auditor: read" }),
  row("POST", "/v1/role-identities", ["T", "T", "-", "-", "-", "-"]),
  row("PATCH", "/v1/role-identities/:id", ["T", "T", "-", "-", "-", "-"]),
  row("DELETE", "/v1/role-identities/:id", ["T", "T", "-", "-", "-", "-"]),
  row("POST", "/v1/support-grants", ["T", "-", "-", "-", "-", "-"], { note: "hours <= 72" }),
  credential("POST", "/webhooks/workos", "webhook_signature", "WorkOS-Signature HMAC with the webhook secret"),

  // Connections and policies
  row("GET", "/v1/connections", ["T", "T", "Dp", "S", "T", "-"]),
  row("POST", "/v1/connections", ["T", "T", "-", "S", "-", "-"], { note: "member: personal-allowed only" }),
  row("PATCH", "/v1/connections/:id", ["T", "T", "-", "S", "-", "-"], {
    note: "member: label only; linkedin_personal can never become company",
  }),
  row("DELETE", "/v1/connections/:id", ["T", "T", "-", "S", "-", "-"]),
  row("GET", "/v1/policies/job-roles/:id", ["T", "T", "Dp", "S", "T", "-"], { note: "member: own job roles" }),
  row("PUT", "/v1/policies/job-roles/:id", ["T", "T", "Dp", "-", "-", "-"]),
  row("GET", "/v1/overnight-policies", ["T", "T", "Dp", "S", "T", "-"]),
  row("POST", "/v1/overnight-policies", ["T", "T", "Dp", "S", "-", "-"], {
    note: "dept_lead: role identities; member: own runs; mode preapproved needs templateHash",
  }),
  row("PATCH", "/v1/overnight-policies/:id", ["T", "T", "Dp", "S", "-", "-"], {
    note: "dept_lead: role identities; member: own runs",
  }),

  // Workflow registry
  row("GET", "/v1/workflows", ["T", "T", "Dp", "S", "T", "-"], {
    note: "member: role workflows of my job roles + my proposals",
  }),
  row("GET", "/v1/workflows/:id", ["T", "T", "Dp", "S", "T", "-"], { note: "member: as list" }),
  row("GET", "/v1/workflows/:id/versions/:v", ["T", "T", "Dp", "S", "T", "-"], { note: "member: as list" }),
  row("POST", "/v1/workflows/:id/promote", ["T", "T", "Dp", "-", "-", "-"], { note: "dept_lead: target department" }),
  row("POST", "/v1/workflows/:id/decline", ["T", "T", "Dp", "-", "-", "-"]),
  row("POST", "/v1/workflows/:id/versions", ["T", "T", "Dp", "-", "-", "-"]),
  row("POST", "/v1/workflows/:id/retire", ["T", "T", "Dp", "-", "-", "-"]),
  row("GET", "/v1/workflows/:id/versions/:v/sop", ["T", "T", "Dp", "S", "T", "-"], { note: "member: as list" }),

  // Batches, approvals, kill switch (broker)
  row("GET", "/v1/batches", ["S", "S", "Dp", "S", "-", "-"], { note: "owner/admin: only where the role policy names them" }),
  row("GET", "/v1/batches/:hash", ["T", "T", "Dp", "S", "-", "-"], {
    note: "item fields only for the runner and approvers; owner/admin see no fields unless approvers",
  }),
  row("POST", "/v1/batches/:hash/approve", ["S", "S", "Dp", "S", "-", "-"], { note: "role-policy approvers only" }),
  row("POST", "/v1/batches/:hash/reject", ["S", "S", "Dp", "S", "-", "-"], { note: "approvers only" }),
  row("POST", "/v1/batches/:hash/release", ["S", "S", "Dp", "S", "-", "-"], { note: "approvers only" }),
  row("GET", "/v1/kill-switches", ["T", "T", "Dp", "S", "T", "-"]),
  row("POST", "/v1/kill-switches", ["T", "T", "Dp", "S", "-", "-"], {
    note: "dept_lead: workflow or person in dept; member: own person, own workflows",
  }),
  row("DELETE", "/v1/kill-switches/:scope/:targetId", ["T", "T", "Dp", "S", "-", "-"], {
    note: "admin: not tenant scope set by owner; member: own, if set by self",
  }),
  credential("POST", "/v1/digest-links/:token", "digest_link", "signed single-purpose link (HMAC, 24 h, one use)"),

  // Cloud workers
  row("GET", "/v1/workers", ["T", "T", "Dp", "S", "T", "-"], { note: "member: workers of my job roles" }),
  row("POST", "/v1/workers", ["T", "T", "Dp", "-", "-", "-"]),
  row("PATCH", "/v1/workers/:id", ["T", "T", "Dp", "-", "-", "-"], { note: "cron in 01:00-03:59 local is 400" }),
  row("POST", "/v1/workers/:id/pause", ["T", "T", "Dp", "-", "-", "-"]),
  row("POST", "/v1/workers/:id/resume", ["T", "T", "Dp", "-", "-", "-"]),
  row("POST", "/v1/workers/:id/retire", ["T", "T", "Dp", "-", "-", "-"]),
  row("POST", "/v1/workers/:id/runs", ["T", "T", "Dp", "S", "-", "-"], { note: "member: job role holders" }),
  row("GET", "/v1/workers/:id/runs", ["T", "T", "Dp", "S", "T", "-"], { note: "member: job role holders" }),
  row("GET", "/v1/worker-runs/:id", ["T", "T", "Dp", "S", "T", "-"], { note: "member: job role holders" }),

  // Metrics
  row("GET", "/v1/metrics/hours-saved", ["T", "T", "Dp", "-", "T", "-"], { variant: "scope=group" }),
  row("GET", "/v1/metrics/hours-saved", [PPV, PPV, `Dp+${PPV}`, "S", "-", "-"], {
    variant: "scope=person",
    note: "member: self always",
  }),
  row("GET", "/v1/metrics/hours-saved/evidence", ["T", "T", "Dp", "S", "T", "-"], {
    note: "runs of people outside scope are counted, not listed",
  }),
  row("GET", "/v1/metrics/adoption", ["T", "T", "Dp", "-", "T", "-"]),
  row("GET", "/v1/metrics/working-time", [WT, WT, `Dp+${WT}`, "-", "-", "-"], { variant: "scope=group" }),
  row("GET", "/v1/metrics/working-time", [`${WT}+${PPV}`, `${WT}+${PPV}`, `Dp+${WT}+${PPV}`, `S+${WT}`, "-", "-"], {
    variant: "scope=person",
  }),

  // Continuity
  row("POST", "/v1/people/:id/offboard", ["T", "T", "-", "-", "-", "-"]),
  row("GET", "/v1/handovers", ["T", "T", "Dp", "-", "T", "-"]),
  row("POST", "/v1/handovers/:id/assign", ["T", "T", "Dp", "-", "-", "-"], {
    note: "successor must hold the job role and accept",
  }),
  row("POST", "/v1/handovers/:id/accept", ["S", "S", "S", "S", "-", "-"], { note: "named successor" }),
  row("POST", "/v1/handovers/:id/close", ["T", "T", "Dp", "-", "-", "-"]),

  // Compliance
  row("GET", "/v1/compliance/features", ["T", "T", "T", "T", "T", "-"]),
  row("POST", "/v1/compliance/features/:feature/enable", ["T", "-", "-", "-", "-", "-"], {
    note: "with DPIA attestation",
  }),
  row("POST", "/v1/compliance/features/:feature/disable", ["T", "T", "-", "-", "-", "-"]),
  row("GET", "/v1/compliance/notices", ["T", "T", "T", "T", "T", "-"]),
  row("POST", "/v1/compliance/notices", ["T", "T", "-", "-", "-", "-"]),
  row("POST", "/v1/compliance/notices/:id/publish", ["T", "T", "-", "-", "-", "-"]),
  row("GET", "/v1/compliance/notices/:id/acks", ["T", "T", "Dp", "-", "T", "-"]),
  row("GET", "/v1/compliance/templates", ["T", "T", "-", "-", "T", "-"]),
  row("GET", "/v1/audit-log", ["T", "T", "-", "-", "T", "-"]),
  row("GET", "/v1/audit-log/verify", ["T", "-", "-", "-", "T", "-"]),
];

export function permissionKey(p: Pick<Permission, "method" | "path" | "variant">): string {
  return `${p.method} ${p.path}${p.variant ? ` [${p.variant}]` : ""}`;
}

export const PERMISSION_BY_KEY: ReadonlyMap<string, Permission> = new Map(PERMISSIONS.map((p) => [permissionKey(p), p]));

export function permission(key: string): Permission {
  const p = PERMISSION_BY_KEY.get(key);
  if (!p) throw new Error(`no permission row ${key}`);
  return p;
}

/** Splits a cell into its scope and the sensitive features it needs. `null` scope means denied. */
export function parseCell(cell: Cell): { scope: Scope | null; features: SensitiveFeature[] } {
  if (cell === "-") return { scope: null, features: [] };
  let scope: Scope = "T";
  const features: SensitiveFeature[] = [];
  for (const part of cell.split("+")) {
    if (part === "T" || part === "Dp" || part === "S") scope = part;
    else if (part === `F:per_person_views`) features.push("per_person_views");
    else if (part === `F:working_time`) features.push("working_time");
    else throw new Error(`bad cell ${cell}`);
  }
  return { scope, features };
}

function segments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

/** Finds the matrix row for a request. Static segments beat parameters; a `person:` scope selects the person row. */
export function matchPermission(
  method: string,
  pathname: string,
  query: URLSearchParams,
): { perm: Permission; params: Record<string, string> } | null {
  const segs = segments(pathname);
  let best: { perm: Permission; params: Record<string, string>; statics: number } | null = null;
  for (const perm of PERMISSIONS) {
    if (perm.method !== method) continue;
    if (perm.variant) {
      const isPerson = (query.get("scope") ?? "").startsWith("person:");
      if ((perm.variant === "scope=person") !== isPerson) continue;
    }
    const ps = segments(perm.path);
    if (ps.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let statics = 0;
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p.startsWith(":")) {
        try {
          params[p.slice(1)] = decodeURIComponent(segs[i]!);
        } catch {
          return null; // malformed escape: no route
        }
      }
      else if (p === segs[i]) statics++;
      else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || statics > best.statics)) best = { perm, params, statics };
  }
  return best ? { perm: best.perm, params: best.params } : null;
}

export interface AuthzPrincipal {
  /** An access role for a person (web session) or "device" for a device token. */
  column: Column | "service";
  personId: string | null;
  departmentScope: readonly string[];
}

export interface AuthzResource {
  personId?: string | null;
  departmentId?: string | null;
  departmentIds?: readonly string[];
}

export type Decision =
  | { allow: true; scope: Scope }
  | { allow: false; status: 403 | 404; code: "forbidden" | "feature_disabled" | "not_found" };

/**
 * authorize(principal, action, resource, features) (ADR 0102 §5). Deny is the default.
 * - `resource` null: a collection; the caller filters rows by the returned scope.
 * - `features`: sensitive features enabled for the subject's jurisdiction.
 * Out-of-scope resources are 404 so existence is not revealed.
 */
export function authorize(
  principal: AuthzPrincipal,
  action: Permission | string,
  resource: AuthzResource | null,
  features: ReadonlySet<SensitiveFeature>,
): Decision {
  const perm = typeof action === "string" ? PERMISSION_BY_KEY.get(action) : action;
  if (!perm || perm.auth !== "principal" || principal.column === "service") {
    return { allow: false, status: 403, code: "forbidden" };
  }
  const { scope, features: needs } = parseCell(perm.roles[principal.column]);
  if (scope === null) return { allow: false, status: 403, code: "forbidden" };
  if (needs.some((f) => !features.has(f))) return { allow: false, status: 403, code: "feature_disabled" };
  if (resource === null || scope === "T") return { allow: true, scope };
  if (scope === "S") {
    return principal.personId !== null && resource.personId === principal.personId
      ? { allow: true, scope }
      : { allow: false, status: 404, code: "not_found" };
  }
  const depts = [
    ...(resource.departmentId ? [resource.departmentId] : []),
    ...(resource.departmentIds ?? []),
  ];
  return depts.some((d) => principal.departmentScope.includes(d))
    ? { allow: true, scope }
    : { allow: false, status: 404, code: "not_found" };
}
