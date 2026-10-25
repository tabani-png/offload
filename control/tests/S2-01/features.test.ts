import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asPrincipal, createHarness, type Client, type Harness } from "../helpers/harness.ts";
import { PERMISSIONS, parseCell, type Column, type SensitiveFeature } from "../../src/rbac/permissions.ts";
import type { FeaturePort } from "../../src/ports.ts";

// A module whose handlers never check features: the gate alone must stop F:x requests (review wave A #7).
const CARELESS = `
const hits = (globalThis.__featureHits ??= []);
const answer = (c) => { hits.push(c.req.url); return c.json({ features: [...c.get("features")].sort() }); };
export default {
  name: "careless-metrics",
  routes(app) {
    app.get("/v1/metrics/hours-saved", answer);
    app.get("/v1/metrics/working-time", answer);
  },
};
`;

const hits = (): string[] => ((globalThis as { __featureHits?: string[] }).__featureHits ??= []);
const enabled = new Map<string, SensitiveFeature[]>();
const features: FeaturePort = { enabledFor: async (_tx, j) => new Set(enabled.get(j) ?? []) };

let dir: string;
let h: Harness;
const who: Partial<Record<Column, Client>> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "offload-features-"));
  mkdirSync(join(dir, "careless"));
  writeFileSync(join(dir, "careless", "index.ts"), CARELESS);
  h = await createHarness({ modulesDir: dir, ports: { features } });
  // member2 (finance) works in GB; everyone else in CA-ON.
  await h.db.migrator`update people set jurisdiction = 'GB' where id = ${h.a.people.member2.id}`;
  who.owner = await asPrincipal(h, "owner");
  who.admin = await asPrincipal(h, "admin");
  who.dept_lead = await asPrincipal(h, "lead");
  who.member = await asPrincipal(h, "member");
});
afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

const personQ = (id: string) => `scope=person:${id}`;

describe("RBAC feature cells at the gate", () => {
  test("RBAC: every F:x cell is 403 feature_disabled at the gate while the feature is off; the handler never runs", async () => {
    enabled.clear();
    let checked = 0;
    for (const p of PERMISSIONS) {
      for (const col of ["owner", "admin", "dept_lead", "member"] as const) {
        if (parseCell(p.roles[col]).features.length === 0) continue;
        // A subject each column may see: member (sales, CA-ON) is in the lead's department; members ask about themselves.
        const q = p.variant === "scope=person" ? personQ(h.a.people.member.id) : "scope=company";
        const before = hits().length;
        const r = await who[col]!.send(p.method, `${p.path}?${q}`);
        expect({ key: `${col} ${p.method} ${p.path} ${p.variant}`, status: r.status, code: r.json?.error?.code }).toEqual({
          key: `${col} ${p.method} ${p.path} ${p.variant}`, status: 403, code: "feature_disabled",
        });
        expect(hits().length).toBe(before);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  test("RBAC: per-person cells follow the subject's jurisdiction, not the caller's", async () => {
    enabled.clear();
    enabled.set("CA-ON", ["per_person_views"]);
    const hs = "/v1/metrics/hours-saved";
    const ok = await who.owner!.get(`${hs}?${personQ(h.a.people.member.id)}`);
    expect(ok.status).toBe(200);
    expect(ok.json.features).toEqual(["per_person_views"]);
    // member2 is in GB, where per-person views are off: the owner (CA-ON) still gets 403.
    expect((await who.owner!.get(`${hs}?${personQ(h.a.people.member2.id)}`)).json.error.code).toBe("feature_disabled");
    enabled.set("GB", ["per_person_views"]);
    expect((await who.admin!.get(`${hs}?${personQ(h.a.people.member2.id)}`)).status).toBe(200);
  });

  test("RBAC: out-of-scope or unknown subjects are 404 before any feature answer", async () => {
    enabled.clear();
    const hs = "/v1/metrics/hours-saved";
    // Lead (sales) asking about member2 (finance): 404 whether or not the feature is on.
    expect((await who.dept_lead!.get(`${hs}?${personQ(h.a.people.member2.id)}`)).status).toBe(404);
    expect((await who.dept_lead!.get(`${hs}?${personQ(h.a.people.member.id)}`)).json.error.code).toBe("feature_disabled");
    enabled.set("CA-ON", ["per_person_views", "working_time"]);
    expect((await who.dept_lead!.get(`${hs}?${personQ(h.a.people.member.id)}`)).status).toBe(200);
    // Member, S+F:working_time: another person is 404, self is allowed once working time is on.
    const wt = "/v1/metrics/working-time";
    expect((await who.member!.get(`${wt}?${personQ(h.a.people.lead.id)}`)).status).toBe(404);
    expect((await who.member!.get(`${wt}?${personQ(h.a.people.member.id)}`)).status).toBe(200);
    expect((await who.owner!.get(`${hs}?${personQ(crypto.randomUUID())}`)).status).toBe(404);
    expect((await who.owner!.get(`${hs}?scope=person:not-a-uuid`)).status).toBe(404);
    // Another tenant's person does not exist here.
    expect((await who.owner!.get(`${hs}?${personQ(h.b.people.member.id)}`)).status).toBe(404);
  });

  test("RBAC: group F:x cells need the feature on in at least one jurisdiction of the tenant", async () => {
    enabled.clear();
    const wt = "/v1/metrics/working-time?scope=company";
    expect((await who.owner!.get(wt)).json.error.code).toBe("feature_disabled");
    enabled.set("GB", ["working_time"]);
    const r = await who.owner!.get(wt);
    expect(r.status).toBe(200);
    expect(r.json.features).toEqual(["working_time"]);
  });
});
