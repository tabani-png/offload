// S2-05 test helpers: fake compliance ports, extra people with enrolled devices, sync object builders and a signed
// envelope sender that speaks exactly what brain/src/sync/envelope.ts sends.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULES_DIR } from "../../src/app.ts";
import type { ConsentPort, FeaturePort } from "../../src/ports.ts";
import type { SensitiveFeature } from "../../src/rbac/permissions.ts";
import { b64url, jcs, ulid } from "../../src/schema/encoding.ts";
import { createHarness, deviceToken, newDeviceKeys, type Harness, type Res } from "../helpers/harness.ts";
import { createSession, type SeededTenant } from "../helpers/seed.ts";

/** Every table this slice creates (0500-0599). */
export const S205_TABLES = [
  "device_seq", "sync_objects", "run_outcomes", "review_events", "baseline_samples", "baseline_sample_instances",
  "daily_aggregates", "daily_aggregate_workflows", "working_time_aggregates", "metric_snapshots", "metric_alerts", "metric_dirty",
];

/** Consent and features as S2-08 will answer them, held in memory. */
export class FakeCompliance {
  /** People who acknowledged the current notice (G1). */
  readonly acked = new Set<string>();
  /** People whose working-time consent holds: acked a notice listing it and the notice period passed (G2). */
  readonly workingTime = new Set<string>();
  /** Sensitive features per jurisdiction. */
  readonly features = new Map<string, SensitiveFeature[]>();
  readonly consent: ConsentPort = {
    allows: async (_tx, personId, kind) => {
      if (kind === "notice_ack") return true;
      if (!this.acked.has(personId)) return false;
      return kind !== "working_time_aggregate" || this.workingTime.has(personId);
    },
  };
  readonly featurePort: FeaturePort = { enabledFor: async (_tx, j) => new Set(this.features.get(j) ?? []) };
  ackAll(ids: Iterable<string>): void {
    for (const id of ids) this.acked.add(id);
  }
}

export interface S205 {
  h: Harness;
  fc: FakeCompliance;
  close(): Promise<void>;
}

/** A harness with fake consent/feature ports and, optionally, extra modules dropped beside copies of the real ones. */
export async function setup(extraModules: Record<string, string> = {}): Promise<S205> {
  const fc = new FakeCompliance();
  const dir = Object.keys(extraModules).length > 0 ? modulesWith(extraModules) : undefined;
  const h = await createHarness({
    ...(dir ? { modulesDir: dir } : {}),
    ports: { consent: fc.consent, features: fc.featurePort },
  });
  return {
    h,
    fc,
    async close() {
      await h.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A modules dir with copies of the org, sync and metrics modules (imports pointed back at the source tree) plus `extra`. */
function modulesWith(extra: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "offload-s205-"));
  const src = join(MODULES_DIR, "..");
  // Only this slice's modules and the core org module: later modules (compliance, broker, registry) register their own
  // handlers and ports, which would clash with the fakes here.
  for (const name of readdirSync(MODULES_DIR).filter((m) => ["org", "sync", "metrics"].includes(m))) {
    cpSync(join(MODULES_DIR, name), join(dir, name), { recursive: true });
    for (const f of readdirSync(join(dir, name)).filter((f) => f.endsWith(".ts"))) {
      const p = join(dir, name, f);
      writeFileSync(p, readFileSync(p, "utf8").replaceAll('"../../', `"${src}/`));
    }
  }
  for (const [name, code] of Object.entries(extra)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "index.ts"), code);
  }
  return dir;
}

/** A compliance stand-in that stores nothing but accepts notice acknowledgements (S2-08 registers the real one). */
export const FAKE_NOTICE_MODULE = `
export default {
  name: "fake-notices",
  routes() {},
  syncHandlers: {
    notice_ack: async () => { (globalThis.__acks ??= []).push(1); },
  },
};
`;

let n = 0;

/** Inserts an active person (migrator) and returns the id. */
export async function addPerson(
  h: Harness,
  t: SeededTenant,
  opts: { departmentId: string | null; jurisdiction?: string; jobRoleId?: string; role?: string },
): Promise<string> {
  n++;
  const [p] = await h.db.migrator`insert into people (tenant_id, email, display_name, access_role, department_id,
      jurisdiction, source)
    values (${t.id}, ${`p${n}-${crypto.randomUUID().slice(0, 8)}@x.example.com`}, ${`Person ${n}`}, ${opts.role ?? "member"},
      ${opts.departmentId}, ${opts.jurisdiction ?? "CA-ON"}, 'manual') returning id`;
  const id = p!.id as string;
  if (opts.jobRoleId) await holdJobRole(h, t, id, opts.jobRoleId);
  return id;
}

export async function holdJobRole(h: Harness, t: SeededTenant, personId: string, jobRoleId: string): Promise<void> {
  await h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${t.id}, ${jobRoleId}, ${personId})`;
}

export interface Dev {
  deviceId: string;
  personId: string;
  tenantId: string;
  keys: CryptoKeyPair;
  token: string;
  seq: number;
}

/** Registers a device for a person (as enrollment would) and mints its access token through challenge/token. */
export async function addDevice(h: Harness, t: SeededTenant, personId: string): Promise<Dev> {
  const { keys, jwk } = await newDeviceKeys();
  const [d] = await h.db.migrator`insert into devices (tenant_id, person_id, name, app_version, public_key_jwk, enrolled_at)
    values (${t.id}, ${personId}, 'Test Mac', '2.0.0', ${jwk}::jsonb, ${new Date(h.clock.now())}) returning id`;
  const deviceId = d!.id as string;
  return { deviceId, personId, tenantId: t.id, keys, token: await deviceToken(h, deviceId, keys.privateKey), seq: 0 };
}

export interface SendOpts {
  seq?: number;
  sentAt?: number;
  /** Replace the body after signing (tamper). */
  tamper?: (body: string) => string;
  /** Body to sign and send instead of the JCS text (e.g. re-ordered keys). */
  body?: (env: Record<string, unknown>) => string;
  /** Sign with another key. */
  signWith?: CryptoKey;
  /** Override the whole signature header. */
  header?: string | null;
  deviceId?: string;
}

export async function signBytes(key: CryptoKey, text: string): Promise<string> {
  return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text)));
}

/** POST /v1/sync/batches as the device: JCS body, ES256 over exactly those bytes, next seq. */
export async function sendObjects(h: Harness, dev: Dev, objects: unknown[], o: SendOpts = {}): Promise<Res> {
  const seq = o.seq ?? dev.seq + 1;
  const env = { v: 1, deviceId: o.deviceId ?? dev.deviceId, seq, sentAt: o.sentAt ?? h.clock.now(), objects };
  const signed = o.body ? o.body(env) : jcs(env);
  const sig = await signBytes(o.signWith ?? dev.keys.privateKey, signed);
  const body = o.tamper ? o.tamper(signed) : signed;
  const headers: Record<string, string> = { Authorization: `Bearer ${dev.token}`, "Content-Type": "application/json" };
  const header = o.header === undefined ? `keyid=${dev.deviceId}, sig=${sig}` : o.header;
  if (header !== null) headers["Offload-Signature"] = header;
  const r = await h.request("POST", "/v1/sync/batches", { body, headers });
  if (r.status === 200 && o.seq === undefined) dev.seq = seq;
  else if (r.status === 200) dev.seq = Math.max(dev.seq, seq);
  return r;
}

export function getConfig(h: Harness, dev: Dev): Promise<Res> {
  return h.request("GET", "/v1/sync/config", { headers: { Authorization: `Bearer ${dev.token}` } });
}

/** A signed-in browser for any person id (seeded keys are in helpers/harness.ts asPrincipal). */
export async function asPerson(h: Harness, t: SeededTenant, personId: string) {
  const cred = await createSession(h.db.migrator, t.id, personId, h.clock.now());
  return {
    get: (path: string) => h.request("GET", path, { headers: { Cookie: cred.cookie, "X-CSRF-Token": cred.csrf } }),
  };
}

// ------------------------------------------------------------------------------------------------ object builders

export const WF1 = "0a000000-0000-4000-8000-000000000001";
export const WF2 = "0a000000-0000-4000-8000-000000000002";

const ref = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Epoch ms of a UTC day + hour. */
export const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);

export function runOutcome(o: Partial<{
  id: string; runId: string; workflowId: string; version: number; outcome: string; sent: number; endedAt: number;
  runtime: "mac" | "cloud"; overnight: boolean; extra: Record<string, unknown>;
}> = {}) {
  const endedAt = o.endedAt ?? at("2026-10-20");
  const runId = o.runId ?? ulid(endedAt - 600_000);
  const sent = o.sent ?? 3;
  return {
    id: o.id ?? ulid(endedAt),
    kind: "run_outcome",
    createdAt: endedAt,
    runId,
    workflowId: o.workflowId ?? WF1,
    version: o.version ?? 1,
    runtime: o.runtime ?? "mac",
    startedAt: endedAt - 600_000,
    endedAt,
    outcome: o.outcome ?? "success",
    items: { total: sent, sent, failedBeforeSend: 0, unknown: 0, pending: 0 },
    batchHash: "b".repeat(64),
    approverKind: "person",
    overnightPolicyId: null,
    costCents: 0,
    errorCode: null,
    overnight: o.overnight ?? false,
    ...o.extra,
  };
}

export function reviewEvent(runId: string, o: Partial<{ review: number; edit: number; fix: number; at: number; decision: string }> = {}) {
  const t = o.at ?? at("2026-10-20", 13);
  return {
    id: ulid(t),
    kind: "review_event",
    createdAt: t,
    runId,
    reviewSeconds: o.review ?? 30,
    editSeconds: o.edit ?? 10,
    fixSeconds: o.fix ?? 0,
    itemsEdited: 1,
    decision: o.decision ?? "approved",
    surface: "mac_review",
  };
}

export function baselineSample(seconds: number[], o: Partial<{ workflowId: string; version: number }> = {}) {
  return {
    id: ulid(at("2026-10-01")),
    kind: "baseline_sample",
    createdAt: at("2026-10-01"),
    workflowId: o.workflowId ?? WF1,
    version: o.version ?? 1,
    windowStart: "2026-09-24",
    windowEnd: "2026-09-30",
    instances: seconds.map((s, i) => ({ instanceRef: ref(), activeSeconds: s, day: `2026-09-${String(24 + (i % 7)).padStart(2, "0")}` })),
  };
}

export function dailyAggregate(day = "2026-10-20", runs = 2) {
  return {
    id: ulid(at(day, 23)),
    kind: "daily_aggregate",
    createdAt: at(day, 23),
    day,
    activeWorkflows: 1,
    workflows: [{ workflowId: WF1, version: 1, runs, successes: runs, savedSecondsDevice: 600 }],
  };
}

export const NOTICE = "0e000000-0000-4000-8000-000000000001";

export function workingTime(day = "2026-10-20", minutes = 420) {
  return {
    id: ulid(at(day, 23)),
    kind: "working_time_aggregate",
    createdAt: at(day, 23),
    day,
    activeMinutes: minutes,
    firstActiveQuarter: 36,
    lastActiveQuarter: 70,
    noticeVersionId: NOTICE,
  };
}

export function noticeAck(jurisdiction = "CA-ON") {
  return {
    id: ulid(at("2026-10-02")),
    kind: "notice_ack",
    createdAt: at("2026-10-02"),
    noticeVersionId: NOTICE,
    acknowledgedAt: at("2026-10-02"),
    jurisdiction,
    features: ["workflow_metrics"],
    channel: "mac_app",
  };
}

/** Accepted ids and rejected codes of a receipt, for compact asserts. */
export function receipt(r: Res): { accepted: string[]; rejected: Record<string, string> } {
  if (r.status !== 200) throw new Error(`sync ${r.status} ${JSON.stringify(r.json)}`);
  return {
    accepted: r.json.accepted,
    rejected: Object.fromEntries((r.json.rejected as Array<{ id: string; code: string }>).map((x) => [x.id, x.code])),
  };
}

/**
 * A department of `size` people in tenant `t`, each with a device that acknowledged consent and synced one baseline
 * and `runsEach` successful runs with review events. Returns the people and every object sent, for golden checks.
 */
export async function populate(
  s: S205,
  t: SeededTenant,
  opts: { departmentId: string; size: number; jobRoleId?: string; runsEach?: number; workflowId?: string; day?: string; jurisdiction?: string },
) {
  const people: Array<{ personId: string; dev: Dev; objects: Array<Record<string, unknown>> }> = [];
  for (let i = 0; i < opts.size; i++) {
    const personId = await addPerson(s.h, t, {
      departmentId: opts.departmentId,
      ...(opts.jobRoleId ? { jobRoleId: opts.jobRoleId } : {}),
      ...(opts.jurisdiction ? { jurisdiction: opts.jurisdiction } : {}),
    });
    s.fc.acked.add(personId);
    const dev = await addDevice(s.h, t, personId);
    const objects: Array<Record<string, unknown>> = [baselineSample([300 + i * 10, 320, 340, 360, 380], { workflowId: opts.workflowId ?? WF1 })];
    for (let k = 0; k < (opts.runsEach ?? 2); k++) {
      const run = runOutcome({ workflowId: opts.workflowId ?? WF1, endedAt: at(opts.day ?? "2026-10-20", 9 + k + i), sent: 2 + k });
      objects.push(run, reviewEvent(run.runId, { review: 20 + i, edit: 5 * k }));
    }
    const r = receipt(await sendObjects(s.h, dev, objects));
    if (Object.keys(r.rejected).length > 0) throw new Error(`populate rejected ${JSON.stringify(r.rejected)}`);
    people.push({ personId, dev, objects });
  }
  return people;
}
