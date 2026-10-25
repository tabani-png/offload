import { asPrincipal, type Client, type Harness } from "../helpers/harness.ts";
import type { PersonKey } from "../helpers/seed.ts";
import { withTenant } from "../../src/db/tenant.ts";
import type { Tx } from "../../src/db/pool.ts";
import type { SeededTenant } from "../helpers/seed.ts";

export const DAY_MS = 86_400_000;
export const SHA = "a".repeat(64);

export interface Who {
  owner: Person;
  admin: Person;
  lead: Person;
  member: Person;
  member2: Person;
  auditor: Person;
}

/**
 * A browser for one seeded person that signs in again for every request, so tests can move the fake clock by days
 * without tripping the 30-minute idle limit of owner and admin sessions.
 */
export type Person = Pick<Client, "get" | "post" | "send"> & { personId: string };

function person(h: Harness, key: PersonKey, tenant: SeededTenant): Person {
  const send = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await asPrincipal(h, key, tenant)).send(method, path, body, headers);
  return {
    personId: tenant.people[key].id,
    send,
    get: (p, hd) => send("GET", p, undefined, hd),
    post: (p, b = {}, hd) => send("POST", p, b, hd),
  };
}

export async function signIn(h: Harness, tenant: SeededTenant = h.a): Promise<Who> {
  const keys: PersonKey[] = ["owner", "admin", "lead", "member", "member2", "auditor"];
  return Object.fromEntries(keys.map((k) => [k, person(h, k, tenant)])) as unknown as Who;
}

export type FeatureName = "workflow_metrics" | "per_person_views" | "working_time";

export function noticeBody(over: Partial<{ template: string; title: string; markdown: string; features: FeatureName[]; jurisdictions: string[] }> = {}) {
  return {
    template: "ontario-esa-policy",
    title: "How Offload is used at Acme",
    markdown: "# Electronic monitoring policy\n\nWhat is captured, why, who sees it, how long it is kept, how to pause.",
    features: ["workflow_metrics"] as FeatureName[],
    jurisdictions: [] as string[],
    ...over,
  };
}

/** Creates and publishes a notice as the owner; returns the published notice DTO. */
export async function publishNotice(owner: Person, over: Parameters<typeof noticeBody>[0] = {}) {
  const created = await owner.post("/v1/compliance/notices", noticeBody(over));
  if (created.status !== 201) throw new Error(`create notice ${created.status} ${JSON.stringify(created.json)}`);
  const pub = await owner.post(`/v1/compliance/notices/${created.json.id}/publish`);
  if (pub.status !== 200) throw new Error(`publish notice ${pub.status} ${JSON.stringify(pub.json)}`);
  return pub.json;
}

export function enableBody(feature: "per_person_views" | "working_time", noticeVersionId: string, over: Record<string, unknown> = {}) {
  return {
    feature,
    jurisdictions: ["CA-ON"],
    legalBasis: "legitimate_interest",
    dpiaAttestation: {
      completedOn: "2026-10-01",
      documentHash: SHA,
      documentName: "dpia-2026.pdf",
      signerName: "Pia Owner",
      signerTitle: "Chief Operating Officer",
    },
    noticeVersionId,
    noticePeriodDays: 14,
    worksAgreementRef: null,
    quebecActivationAck: false,
    purposeLock: "process_improvement",
    ...over,
  };
}

/** Runs `fn` inside a system transaction of the tenant (what ports and jobs see). */
export function sys<T>(h: Harness, fn: (tx: Tx) => Promise<T>, tenant: SeededTenant = h.a): Promise<T> {
  return withTenant(h.db.app, { tenantId: tenant.id, accessRole: "system" }, fn);
}
