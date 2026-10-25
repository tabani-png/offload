import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asPrincipal, createHarness, type Harness } from "../helpers/harness.ts";
import { MODULES_DIR, loadModules, resolvePorts } from "../../src/app.ts";
import { withTenant } from "../../src/db/tenant.ts";

const APP_TS = join(import.meta.dir, "../../src/app.ts");

/** A modules dir holding the real org module plus extra modules written by the test. */
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function modulesDir(extra: Record<string, string>): string {
  const dir = tempDir("offload-modules-");
  cpSync(join(MODULES_DIR, "org"), join(dir, "org"), { recursive: true });
  // The copied org module imports ../../app.ts etc.; point it back at the real source tree.
  for (const f of ["index.ts", "tenant.ts", "departments.ts", "people.ts", "job-roles.ts", "role-identities.ts", "support-grants.ts", "util.ts"]) {
    const p = join(dir, "org", f);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll('"../../', `"${join(MODULES_DIR, "..")}/`));
  }
  for (const [name, src] of Object.entries(extra)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "index.ts"), src);
  }
  return dir;
}

const FAKE_COMPLIANCE = `
export default {
  name: "fake-compliance",
  routes(app, deps) {
    app.get("/v1/compliance/features", (c) => c.json({ loadedBy: "fake-compliance" }));
  },
  provides: {
    features: { enabledFor: async () => new Set(["per_person_views"]) },
  },
};
`;

let h: Harness;
let custom: Harness;
beforeAll(async () => {
  h = await createHarness();
  custom = await createHarness({ modulesDir: modulesDir({ "fake-compliance": FAKE_COMPLIANCE }) });
});
afterAll(async () => {
  await h.close();
  await custom.close();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("LOADER", () => {
  test("LOADER: the real modules folder mounts the org module", async () => {
    const mods = await loadModules();
    expect(mods.map((m) => m.name)).toContain("org");
    expect((await (await asPrincipal(h, "member")).get("/v1/tenant")).status).toBe(200);
  });

  test("LOADER: a module dropped into modules/ is mounted without editing app.ts", async () => {
    const r = await (await asPrincipal(custom, "member")).get("/v1/compliance/features");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ loadedBy: "fake-compliance" });
    // Not mounted in the app built from the real folder.
    expect((await (await asPrincipal(h, "member")).get("/v1/compliance/features")).status).toBe(404);
  });

  test("LOADER: a dropped-in module's routes still pass the RBAC gate", async () => {
    const r = await custom.request("GET", "/v1/compliance/features");
    expect(r.status).toBe(401);
  });

  test("LOADER: a module's provided port replaces the default", async () => {
    const f = await withTenant(custom.db.app, { tenantId: custom.a.id }, (tx) => custom.deps.ports.features.enabledFor(tx, "CA-ON"));
    expect([...f]).toEqual(["per_person_views"]);
  });

  test("LOADER: defaults apply for every port no module provides", async () => {
    const p = h.deps.ports;
    await withTenant(h.db.app, { tenantId: h.a.id }, async (tx) => {
      expect(await p.consent.allows(tx, h.a.people.member.id, "notice_ack")).toBe(true);
      expect(await p.consent.allows(tx, h.a.people.member.id, "run_outcome")).toBe(false);
      expect([...(await p.features.enabledFor(tx, "CA-ON"))]).toEqual([]);
      expect(await p.registry.workflowsOf(tx, h.a.people.member.id)).toEqual([]);
      expect(await p.broker.revokeTokensOf(tx, h.a.people.member.id)).toBe(0);
      expect(await p.broker.killSwitchActive(tx, {})).toBe(true);
      expect(await p.workers.pauseFor(tx, h.a.people.member.id)).toBe(0);
    });
    expect(typeof p.audit.write).toBe("function");
    expect(typeof p.continuity.freeze).toBe("function");
  });

  test("LOADER: the default ContinuityPort records a pending freeze and revokes access", async () => {
    const member = await asPrincipal(h, "member2");
    await withTenant(h.db.app, { tenantId: h.a.id }, (tx) => h.deps.ports.continuity.freeze(tx, h.a.people.member2.id, { source: "admin" }));
    const [p] = await h.db.migrator`select state, pending_freeze_at from people where id = ${h.a.people.member2.id}`;
    expect(p!.state).toBe("frozen");
    expect(p!.pending_freeze_at).not.toBeNull();
    expect((await member.get("/v1/tenant")).status).toBe(401);
  });

  test("LOADER: two modules providing the same port is a startup error", () => {
    const m = (name: string) => ({ name, routes() {}, provides: { features: { enabledFor: async () => new Set<never>() } } });
    expect(() => resolvePorts({ now: () => 0 }, [m("a"), m("b")])).toThrow(/provided by both a and b/);
  });

  test("LOADER: a module folder without a ModuleDef export fails loudly", async () => {
    const dir = tempDir("offload-bad-");
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "index.ts"), "export const nothing = 1;\n");
    await expect(loadModules(dir)).rejects.toThrow(/must export a ModuleDef/);
  });

  test("LOADER: app.ts imports no module by name", () => {
    const src = readFileSync(APP_TS, "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/modules\//);
    expect(src).not.toMatch(/import\(["']\.\/modules\//);
  });
});
