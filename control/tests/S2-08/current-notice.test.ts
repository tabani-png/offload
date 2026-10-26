import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHarness, T0, type Harness } from "../helpers/harness.ts";
import { seedTenant } from "../helpers/seed.ts";
import type { Tx } from "../../src/db/pool.ts";
import { deviceConsent } from "../../src/modules/compliance/consent.ts";
import { filledMarkdown, noticeBody, signIn, sys, type Person } from "./fixtures.ts";

/**
 * "The current notice" for a person is resolved in several places: the device config (deviceConsent and the
 * ConsentPort extras the sync slice reads), the acknowledgement endpoints (which refuse replaced notices), the notice
 * list (replacedAt), the person's noticeAckVersionId (self-view, directory) and G1 consent. They must agree, also when
 * publishes share a millisecond and when version order and publish order disagree.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

interface Extras {
  requiredNotice?(tx: Tx, personId: string): Promise<{ noticeVersionId: string } | null>;
}

type Spec = { name: string; jurisdictions: string[] };
interface Scenario {
  /** Created in this order, so versions are 1..n in this order. */
  create: Spec[];
  /** Published in this order; `dt` is ms after the previous publish (0 = same millisecond). */
  publish: Array<{ name: string; dt: number }>;
  /** The member works in US-NY. */
  current: string;
}

const G = (name: string): Spec => ({ name, jurisdictions: [] });
const NY = (name: string): Spec => ({ name, jurisdictions: ["US-NY"] });
const CT = (name: string): Spec => ({ name, jurisdictions: ["US-CT"] });

const scenarios: Array<[string, Scenario]> = [
  ["two global notices published in order", { create: [G("a"), G("b")], publish: [{ name: "a", dt: 0 }, { name: "b", dt: 1 }], current: "b" }],
  [
    "two global notices published in reverse version order in one millisecond (the later publish replaces)",
    { create: [G("a"), G("b")], publish: [{ name: "b", dt: 0 }, { name: "a", dt: 0 }], current: "a" },
  ],
  [
    "a narrower notice published after a global one in the same millisecond, lower version",
    { create: [NY("ny"), G("g")], publish: [{ name: "g", dt: 0 }, { name: "ny", dt: 0 }], current: "ny" },
  ],
  [
    "a narrower notice published after a global one, later millisecond",
    { create: [G("g"), NY("ny")], publish: [{ name: "g", dt: 0 }, { name: "ny", dt: 1 }], current: "ny" },
  ],
  [
    "a global notice published after a narrower one in the same millisecond replaces it",
    { create: [G("g"), NY("ny")], publish: [{ name: "ny", dt: 0 }, { name: "g", dt: 0 }], current: "g" },
  ],
  [
    "a notice for another jurisdiction does not displace the global one",
    { create: [G("g"), CT("ct")], publish: [{ name: "g", dt: 0 }, { name: "ct", dt: 1 }], current: "g" },
  ],
];

async function create(owner: Person, s: Spec): Promise<string> {
  const template = s.jurisdictions.length === 0 ? "ontario-esa-policy" : s.jurisdictions[0] === "US-NY" ? "ny-notice-and-ack" : "ct-posting";
  const r = await owner.post("/v1/compliance/notices", noticeBody({ template, markdown: filledMarkdown(template), features: ["workflow_metrics"], jurisdictions: s.jurisdictions }));
  if (r.status !== 201) throw new Error(`create ${s.name} ${r.status}`);
  return r.json.id;
}

describe("NOTICE", () => {
  test.each(scenarios)("NOTICE: every endpoint resolves the same current notice: %s", async (_n, sc) => {
    const tenant = await seedTenant(h.db.migrator);
    const who = await signIn(h, tenant);
    const member = who.member.personId;
    await h.db.migrator`update people set jurisdiction = 'US-NY' where id = ${member}`;
    h.clock.t = T0;
    const ids: Record<string, string> = {};
    for (const s of sc.create) ids[s.name] = await create(who.owner, s);
    for (const p of sc.publish) {
      h.clock.advance(p.dt);
      const r = await who.owner.post(`/v1/compliance/notices/${ids[p.name]}/publish`);
      if (r.status !== 200) throw new Error(`publish ${p.name} ${r.status}`);
    }
    h.clock.advance(1);
    const expected = ids[sc.current]!;
    const name = (id: string | undefined | null) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;

    const resolve = () =>
      sys(h, async (tx) => ({
        deviceConsent: name((await deviceConsent(tx, member, h.clock.now())).requiredNotice?.noticeVersionId),
        consentPort: name((await (h.deps.ports.consent as Extras).requiredNotice?.(tx, member))?.noticeVersionId),
      }), tenant);
    expect(await resolve()).toEqual({ deviceConsent: sc.current, consentPort: sc.current });

    // The list never shows the current notice as replaced; every replaced notice is refused at the ack endpoint.
    const list = (await who.owner.get("/v1/compliance/notices")).json.items as Array<{ id: string; replacedAt: number | null; jurisdictions: string[] }>;
    expect(list.find((n) => n.id === expected)!.replacedAt).toBeNull();
    const applies = (n: { jurisdictions: string[] }) => n.jurisdictions.length === 0 || n.jurisdictions.includes("US-NY");
    for (const n of list.filter((x) => x.replacedAt !== null && applies(x))) {
      expect({ n: name(n.id), status: (await who.member.post(`/v1/me/notices/${n.id}/ack`)).status }).toEqual({ n: name(n.id), status: 409 });
    }

    // Acknowledging the current notice is accepted and opens G1; acking other live notices after it does not move
    // the person's recorded notice off the current one.
    expect((await who.member.post(`/v1/me/notices/${expected}/ack`)).status).toBe(201);
    for (const n of list.filter((x) => x.replacedAt === null && applies(x) && x.id !== expected)) {
      expect([200, 201]).toContain((await who.member.post(`/v1/me/notices/${n.id}/ack`)).status);
    }
    expect(await sys(h, (tx) => h.deps.ports.consent.allows(tx, member, "run_outcome"), tenant)).toBe(true);
    const me = (await who.member.get("/v1/me/data")).json;
    expect(name(me.person.noticeAckVersionId)).toBe(sc.current);
    expect(await resolve()).toEqual({ deviceConsent: sc.current, consentPort: sc.current });
  });
});
