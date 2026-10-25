/**
 * The control plane app (SPEC S2-01). Written once by S2-01: later slices add `src/modules/<name>/index.ts`
 * exporting a `ModuleDef` (default export or `module`) and never edit this file. No module is imported by name.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Config } from "./config.ts";
import type { Db, Tx } from "./db/pool.ts";
import { withTenant } from "./db/tenant.ts";
import { defaultPorts, type Clock, type Ports } from "./ports.ts";
import { createValidator, type Validator } from "./schema/registry.ts";
import { ERROR_SCHEMA, HttpError, errorBody, forbidden, notFound, readBody, send, unauthorized } from "./schema/http.ts";
import { matchPermission, parseCell, type AccessRole, type Permission, type Scope } from "./rbac/permissions.ts";
import type { SigningKey } from "./auth/jwt.ts";
import type { WorkOSIdentity } from "./auth/workos.ts";
import { authenticate } from "./auth/principal.ts";
import { authRoutes } from "./auth/routes.ts";
import { deviceRoutes } from "./auth/devices.ts";
import { directoryRoutes } from "./auth/directory.ts";
import { auditRoutes } from "./audit/routes.ts";
import type { AuditInput } from "./audit/audit.ts";
import { safeEqual } from "./schema/encoding.ts";

export type PersonRole = Exclude<AccessRole, "service">;

export type Principal =
  | {
      kind: "person";
      tenantId: string;
      personId: string;
      accessRole: PersonRole;
      departmentScope: string[];
      jurisdiction: string;
      sessionId: string;
      csrfToken: string;
    }
  | {
      kind: "device";
      tenantId: string;
      personId: string;
      deviceId: string;
      accessRole: PersonRole;
      departmentScope: string[];
      jurisdiction: string;
    };

export interface AppEnv {
  Variables: {
    principal: Principal | null;
    perm: Permission | null;
    scope: Scope | null;
  };
}

export type App = Hono<AppEnv>;

export interface Deps {
  db: Db;
  config: Config;
  clock: Clock;
  validator: Validator;
  workos: WorkOSIdentity;
  deviceKey: SigningKey;
  ports: Ports;
}

export type SyncHandler = (tx: Tx, object: unknown, ctx: { principal: Principal; deps: Deps }) => Promise<void>;

export interface Job {
  name: string;
  /** Cron expression in UTC; the scheduler runs `run` once per tenant per tick. */
  schedule: string;
  run(deps: Deps): Promise<void>;
}

export interface ModuleDef {
  name: string;
  routes(app: App, deps: Deps): void;
  syncHandlers?: Record<string, SyncHandler>;
  jobs?: Job[];
  provides?: Partial<Ports>;
}

export const MODULES_DIR = join(import.meta.dir, "modules");

/** Imports every `<dir>/<name>/index.ts` in name order. */
export async function loadModules(dir = MODULES_DIR): Promise<ModuleDef[]> {
  if (!existsSync(dir)) return [];
  const mods: ModuleDef[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const file = join(dir, name, "index.ts");
    if (!existsSync(file)) continue;
    const m = (await import(file)) as { default?: ModuleDef; module?: ModuleDef };
    const def = m.default ?? m.module;
    if (!def || typeof def.routes !== "function" || typeof def.name !== "string") {
      throw new Error(`modules/${name}/index.ts must export a ModuleDef`);
    }
    mods.push(def);
  }
  return mods;
}

/** Defaults, overridden port by port by modules. Two modules providing the same port is a startup error. */
export function resolvePorts(clock: Clock, mods: ModuleDef[]): Ports {
  const ports = defaultPorts(clock);
  const by = new Map<string, string>();
  for (const m of mods) {
    for (const [k, v] of Object.entries(m.provides ?? {})) {
      if (v === undefined) continue;
      const prior = by.get(k);
      if (prior) throw new Error(`port ${k} provided by both ${prior} and ${m.name}`);
      by.set(k, m.name);
      (ports as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return ports;
}

export interface CreateAppOpts {
  db: Db;
  config: Config;
  workos: WorkOSIdentity;
  deviceKey: SigningKey;
  clock?: Clock;
  validator?: Validator;
  modulesDir?: string;
  /** Extra port overrides, applied after modules (tests use this for spies). */
  ports?: Partial<Ports>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Routes outside the RBAC matrix: the browser login round trip. */
const PUBLIC = new Set(["GET /auth/login", "GET /auth/callback", "POST /auth/logout"]);

export async function createApp(opts: CreateAppOpts) {
  const clock = opts.clock ?? { now: () => Date.now() };
  const modules = await loadModules(opts.modulesDir);
  const ports = { ...resolvePorts(clock, modules), ...opts.ports };
  const deps: Deps = {
    db: opts.db,
    config: opts.config,
    clock,
    validator: opts.validator ?? createValidator(),
    workos: opts.workos,
    deviceKey: opts.deviceKey,
    ports,
  };
  const app: App = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return send(c, deps.validator, deps.config.validateResponses, err.status, errorBody(err.code, err.message, err.details), ERROR_SCHEMA);
    }
    console.error(err);
    return c.json(errorBody("server_error", "server error"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "not found"), 404));

  // The gate: every request is matched against the RBAC matrix before any handler runs. Deny by default.
  app.use("*", async (c, next) => {
    c.set("principal", null);
    c.set("perm", null);
    c.set("scope", null);
    const url = new URL(c.req.url);
    if (PUBLIC.has(`${c.req.method} ${url.pathname}`)) return next();
    const m = matchPermission(c.req.method, url.pathname, url.searchParams);
    if (!m) throw notFound();
    c.set("perm", m.perm);
    if (m.perm.auth !== "principal") return next();
    const principal = await authenticate(c, deps);
    if (!principal) throw unauthorized();
    const column = principal.kind === "device" ? "device" : principal.accessRole;
    const { scope } = parseCell(m.perm.roles[column]);
    if (scope === null) throw forbidden(`${column} may not ${m.perm.method} ${m.perm.path}`);
    if (principal.kind === "person" && MUTATING.has(c.req.method)) {
      const token = c.req.header("X-CSRF-Token") ?? "";
      if (!safeEqual(token, principal.csrfToken)) throw forbidden("missing or wrong X-CSRF-Token");
    }
    c.set("principal", principal);
    c.set("scope", scope);
    return next();
  });

  authRoutes(app, deps);
  deviceRoutes(app, deps);
  directoryRoutes(app, deps);
  auditRoutes(app, deps);
  for (const m of modules) m.routes(app, deps);

  return { app, deps, modules };
}

// Helpers for handlers (core and modules).

export function principalOf(c: Context<AppEnv>): Principal {
  const p = c.get("principal");
  if (!p) throw unauthorized();
  return p;
}

/** Runs `fn` in the principal's tenant transaction (ADR 0101 §4). */
export function tenantTx<T>(c: Context<AppEnv>, deps: Deps, fn: (tx: Tx, p: Principal) => Promise<T>): Promise<T> {
  const p = principalOf(c);
  return withTenant(
    deps.db,
    {
      tenantId: p.tenantId,
      principalId: p.kind === "device" ? p.deviceId : p.personId,
      principalPersonId: p.personId,
      accessRole: p.accessRole,
    },
    (tx) => fn(tx, p),
  );
}

export function actorOf(p: Principal): AuditInput["actor"] {
  return p.kind === "device"
    ? { type: "device", id: p.deviceId, accessRole: p.accessRole }
    : { type: "person", id: p.personId, accessRole: p.accessRole };
}

export function authzPrincipal(p: Principal) {
  return {
    column: p.kind === "device" ? ("device" as const) : p.accessRole,
    personId: p.personId,
    departmentScope: p.departmentScope,
  };
}

export function body<T>(c: Context<AppEnv>, deps: Deps, ref: string): Promise<T> {
  return readBody<T>(c, deps.validator, ref);
}

export function reply(c: Context<AppEnv>, deps: Deps, status: ContentfulStatusCode, data: unknown, ref: string) {
  return send(c, deps.validator, deps.config.validateResponses, status, data, ref);
}
