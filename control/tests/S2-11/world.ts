// S2-11 seeded company, built only through the public API (plan/stage-2/API.md) and the frozen sync contract: people
// are invited, notices published, devices enrolled with a code, every metric arrives as a signed sync envelope from a
// device, workflows are proposed over sync and promoted. The one in-process call is the broker's service API
// (`brokerOf(deps.ports).proposeBatch`, API.md "Service": no HTTP credential exists), for one pending batch.
import { brokerOf } from "../../src/modules/broker/index.ts";
import { b64url, jcs, sha256Hex, ulid } from "../../src/schema/encoding.ts";
import { createHarness, deviceToken, newDeviceKeys, T0, type Harness, type Res } from "../helpers/harness.ts";
import { createSession, type PersonKey, type SeededTenant } from "../helpers/seed.ts";

export const DAY = 86_400_000;
/** Where the world starts (before anyone acknowledges anything) and where it is left: harness T0, 26 Oct 09:00 UTC. */
export const START = Date.UTC(2026, 9, 1, 8, 0, 0);
export const NOW = T0;
export const SHA = "a".repeat(64);

export interface Browser {
  personId: string;
  get(path: string, headers?: Record<string, string>): Promise<Res>;
  send(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res>;
  /** A cookie + CSRF pair valid at the current clock (sessions idle out; owner/admin after 30 min). */
  cred(): Promise<{ cookie: string; csrf: string }>;
}

export interface Device {
  personId: string;
  deviceId: string;
  keys: CryptoKeyPair;
  seq: number;
}

export interface Member {
  personId: string;
  name: string;
  departmentId: string;
  workflowId: string;
  device: Device;
}

export interface World {
  h: Harness;
  t: SeededTenant;
  depts: { sales: string; finance: string; legal: string };
  jobRoles: { sdr: string; ap: string; counsel: string };
  workflows: { sales: string; finance: string; legal: string };
  /** Everyone who synced data, by department (sales 6, finance 5, legal 4: under the floor of 5). */
  members: Member[];
  noticeId: string;
  pendingBatch: string;
  as(who: PersonKey | string): Browser;
  sendObjects(dev: Device, objects: unknown[]): Promise<Res>;
  /** Moves the shared clock (server, sessions and envelopes all read it). */
  setClock(t: number): void;
  close(): Promise<void>;
}

const ok = (r: Res, what: string, status = [200, 201]) => {
  if (!status.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

/** definitionHash per SPEC S2-06: sha256(JCS(definition minus id, kind, createdAt, workflowId, version, definitionHash)). */
function definitionHash(def: Record<string, unknown>): string {
  const rest = { ...def };
  for (const k of ["id", "kind", "createdAt", "workflowId", "version", "definitionHash"]) delete rest[k];
  return sha256Hex(jcs(rest));
}

function proposal(local: string, name: string, now: number) {
  const def = {
    localWorkflowId: local,
    workflowId: null,
    version: null,
    name,
    description: `${name}: read the new rows and draft one reply each for review.`,
    trigger: { type: "cron", cron: "0 9 * * 1", timezone: "America/Toronto" },
    steps: [
      {
        id: "read_rows", title: "Read new rows", detail: "Read the rows added since the last run.", class: "read",
        capability: "sheet.read", connection: { kind: "gmail", ownership: "personal-allowed", connectionId: null, label: "Sheet" }, gate: "none",
      },
      { id: "draft", title: "Draft replies", detail: "Draft one reply per row.", class: "draft", capability: "text.draft", connection: null, gate: "none" },
    ],
    skillMd: `---\nname: ${local}\ndescription: ${name}\n---\n\n# ${name}\n\n## Steps\n1. **Read new rows**.\n2. **Draft replies**.\n`,
    factsKeys: [],
    limits: { maxItemsPerRun: 20, maxRunsPerDay: 1 },
  };
  return { id: ulid(now), kind: "workflow_proposal", createdAt: now, ...def, definitionHash: definitionHash(def) };
}

const ref = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const at = (day: string, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);

/** Run outcome + review for one run; numbers vary by person index so the totals are not trivially symmetric. */
function run(workflowId: string, day: string, hour: number, sent: number, review: number) {
  const endedAt = at(day, hour);
  const runId = ulid(endedAt - 600_000);
  return [
    {
      id: ulid(endedAt), kind: "run_outcome", createdAt: endedAt, runId, workflowId, version: 1, runtime: "mac",
      startedAt: endedAt - 600_000, endedAt, outcome: "success",
      items: { total: sent, sent, failedBeforeSend: 0, unknown: 0, pending: 0 }, batchHash: "b".repeat(64),
      approverKind: "person", overnightPolicyId: null, costCents: 0, errorCode: null, overnight: hour < 6,
    },
    {
      id: ulid(endedAt + 60_000), kind: "review_event", createdAt: endedAt + 60_000, runId, reviewSeconds: review,
      editSeconds: 10, fixSeconds: 0, itemsEdited: 1, decision: "approved", surface: "mac_review",
    },
  ];
}

function baseline(workflowId: string, seconds: number[]) {
  return {
    id: ulid(at("2026-10-09")), kind: "baseline_sample", createdAt: at("2026-10-09"), workflowId, version: 1,
    windowStart: "2026-10-02", windowEnd: "2026-10-08",
    instances: seconds.map((s, i) => ({ instanceRef: ref(), activeSeconds: s, day: `2026-10-0${2 + (i % 7)}` })),
  };
}

export function noticeAck(noticeVersionId: string, acknowledgedAt: number, features: string[] = ["workflow_metrics"]) {
  return {
    id: ulid(acknowledgedAt), kind: "notice_ack", createdAt: acknowledgedAt, noticeVersionId, acknowledgedAt,
    jurisdiction: "CA-ON", features, channel: "mac_app",
  };
}

export function workingTime(day: string, minutes: number, noticeVersionId: string) {
  return {
    id: ulid(at(day, 23)), kind: "working_time_aggregate", createdAt: at(day, 23), day, activeMinutes: minutes,
    firstActiveQuarter: 36, lastActiveQuarter: 70, noticeVersionId,
  };
}

export function enableBody(feature: "per_person_views" | "working_time", noticeVersionId: string, noticePeriodDays = 14) {
  return {
    feature, jurisdictions: ["CA-ON"], legalBasis: "legitimate_interest",
    dpiaAttestation: { completedOn: "2026-10-01", documentHash: SHA, documentName: "dpia-2026.pdf", signerName: "Pia Owner", signerTitle: "COO" },
    noticeVersionId, noticePeriodDays, worksAgreementRef: null, quebecActivationAck: false, purposeLock: "process_improvement",
  };
}

/** Builds the company. Leaves the clock at NOW. */
export async function buildWorld(): Promise<World> {
  const h = await createHarness();
  const t = h.a;
  h.clock.t = START;
  const sessions = new Map<string, { at: number; cookie: string; csrf: string }>();
  const idOf = (who: PersonKey | string) => (who in t.people ? t.people[who as PersonKey].id : who);

  const as = (who: PersonKey | string): Browser => {
    const personId = idOf(who);
    const cred = async () => {
      const s = sessions.get(personId);
      if (s && h.clock.now() >= s.at && h.clock.now() - s.at < 20 * 60_000) return s;
      const c = await createSession(h.db.migrator, t.id, personId, h.clock.now());
      const fresh = { at: h.clock.now(), cookie: c.cookie, csrf: c.csrf };
      sessions.set(personId, fresh);
      return fresh;
    };
    const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const c = await cred();
      return h.request(method, path, { ...(body !== undefined ? { body } : {}), headers: { Cookie: c.cookie, "X-CSRF-Token": c.csrf, ...headers } });
    };
    return { personId, cred, send, get: (p, hd) => send("GET", p, undefined, hd) };
  };

  const enroll = async (personId: string): Promise<Device> => {
    const code = ok(await as(personId).send("POST", "/v1/devices/enrollment-codes"), "enrollment code");
    const { keys, jwk } = await newDeviceKeys();
    const en = ok(await h.request("POST", "/v1/devices/enroll", {
      body: { enrollmentCode: code.code, deviceName: "Mac", appVersion: "2.0.0", publicKeyJwk: jwk },
    }), "enroll");
    return { personId, deviceId: en.deviceId, keys, seq: 0 };
  };

  const sendObjects = async (dev: Device, objects: unknown[]) => {
    const token = await deviceToken(h, dev.deviceId, dev.keys.privateKey);
    const env = { v: 1, deviceId: dev.deviceId, seq: dev.seq + 1, sentAt: h.clock.now(), objects };
    const text = jcs(env);
    const sig = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev.keys.privateKey, new TextEncoder().encode(text)));
    const r = await h.request("POST", "/v1/sync/batches", {
      body: text,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Offload-Signature": `keyid=${dev.deviceId}, sig=${sig}` },
    });
    if (r.status === 200) dev.seq++;
    return r;
  };
  const synced = async (dev: Device, objects: unknown[], what: string) => {
    const r = ok(await sendObjects(dev, objects), what, [200]);
    if (r.rejected.length > 0) throw new Error(`${what}: rejected ${JSON.stringify(r.rejected)}`);
  };

  const owner = as("owner");
  const admin = as("admin");

  // Org: a third department with its own job role.
  const legal = ok(await admin.send("POST", "/v1/departments", { name: "Legal" }), "department").id as string;
  const counsel = ok(await admin.send("POST", "/v1/job-roles", { name: "Counsel", departmentId: legal }), "job role").id as string;
  const depts = { sales: t.departments.sales, finance: t.departments.finance, legal };
  const jobRoles = { sdr: t.jobRoles.sdr, ap: t.jobRoles.ap, counsel };

  // The workflow-metrics notice, published before anyone acknowledges it.
  const notice = ok(await owner.send("POST", "/v1/compliance/notices", {
    template: "custom", title: "How Offload is used at Acme",
    markdown: "# Electronic monitoring policy\n\nWhat is captured, why, who sees it, how long it is kept, how to pause.",
    features: ["workflow_metrics"], jurisdictions: [],
  }), "notice");
  ok(await owner.send("POST", `/v1/compliance/notices/${notice.id}/publish`), "publish");

  // People: the seeded member (sales) and member2 (finance) plus invited colleagues.
  const plan: Array<{ dept: keyof typeof depts; role: keyof typeof jobRoles; n: number; seeded?: PersonKey }> = [
    { dept: "sales", role: "sdr", n: 5, seeded: "member" },
    { dept: "finance", role: "ap", n: 4, seeded: "member2" },
    { dept: "legal", role: "counsel", n: 4 },
  ];
  const roster: Array<{ personId: string; name: string; dept: keyof typeof depts; role: keyof typeof jobRoles }> = [];
  for (const p of plan) {
    if (p.seeded) roster.push({ personId: t.people[p.seeded].id, name: p.seeded, dept: p.dept, role: p.role });
    for (let i = 0; i < p.n; i++) {
      const name = `${p.dept[0]!.toUpperCase()}${p.dept.slice(1)} ${i + 1}`;
      const inv = ok(await admin.send("POST", "/v1/people/invite", {
        email: `${p.dept}${i + 1}@acme.example.com`, displayName: name, departmentId: depts[p.dept], jurisdiction: "CA-ON",
      }), "invite");
      roster.push({ personId: inv.id, name, dept: p.dept, role: p.role });
    }
  }
  for (const r of roster) ok(await admin.send("PATCH", `/v1/people/${r.personId}`, { jobRoleIds: [jobRoles[r.role]] }), "job role holder");

  // Devices; everyone acknowledges the notice on 1 Oct (consent is forward-only: data starts here).
  h.clock.t = START + 3600_000;
  const devices = new Map<string, Device>();
  for (const r of roster) {
    const dev = await enroll(r.personId);
    devices.set(r.personId, dev);
    await synced(dev, [noticeAck(notice.id, h.clock.now())], "ack");
  }

  // One proposal per department, promoted to its job role by the admin.
  const first = (d: keyof typeof depts) => roster.find((r) => r.dept === d)!;
  const workflows = {} as World["workflows"];
  for (const [d, name] of [["sales", "Lead follow-up"], ["finance", "Invoice matching"], ["legal", "Contract intake"]] as const) {
    const obj = proposal(`wf_${d}`, name, h.clock.now());
    await synced(devices.get(first(d).personId)!, [obj], "proposal");
    const list = ok(await admin.get("/v1/workflows?state=proposed&limit=200"), "workflows");
    const wf = (list.items as Array<{ id: string; name: string }>).find((w) => w.name === name)!;
    ok(await admin.send("POST", `/v1/workflows/${wf.id}/promote`, {
      jobRoleId: jobRoles[roleOf(d)], departmentId: depts[d], fromVersion: 1,
      bindings: [{ stepId: "read_rows", connectionId: t.connections.company, disable: false }],
    }), "promote");
    workflows[d] = wf.id;
  }

  // Baselines and runs, sent on 25 Oct evening (every run is after the acknowledgement).
  h.clock.t = at("2026-10-25", 20);
  const members: Member[] = [];
  let k = 0;
  for (const r of roster) {
    const wf = workflows[r.dept];
    const dev = devices.get(r.personId)!;
    const objects: unknown[] = [baseline(wf, [280 + 10 * k, 300, 320 + k, 360, 400])];
    const days = ["2026-10-06", "2026-10-13", "2026-10-20"];
    days.forEach((day, i) => objects.push(...run(wf, day, 9 + (k % 6) + i, 2 + ((k + i) % 3), 20 + k + 5 * i)));
    await synced(dev, objects, "metrics");
    members.push({ personId: r.personId, name: r.name, departmentId: depts[r.dept], workflowId: wf, device: dev });
    k++;
  }

  // One batch waiting for approval in sales (the role policy names the runner or the dept lead as approvers).
  h.clock.t = NOW - 3600_000;
  ok(await admin.send("PUT", `/v1/policies/job-roles/${jobRoles.sdr}`, rolePolicy(jobRoles.sdr, t.people.admin.id, h.clock.now())), "role policy", [200, 201]);
  // A person sends only through their own personal-allowed connection (S2-07, ADR 0106 §6).
  const memberGmail = (await h.db.migrator`insert into connections (tenant_id, kind, ownership, label, owner_person_id, provider, external_ref)
    values (${t.id}, 'gmail', 'personal-allowed', 'Gmail', ${t.people.member.id}, 'composio', 'acct_s211_member_gmail') returning id`)[0]!.id as string;
  const proposed = await brokerOf(h.deps.ports).proposeBatch(t.id, {
    runId: ulid(h.clock.now()), workflowId: workflows.sales, version: 1, jobRoleId: jobRoles.sdr, runtime: "mac",
    identity: { type: "person", id: t.people.member.id }, runnerPersonId: t.people.member.id, connectionId: memberGmail,
  }, [{ key: "lead-1@prospect.example", capability: "mail.send", fields: [["to", "lead-1@prospect.example"], ["subject", "Following up"], ["body", "Hi, a short follow-up."]] }]);
  if (!proposed.ok) throw new Error(`proposeBatch: ${proposed.code} ${proposed.message}`);

  h.clock.t = NOW;
  return {
    h, t, depts, jobRoles, workflows, members, noticeId: notice.id, pendingBatch: proposed.batchHash,
    as, sendObjects,
    setClock: (x) => { h.clock.t = x; },
    close: () => h.close(),
  };
}

function roleOf(d: "sales" | "finance" | "legal") {
  return d === "sales" ? "sdr" : d === "finance" ? "ap" : "counsel";
}

function rolePolicy(jobRoleId: string, updatedBy: string, updatedAt: number) {
  return {
    jobRoleId, allowedCapabilities: ["mail.send"], approvers: "runner_or_dept_lead", sessionBudgetCents: 500,
    dailyBudgetCents: 2000, maxItemsPerBatch: 5, models: { design: "claude-opus-5-5", steps: "claude-sonnet-5-5" }, updatedAt, updatedBy,
  };
}
