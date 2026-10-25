// Fixture company for the mock API. Every object follows schemas/stage2 (checked by tests/schema.test.ts).
// Northwind Supply is fictional. Two departments sit under the group floor on purpose (Legal 3, Facilities 4).

import type {
  AuditEvent, Batch, Connection, Department, Device, Grade, Handover, JobRole, KillSwitch, Notice, OvernightPolicy,
  Person, RoleIdentity, RolePolicy, Tenant, Workflow, WorkflowDefinition, WorkflowStep, Worker, WorkerRun,
} from "../types.ts";
import { hex32, hex64, ulid, uuid } from "./ids.ts";

/** Fixed "now" for the mock: Sunday 25 October 2026, 09:00 UTC. */
export const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
export const TODAY = "2026-10-25";
export const DAY_MS = 86_400_000;
export const TIMEZONE = "America/Toronto";

export const tenant: Tenant = {
  id: uuid(1),
  name: "Northwind Supply",
  createdAt: Date.UTC(2026, 3, 2),
  reportingTimezone: TIMEZONE,
  groupFloor: 5,
  identityAddon: { sso: true, directorySync: true },
  retention: { perPersonDays: 90, workingTimeDays: 30, groupMonths: 24 },
  monthlyWorkerBudgetCents: 150_000,
};

interface DeptSpec { n: number; name: string; headcount: number; groups: string[] }
const DEPTS: DeptSpec[] = [
  { n: 101, name: "Sales", headcount: 14, groups: ["sales@northwind.example"] },
  { n: 102, name: "Finance", headcount: 9, groups: ["finance@northwind.example"] },
  { n: 103, name: "Operations", headcount: 11, groups: ["ops@northwind.example"] },
  { n: 104, name: "People", headcount: 6, groups: ["people@northwind.example"] },
  { n: 105, name: "Legal", headcount: 3, groups: ["legal@northwind.example"] },
  { n: 106, name: "Facilities", headcount: 4, groups: ["facilities@northwind.example"] },
];

export const DEPT = { sales: uuid(101), finance: uuid(102), ops: uuid(103), people: uuid(104), legal: uuid(105), facilities: uuid(106) };

const FIRST = ["Maya", "Sam", "Priya", "Jonas", "Lea", "Omar", "Grace", "Tomas", "Aiko", "Ben", "Chloe", "Diego", "Elif",
  "Farah", "Gus", "Hana", "Ivan", "Jade", "Kofi", "Lina", "Marc", "Nora", "Oli", "Pia", "Quinn", "Rosa", "Seb", "Tara",
  "Umar", "Vera", "Wes", "Xin", "Yara", "Zoe", "Arlo", "Bea", "Cyrus", "Dina", "Emil", "Fern", "Gil", "Hugo", "Ines",
  "Joel", "Kira", "Luc", "Mina"];
const LAST = ["Okafor", "Lindqvist", "Raman", "Becker", "Moreau", "Haddad", "Chen", "Novak", "Sato", "Walsh", "Dubois",
  "Alvarez", "Kaya", "Nasser", "Berg", "Ito", "Petrov", "Lam", "Mensah", "Costa", "Roy", "Fischer", "Byrne", "Lund",
  "Park", "Silva", "Klein", "Shah", "Rahman", "Ortiz", "Doyle", "Wu", "Aziz", "Hart", "Neri", "Vogel", "Pereira", "Iqbal",
  "Holm", "Quinn", "Adler", "Brandt", "Romero", "Kerr", "Mori", "Gauthier", "Rossi"];
const JURIS = ["CA-ON", "CA-ON", "US-NY", "CA-QC", "GB", "DE", "CA-BC", "US-CA"];

export const departments: Department[] = DEPTS.map((d) => ({
  id: uuid(d.n),
  name: d.name,
  parentId: null,
  directoryGroups: d.groups,
  leadPersonIds: [],
}));

export const JR = {
  sdr: uuid(201), ae: uuid(202), ap: uuid(203), ops: uuid(204), recruiter: uuid(205), counsel: uuid(206), fac: uuid(207),
  controller: uuid(208),
};

export const people: Person[] = [];
{
  let i = 0;
  for (const d of DEPTS) {
    for (let k = 0; k < d.headcount; k++, i++) {
      const first = FIRST[i % FIRST.length]!;
      const last = LAST[(i * 7) % LAST.length]!;
      people.push({
        id: uuid(2000 + i),
        email: `${first.toLowerCase()}.${last.toLowerCase()}@northwind.example`,
        displayName: `${first} ${last}`,
        accessRole: "member",
        departmentId: uuid(d.n),
        deptLeadOf: [],
        jobRoleIds: [],
        jurisdiction: JURIS[i % JURIS.length]!,
        state: "active",
        leavingOn: null,
        source: "directory",
        noticeAckVersionId: uuid(702),
      });
    }
  }
}
const byIndex = (i: number) => people[i]!;
// Sales 0-13, Finance 14-22, Operations 23-33, People 34-39, Legal 40-42, Facilities 43-46.
export const ME = byIndex(23); // Operations, the owner who signs in to the mock
ME.accessRole = "owner";
ME.jurisdiction = "CA-ON";
byIndex(34).accessRole = "admin";
byIndex(14).accessRole = "auditor";
for (const [lead, dept] of [[0, 101], [15, 102], [24, 103], [35, 104], [40, 105], [43, 106]] as const) {
  const p = byIndex(lead);
  p.accessRole = "dept_lead";
  p.deptLeadOf = [uuid(dept)];
  departments.find((d) => d.id === uuid(dept))!.leadPersonIds.push(p.id);
}
export const LEAVING = byIndex(5);
LEAVING.state = "leaving";
LEAVING.leavingOn = "2026-11-06";
export const FROZEN = byIndex(18);
FROZEN.state = "frozen";
FROZEN.leavingOn = "2026-10-16";
byIndex(9).noticeAckVersionId = null;
byIndex(30).noticeAckVersionId = uuid(701);
byIndex(46).source = "invite";

function holders(from: number, to: number): string[] {
  return people.slice(from, to + 1).map((p) => p.id);
}

export const jobRoles: JobRole[] = [
  { id: JR.sdr, name: "SDR, Sales", departmentId: DEPT.sales, roleIdentityIds: [uuid(401)], holderPersonIds: holders(1, 8) },
  { id: JR.ae, name: "Account executive, Sales", departmentId: DEPT.sales, roleIdentityIds: [], holderPersonIds: holders(9, 13) },
  { id: JR.ap, name: "AP clerk, Finance", departmentId: DEPT.finance, roleIdentityIds: [uuid(402)], holderPersonIds: holders(16, 21) },
  { id: JR.controller, name: "Controller, Finance", departmentId: DEPT.finance, roleIdentityIds: [], holderPersonIds: holders(14, 15) },
  { id: JR.ops, name: "Ops coordinator, Operations", departmentId: DEPT.ops, roleIdentityIds: [], holderPersonIds: holders(23, 33) },
  { id: JR.recruiter, name: "Recruiter, People", departmentId: DEPT.people, roleIdentityIds: [uuid(403)], holderPersonIds: holders(34, 39) },
  { id: JR.counsel, name: "Contracts counsel, Legal", departmentId: DEPT.legal, roleIdentityIds: [], holderPersonIds: holders(40, 42) },
  { id: JR.fac, name: "Facilities coordinator, Facilities", departmentId: DEPT.facilities, roleIdentityIds: [], holderPersonIds: holders(43, 46) },
];
for (const jr of jobRoles) for (const id of jr.holderPersonIds) people.find((p) => p.id === id)!.jobRoleIds.push(jr.id);

export const connections: Connection[] = [
  { id: uuid(501), kind: "google_workspace_shared", ownership: "company", label: "sales@ shared mailbox", ownerPersonId: null, jobRoleId: JR.sdr, provider: "composio", externalRef: "ca_sales_mailbox", health: "ok", createdAt: Date.UTC(2026, 4, 3) },
  { id: uuid(502), kind: "crm", ownership: "company", label: "HubSpot (company)", ownerPersonId: null, jobRoleId: null, provider: "composio", externalRef: "ca_hubspot_org", health: "ok", createdAt: Date.UTC(2026, 4, 3) },
  { id: uuid(503), kind: "m365_shared_mailbox", ownership: "company", label: "ap@ shared mailbox", ownerPersonId: null, jobRoleId: JR.ap, provider: "composio", externalRef: "ca_ap_mailbox", health: "ok", createdAt: Date.UTC(2026, 4, 9) },
  { id: uuid(504), kind: "composio_org", ownership: "company", label: "Google Sheets (company)", ownerPersonId: null, jobRoleId: null, provider: "composio", externalRef: "ca_sheets_org", health: "failed", createdAt: Date.UTC(2026, 5, 1) },
  { id: uuid(505), kind: "gmail", ownership: "personal-allowed", label: "Personal Gmail", ownerPersonId: byIndex(3).id, jobRoleId: null, provider: "composio", externalRef: "ca_gmail_p3", health: "ok", createdAt: Date.UTC(2026, 6, 14) },
  { id: uuid(506), kind: "linkedin_personal", ownership: "personal-forbidden", label: "LinkedIn (personal)", ownerPersonId: byIndex(3).id, jobRoleId: null, provider: "composio", externalRef: "ca_li_p3", health: "ok", createdAt: Date.UTC(2026, 6, 14) },
  { id: uuid(507), kind: "api", ownership: "company", label: "Greenhouse API", ownerPersonId: null, jobRoleId: JR.recruiter, provider: "api", externalRef: "greenhouse_v1", health: "unknown", createdAt: Date.UTC(2026, 6, 20) },
];

export const roleIdentities: RoleIdentity[] = [
  { id: uuid(401), jobRoleId: JR.sdr, label: "Sales team", address: "sales@northwind.example", connectionId: uuid(501), signature: "The Northwind sales team" },
  { id: uuid(402), jobRoleId: JR.ap, label: "Accounts payable", address: "ap@northwind.example", connectionId: uuid(503), signature: "Northwind accounts payable" },
  { id: uuid(403), jobRoleId: JR.recruiter, label: "Recruiting", address: "recruiting@northwind.example", connectionId: uuid(507), signature: "Northwind recruiting" },
];

// Workflows. `monthly` is saved seconds per month May..October 2026 (October is month to date).
export const MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"] as const;

export interface WorkflowSpec {
  n: number;
  name: string;
  state: Workflow["state"];
  jobRoleId: string | null;
  departmentId: string | null;
  grade: Grade | null;
  versions: number;
  proposedBy: number;
  monthly: number[];
  cloudShare: number;
  overnightShare: number;
  users: number;
  secondsPerRun: number;
  failRate: number;
}

const h = (hours: number) => Math.round(hours * 3600);
export const WORKFLOW_SPECS: WorkflowSpec[] = [
  { n: 301, name: "Follow up on demo requests", state: "role", jobRoleId: JR.sdr, departmentId: DEPT.sales, grade: "A", versions: 3, proposedBy: 2, monthly: [h(18), h(31), h(44), h(52), h(61), h(49)], cloudShare: 0.7, overnightShare: 0.45, users: 8, secondsPerRun: 1260, failRate: 0.04 },
  { n: 302, name: "Log call notes to the CRM", state: "role", jobRoleId: JR.ae, departmentId: DEPT.sales, grade: "B", versions: 2, proposedBy: 10, monthly: [h(6), h(9), h(14), h(17), h(19), h(16)], cloudShare: 0, overnightShare: 0, users: 5, secondsPerRun: 540, failRate: 0.06 },
  { n: 303, name: "Match invoices to purchase orders", state: "role", jobRoleId: JR.ap, departmentId: DEPT.finance, grade: "A", versions: 2, proposedBy: 17, monthly: [h(12), h(20), h(27), h(33), h(38), h(32)], cloudShare: 0.85, overnightShare: 0.6, users: 6, secondsPerRun: 1800, failRate: 0.03 },
  { n: 304, name: "Chase overdue supplier statements", state: "role", jobRoleId: JR.ap, departmentId: DEPT.finance, grade: "C", versions: 1, proposedBy: 19, monthly: [0, h(3), h(6), h(8), h(9), h(8)], cloudShare: 0.5, overnightShare: 0.3, users: 5, secondsPerRun: 900, failRate: 0.08 },
  { n: 305, name: "Weekly shipment status email", state: "role", jobRoleId: JR.ops, departmentId: DEPT.ops, grade: "A", versions: 4, proposedBy: 26, monthly: [h(9), h(14), h(16), h(21), h(24), h(20)], cloudShare: 0.9, overnightShare: 0.8, users: 9, secondsPerRun: 2400, failRate: 0.02 },
  { n: 306, name: "Schedule candidate interviews", state: "role", jobRoleId: JR.recruiter, departmentId: DEPT.people, grade: "B", versions: 2, proposedBy: 36, monthly: [h(4), h(7), h(11), h(13), h(15), h(12)], cloudShare: 0.2, overnightShare: 0.1, users: 6, secondsPerRun: 720, failRate: 0.05 },
  { n: 307, name: "Contract renewal reminders", state: "role", jobRoleId: JR.counsel, departmentId: DEPT.legal, grade: "B", versions: 1, proposedBy: 41, monthly: [0, h(2), h(3), h(4), h(4), h(3)], cloudShare: 0.5, overnightShare: 0.2, users: 3, secondsPerRun: 600, failRate: 0.05 },
  { n: 308, name: "Meeting room issue triage", state: "role", jobRoleId: JR.fac, departmentId: DEPT.facilities, grade: "C", versions: 1, proposedBy: 44, monthly: [0, 0, h(1), h(2), h(3), h(2)], cloudShare: 0, overnightShare: 0, users: 4, secondsPerRun: 300, failRate: 0.1 },
  { n: 309, name: "Draft LinkedIn connection notes", state: "proposed", jobRoleId: null, departmentId: null, grade: null, versions: 1, proposedBy: 3, monthly: [0, 0, 0, 0, 0, 0], cloudShare: 0, overnightShare: 0, users: 1, secondsPerRun: 400, failRate: 0 },
  { n: 310, name: "Expense receipt reminders", state: "proposed", jobRoleId: null, departmentId: null, grade: "B", versions: 1, proposedBy: 20, monthly: [0, 0, 0, 0, 0, 0], cloudShare: 0, overnightShare: 0, users: 1, secondsPerRun: 480, failRate: 0 },
  { n: 311, name: "Quarterly report export", state: "retired", jobRoleId: JR.controller, departmentId: DEPT.finance, grade: "B", versions: 2, proposedBy: 14, monthly: [h(2), h(1), 0, 0, 0, 0], cloudShare: 0, overnightShare: 0, users: 2, secondsPerRun: 3600, failRate: 0 },
  { n: 312, name: "Auto-reply to every inbound lead", state: "declined", jobRoleId: null, departmentId: null, grade: null, versions: 1, proposedBy: 7, monthly: [0, 0, 0, 0, 0, 0], cloudShare: 0, overnightShare: 0, users: 1, secondsPerRun: 200, failRate: 0 },
];

export const WF = Object.fromEntries(WORKFLOW_SPECS.map((w) => [w.n, uuid(w.n)])) as Record<number, string>;

export const workflows: Workflow[] = WORKFLOW_SPECS.map((w) => ({
  id: uuid(w.n),
  name: w.name,
  state: w.state,
  jobRoleId: w.jobRoleId,
  departmentId: w.departmentId,
  latestVersion: w.versions,
  proposedBy: byIndex(w.proposedBy).id,
  promotedBy: w.state === "role" || w.state === "retired" ? byIndex(34).id : null,
  promotedAt: w.state === "role" || w.state === "retired" ? Date.UTC(2026, 4, 1 + (w.n % 20)) : null,
  baselineGrade: w.grade,
  versions: Array.from({ length: w.versions }, (_, i) => ({
    version: i + 1,
    definitionHash: hex64(`def:${w.n}:${i + 1}`),
    createdAt: Date.UTC(2026, 4 + i, 2 + (w.n % 20)),
    createdBy: byIndex(i === 0 ? w.proposedBy : 34).id,
  })),
}));

function stepsFor(w: WorkflowSpec): WorkflowStep[] {
  const company = (id: number, kind: Connection["kind"], label: string) =>
    ({ kind, ownership: "company" as const, connectionId: uuid(id), label });
  switch (w.n) {
    case 301:
      return [
        { id: "read-requests", title: "Read new demo requests", detail: "Form submissions from the last day.", class: "read", capability: "crm.read", connection: company(502, "crm", "HubSpot (company)"), gate: "none" },
        { id: "draft-followups", title: "Draft a follow-up for each", detail: "Uses the team's approved template and the request's product line.", class: "draft", capability: "mail.draft", connection: null, gate: "none" },
        { id: "send-followups", title: "Send from sales@", detail: "Sends only after approval, or under the overnight policy.", class: "commit", capability: "mail.send", connection: company(501, "google_workspace_shared", "sales@ shared mailbox"), gate: "overnight_policy" },
      ];
    case 303:
      return [
        { id: "read-invoices", title: "Read new invoices", detail: "PDF invoices that arrived in ap@.", class: "read", capability: "mail.read", connection: company(503, "m365_shared_mailbox", "ap@ shared mailbox"), gate: "none" },
        { id: "match", title: "Match to purchase orders", detail: "Compares totals, lines and supplier ids.", class: "draft", capability: "sheet.read", connection: company(504, "composio_org", "Google Sheets (company)"), gate: "none" },
        { id: "record", title: "Record matches", detail: "Writes one row per matched invoice.", class: "commit", capability: "sheet.append", connection: company(504, "composio_org", "Google Sheets (company)"), gate: "approval" },
      ];
    case 309:
      return [
        { id: "read-leads", title: "Read this week's new leads", detail: "From the CRM view the proposer uses.", class: "read", capability: "crm.read", connection: { kind: "crm", ownership: "company", connectionId: uuid(502), label: "HubSpot (company)" }, gate: "none" },
        { id: "draft-notes", title: "Draft a connection note per lead", detail: "Short and specific to the lead's company.", class: "draft", capability: "text.draft", connection: null, gate: "none" },
        { id: "send-invites", title: "Send connection requests", detail: "From the proposer's own LinkedIn profile.", class: "commit", capability: "linkedin.invite", connection: { kind: "linkedin_personal", ownership: "personal-forbidden", connectionId: uuid(506), label: "LinkedIn (personal)" }, gate: "approval" },
      ];
    case 310:
      return [
        { id: "read-expenses", title: "Find expenses missing a receipt", detail: "From the expense sheet.", class: "read", capability: "sheet.read", connection: { kind: "gmail", ownership: "personal-allowed", connectionId: uuid(505), label: "Personal Gmail" }, gate: "none" },
        { id: "draft-reminders", title: "Draft a reminder per person", detail: "Lists the missing receipts.", class: "draft", capability: "mail.draft", connection: null, gate: "none" },
        { id: "send-reminders", title: "Send reminders", detail: "One email per person.", class: "commit", capability: "mail.send", connection: { kind: "gmail", ownership: "personal-allowed", connectionId: uuid(505), label: "Personal Gmail" }, gate: "approval" },
      ];
    default:
      return [
        { id: "read", title: "Collect what changed", detail: "Reads the sources this workflow needs.", class: "read", capability: "data.read", connection: company(502, "crm", "HubSpot (company)"), gate: "none" },
        { id: "draft", title: "Prepare the update", detail: "Drafts the message or rows.", class: "draft", capability: "text.draft", connection: null, gate: "none" },
        { id: "commit", title: "Send or write it", detail: "Only after approval.", class: "commit", capability: "mail.send", connection: company(501, "google_workspace_shared", "sales@ shared mailbox"), gate: "approval" },
      ];
  }
}

export function definitionFor(workflowId: string, version: number): WorkflowDefinition | undefined {
  const w = WORKFLOW_SPECS.find((s) => uuid(s.n) === workflowId);
  if (!w || version < 1 || version > w.versions) return undefined;
  const steps = stepsFor(w);
  return {
    id: ulid(w.n * 10 + version),
    kind: "workflow_proposal",
    createdAt: Date.UTC(2026, 4 + version - 1, 2 + (w.n % 20)),
    localWorkflowId: `wf_${w.n}`,
    workflowId: w.state === "proposed" ? null : uuid(w.n),
    version: w.state === "proposed" ? null : version,
    name: w.name,
    description: `${w.name}. Version ${version}.`,
    trigger: w.n === 305 ? { type: "cron", cron: "0 7 * * 1", timezone: TIMEZONE } : { type: "manual", cron: null, timezone: null },
    steps,
    skillMd: [
      `# ${w.name}`,
      "",
      "## When to run",
      w.n === 305 ? "Every Monday at 07:00." : "When there is new work in the source.",
      "",
      "## Steps",
      ...steps.map((s, i) => `${i + 1}. ${s.title}. ${s.detail}`),
      "",
      "## Rules",
      "- Nothing is sent without approval or a matching overnight policy.",
      "- Keep messages short and in the team's voice.",
    ].join("\n"),
    factsKeys: ["team_name", "signature"],
    limits: { maxItemsPerRun: 50, maxRunsPerDay: 4 },
    definitionHash: hex64(`def:${w.n}:${version}`),
  };
}

export function sopMarkdown(workflowId: string, version: number): string | undefined {
  const d = definitionFor(workflowId, version);
  const w = workflows.find((x) => x.id === workflowId);
  if (!d || !w) return undefined;
  const role = jobRoles.find((j) => j.id === w.jobRoleId)?.name ?? "Not assigned yet";
  return [
    `# SOP: ${d.name} (version ${version})`,
    "",
    `Owner: ${role}`,
    `Definition: ${d.definitionHash.slice(0, 12)}`,
    "",
    "## Purpose",
    d.description,
    "",
    "## Steps",
    ...d.steps.map((s, i) => `${i + 1}. **${s.title}** (${s.class}${s.connection ? `, ${s.connection.label}, ${s.connection.ownership}` : ""}). ${s.detail}`),
    "",
    "## Limits",
    `- At most ${d.limits.maxItemsPerRun} items per run, ${d.limits.maxRunsPerDay} runs a day.`,
    "",
    "This SOP contains no tokens, recipients or message content.",
  ].join("\n");
}

const field = (a: string, b: string): [string, string] => [a, b];
export const batches: Batch[] = [
  {
    batchHash: hex64("batch:1"), workflowId: uuid(301), version: 3, runId: ulid(9001), runtime: "cloud",
    identity: { type: "role_identity", id: uuid(401) }, state: "pending", createdAt: NOW - 3 * 3600_000, expiresAt: NOW + 21 * 3600_000,
    items: ["Harbor Logistics", "Pine & Co", "Atlas Foods", "Kestrel Labs", "Brightline Retail", "Oakmont Clinics"].map((co, i) => ({
      key: `lead-${i + 1}`, capability: "mail.send",
      fields: [field("To", `buyer${i + 1}@${co.toLowerCase().replace(/[^a-z]/g, "")}.example`), field("Subject", `Your demo request, ${co}`),
        field("Body", `Hi,\n\nThanks for asking about a demo for ${co}. Tuesday or Thursday afternoon both work on our side. Which suits you?\n\nThe Northwind sales team`)],
      itemHash: hex64(`item:1:${i}`), state: "pending" as const,
    })),
    overnightEvaluation: { policyId: uuid(901), result: "queue", reason: "Two recipients are outside the allowlist." },
  },
  {
    batchHash: hex64("batch:2"), workflowId: uuid(303), version: 2, runId: ulid(9002), runtime: "cloud",
    identity: { type: "role_identity", id: uuid(402) }, state: "pending", createdAt: NOW - 5 * 3600_000, expiresAt: NOW + 19 * 3600_000,
    items: [["INV-20931", "PO-7731", "1,240.00"], ["INV-20932", "PO-7740", "86.50"], ["INV-20940", "PO-7702", "4,410.00"], ["INV-20951", "PO-7755", "312.75"]].map(([inv, po, amt], i) => ({
      key: inv!, capability: "sheet.append",
      fields: [field("Invoice", inv!), field("Purchase order", po!), field("Amount (USD)", amt!)],
      itemHash: hex64(`item:2:${i}`), state: "pending" as const,
    })),
    overnightEvaluation: null,
  },
  {
    batchHash: hex64("batch:3"), workflowId: uuid(305), version: 4, runId: ulid(9003), runtime: "mac",
    identity: { type: "person", id: ME.id }, state: "pending", createdAt: NOW - 50 * 60_000, expiresAt: NOW + 23 * 3600_000,
    items: [{ key: "weekly-status", capability: "mail.send", fields: [field("To", "ops-all@northwind.example"), field("Subject", "Shipments this week"), field("Body", "12 shipments left the warehouse, 2 are delayed at customs. Details in the sheet.")], itemHash: hex64("item:3:0"), state: "pending" }],
    overnightEvaluation: null,
  },
];

export const killSwitches: KillSwitch[] = [
  { scope: "workflow", targetId: uuid(304), active: false, setBy: byIndex(15).id, setAt: NOW - 9 * DAY_MS, reason: "Supplier asked us to pause reminders during their audit." },
];

export const overnightPolicies: OvernightPolicy[] = [
  {
    id: uuid(901), workflowId: uuid(301), version: 3, mode: "preapproved",
    recipients: { emails: [], domains: ["harborlogistics.example", "atlasfoods.example"], repliesToThreadsStartedByIdentity: true },
    templateHash: hex64("template:301"), maxCommitsPerNight: 40, maxPerRecipientPerWeek: 2,
    sendWindow: { startHour: 7, endHour: 9, days: [1, 2, 3, 4, 5], recipientTimezone: true }, attachmentsAllowed: false,
    budgetCentsPerNight: 800, dryRunNights: 5, dryRunNightsDone: 5,
    circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 3 }, state: "active", trippedReason: null, ownerPersonId: byIndex(0).id,
  },
  {
    id: uuid(902), workflowId: uuid(305), version: 4, mode: "drafts_only",
    recipients: { emails: ["ops-all@northwind.example"], domains: [], repliesToThreadsStartedByIdentity: false },
    templateHash: null, maxCommitsPerNight: 0, maxPerRecipientPerWeek: 1,
    sendWindow: { startHour: 6, endHour: 8, days: [1], recipientTimezone: false }, attachmentsAllowed: false,
    budgetCentsPerNight: 300, dryRunNights: 3, dryRunNightsDone: 3,
    circuitBreakers: { bounceRatePct: 5, negativeReplySpike: 3, consecutiveFailures: 3 }, state: "tripped", trippedReason: "Three failures in a row reading the shipment sheet.", ownerPersonId: ME.id,
  },
];

export function rolePolicyFor(jobRoleId: string): RolePolicy {
  return {
    jobRoleId, allowedCapabilities: ["mail.read", "mail.draft", "mail.send", "crm.read", "sheet.read", "sheet.append"],
    approvers: jobRoleId === JR.ap ? "dept_lead" : "runner_or_dept_lead", sessionBudgetCents: 500, dailyBudgetCents: 4000,
    maxItemsPerBatch: 50, models: { design: "claude-opus-5-5", steps: "claude-sonnet-5-5" }, updatedAt: Date.UTC(2026, 8, 3), updatedBy: byIndex(34).id,
  };
}

export const workers: Worker[] = [
  { id: uuid(601), workflowId: uuid(301), version: 3, jobRoleId: JR.sdr, identityId: uuid(401), state: "ready", schedule: { cron: "30 5 * * 1-5", timezone: TIMEZONE, nextRunAt: NOW + 20 * 3600_000 }, sessionBudgetCents: 500, externalRefs: { agentId: "agent_01sdr", agentVersion: 3, environmentId: "env_01sdr", deploymentId: "dep_01sdr" }, createdAt: Date.UTC(2026, 6, 1) },
  { id: uuid(602), workflowId: uuid(303), version: 2, jobRoleId: JR.ap, identityId: uuid(402), state: "ready", schedule: { cron: "0 5 * * 1-5", timezone: TIMEZONE, nextRunAt: NOW + 19 * 3600_000 }, sessionBudgetCents: 800, externalRefs: { agentId: "agent_01ap", agentVersion: 2, environmentId: "env_01ap", deploymentId: "dep_01ap" }, createdAt: Date.UTC(2026, 6, 8) },
  { id: uuid(603), workflowId: uuid(305), version: 4, jobRoleId: JR.ops, identityId: ME.id, state: "paused", schedule: { cron: "0 6 * * 1", timezone: TIMEZONE, nextRunAt: null }, sessionBudgetCents: 300, externalRefs: { agentId: "agent_01ops", agentVersion: 4, environmentId: "env_01ops", deploymentId: null }, createdAt: Date.UTC(2026, 7, 2) },
  { id: uuid(604), workflowId: uuid(306), version: 2, jobRoleId: JR.recruiter, identityId: uuid(403), state: "provisioning", schedule: null, sessionBudgetCents: 400, externalRefs: { agentId: "agent_01rec", agentVersion: 1, environmentId: "env_01rec", deploymentId: null }, createdAt: NOW - 2 * 3600_000 },
];

export const workerRuns: WorkerRun[] = [];
{
  const states: WorkerRun["state"][] = ["done", "done", "waiting_approval", "failed", "done", "capped"];
  workers.forEach((wk, wi) => {
    if (wk.state === "provisioning") return;
    for (let r = 0; r < 5; r++) {
      const st = wi === 2 && r === 0 ? "failed" : states[(r + wi) % states.length]!;
      const startedAt = NOW - (r + 1) * DAY_MS + 5.5 * 3600_000 - 9 * 3600_000;
      const done = st !== "waiting_approval";
      workerRuns.push({
        id: ulid(8000 + wi * 10 + r), workerId: wk.id, trigger: r === 3 ? "manual" : "schedule", startedAt,
        endedAt: done ? startedAt + (11 + r * 3) * 60_000 : null, state: st,
        stopReason: st === "done" ? "end_turn" : st === "waiting_approval" ? "requires_action" : st === "capped" ? "budget_reached" : "error",
        costCents: st === "capped" ? wk.sessionBudgetCents : 90 + ((wi * 37 + r * 53) % 240),
        batchHashes: st === "failed" ? [] : [hex64(`run-batch:${wi}:${r}`)],
        summary: st === "done" ? `Drafted ${6 + r} items; all sent after approval.` : st === "waiting_approval" ? "Drafted the batch; it waits for approval." : st === "capped" ? "Stopped at the session budget before finishing." : "The source sheet could not be read (connection failed).",
        sessionRef: `sesn_${wi}${r}`,
      });
    }
  });
}

export const handovers: Handover[] = [
  { id: uuid(801), personId: LEAVING.id, workflowId: uuid(301), state: "open", successor: null, inFlight: "pause", inboxStep: null, removedConnections: [], assignedBy: null, assignedAt: null },
  { id: uuid(802), personId: LEAVING.id, workflowId: uuid(302), state: "assigned", successor: { type: "person", personId: byIndex(11).id }, inFlight: "handover_message", inboxStep: "google_alias", removedConnections: [], assignedBy: byIndex(0).id, assignedAt: NOW - 2 * DAY_MS },
  { id: uuid(803), personId: FROZEN.id, workflowId: uuid(303), state: "open", successor: null, inFlight: "pause", inboxStep: null, removedConnections: [uuid(505)], assignedBy: null, assignedAt: null },
  { id: uuid(804), personId: FROZEN.id, workflowId: uuid(304), state: "closed", successor: { type: "role_identity", roleIdentityId: uuid(402) }, inFlight: "stop", inboxStep: "m365_shared_mailbox", removedConnections: [], assignedBy: byIndex(15).id, assignedAt: NOW - 6 * DAY_MS },
];

export const notices: Notice[] = [
  { id: uuid(701), version: 1, title: "Offload at Northwind: what we measure", markdown: "## What Offload records\n\nOffload runs on your Mac and keeps what it observes there for 7 days.\n\n## What the company sees\n\nOnly totals for groups of 5 or more people, and the workflows your team shares.", features: ["workflow_metrics"], jurisdictions: ["CA-ON", "CA-QC", "CA-BC", "US-NY", "US-CA", "GB", "DE"], publishedAt: Date.UTC(2026, 3, 10), replacedAt: Date.UTC(2026, 6, 1), template: "ca-on-esa-policy", acks: 41 },
  { id: uuid(702), version: 2, title: "Offload at Northwind: what we measure", markdown: "## What Offload records\n\nOffload runs on your Mac and keeps what it observes there for 7 days. Raw activity never leaves your Mac.\n\n## What the company sees\n\nHours saved per workflow, team and department, only for groups of 5 or more people. Per-person views and working time are off.\n\n## Who sees what\n\nOwners, admins and auditors see company totals. Department leads see their departments.\n\n## How to pause\n\nUse Pause watching in the Offload menu at any time.", features: ["workflow_metrics"], jurisdictions: ["CA-ON", "CA-QC", "CA-BC", "US-NY", "US-CA", "GB", "DE"], publishedAt: Date.UTC(2026, 6, 1), replacedAt: null, template: "ca-on-esa-policy", acks: 0 },
  { id: uuid(703), version: 3, title: "Offload at Northwind: per-person views", markdown: "## What changes\n\nIf turned on, owners and admins could see your own hours saved per workflow. Nobody is ranked. You can see every time someone looks.\n\n## Purpose\n\nProcess improvement only. Not used for pay, discipline or dismissal.", features: ["workflow_metrics", "per_person_views"], jurisdictions: ["CA-ON", "GB"], publishedAt: null, replacedAt: null, template: "uk-eu-transparency", acks: 0 },
];
notices[1]!.acks = people.filter((p) => p.noticeAckVersionId === uuid(702)).length;

export const templates = [
  { id: "ca-on-esa-policy", title: "Ontario electronic monitoring policy", jurisdictions: ["CA-ON"] },
  { id: "us-ny-notice-ack", title: "New York monitoring notice and acknowledgment", jurisdictions: ["US-NY"] },
  { id: "ca-qc-8-1", title: "Quebec notice (sections 8.1 and 8.2)", jurisdictions: ["CA-QC"] },
  { id: "us-ca-notice-at-collection", title: "California notice at collection", jurisdictions: ["US-CA"] },
  { id: "uk-eu-transparency", title: "UK and EU transparency notice", jurisdictions: ["GB", "DE"] },
  { id: "de-daily-notice", title: "Germany daily notice (works council)", jurisdictions: ["DE"] },
];

export const devices: Device[] = people.filter((p) => p.state !== "departed").slice(0, 40).map((p, i) => ({
  id: uuid(3000 + i), personId: p.id, name: `${p.displayName.split(" ")[0]}'s MacBook`, appVersion: i % 6 === 0 ? "1.4.0" : "1.5.2",
  enrolledAt: Date.UTC(2026, 5, 1 + (i % 28)), lastSyncAt: p.state === "frozen" ? null : NOW - ((i * 17) % 300) * 60_000,
  state: p.state === "frozen" ? "revoked" : "active",
}));

// A small hash-chained audit log. Hashes are fixture stand-ins chained the same way as ADR 0108 §5.
export const auditLog: AuditEvent[] = [];
{
  const admin = byIndex(34);
  const rows: Omit<AuditEvent, "id" | "prevHash" | "hash">[] = [
    { at: NOW - 12 * DAY_MS, actor: { type: "person", id: admin.id, accessRole: "admin" }, action: "workflow.promote", subjectPersonId: null, resource: { type: "workflow", id: uuid(305) }, detail: { version: 4 } },
    { at: NOW - 9 * DAY_MS, actor: { type: "person", id: byIndex(15).id, accessRole: "dept_lead" }, action: "kill_switch.set", subjectPersonId: null, resource: { type: "workflow", id: uuid(304) }, detail: { scope: "workflow" } },
    { at: NOW - 8 * DAY_MS, actor: { type: "person", id: byIndex(15).id, accessRole: "dept_lead" }, action: "kill_switch.clear", subjectPersonId: null, resource: { type: "workflow", id: uuid(304) }, detail: {} },
    { at: NOW - 7 * DAY_MS, actor: { type: "person", id: admin.id, accessRole: "admin" }, action: "person.offboard", subjectPersonId: FROZEN.id, resource: { type: "person", id: FROZEN.id }, detail: { state: "frozen" } },
    { at: NOW - 6 * DAY_MS, actor: { type: "person", id: admin.id, accessRole: "admin" }, action: "person.read", subjectPersonId: ME.id, resource: { type: "person", id: ME.id }, detail: { fields: "directory" } },
    { at: NOW - 5 * DAY_MS, actor: { type: "person", id: byIndex(0).id, accessRole: "dept_lead" }, action: "batch.approve", subjectPersonId: null, resource: { type: "batch", id: hex64("batch:old").slice(0, 16) }, detail: { items: 7 } },
    { at: NOW - 4 * DAY_MS, actor: { type: "system", id: null, accessRole: null }, action: "overnight_policy.trip", subjectPersonId: null, resource: { type: "overnight_policy", id: uuid(902) }, detail: { reason: "consecutive_failures" } },
    { at: NOW - 3 * DAY_MS, actor: { type: "person", id: admin.id, accessRole: "admin" }, action: "notice.create", subjectPersonId: null, resource: { type: "notice", id: uuid(703) }, detail: { version: 3 } },
    { at: NOW - 2 * DAY_MS, actor: { type: "person", id: byIndex(14).id, accessRole: "auditor" }, action: "audit.verify", subjectPersonId: null, resource: { type: "audit_log", id: null }, detail: { ok: true } },
    { at: NOW - 1 * DAY_MS, actor: { type: "person", id: ME.id, accessRole: "owner" }, action: "self.export", subjectPersonId: ME.id, resource: { type: "self_view", id: null }, detail: {} },
  ];
  let prev: string | null = null;
  rows.forEach((r, i) => {
    const hash = hex64(`audit:${i}:${prev ?? "genesis"}:${r.action}`);
    auditLog.push({ id: ulid(7000 + i), prevHash: prev, hash, ...r });
    prev = hash;
  });
}

export { hex32 };
