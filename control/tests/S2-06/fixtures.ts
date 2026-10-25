import type { Principal } from "../../src/app.ts";
import { withTenant } from "../../src/db/tenant.ts";
import { ulid } from "../../src/schema/encoding.ts";
import registry from "../../src/modules/registry/index.ts";
import { definitionHash } from "../../src/modules/registry/hash.ts";
import type { Definition } from "../../src/modules/registry/types.ts";
import type { Harness } from "../helpers/harness.ts";
import type { PersonKey, SeededTenant } from "../helpers/seed.ts";

/** Personal values planted in the proposal fixture. None of them may survive promotion (STRIP). */
export const PERSONAL = [
  "Acme Robotics",
  "calendly.com/jane-doe",
  "jane.doe@acme-capital.com",
  "sam@vc-partners.example",
  "Sam Patel",
  "+1 416 555 0199",
  "loved your last fund letter",
  "Cheers, Jane",
];

export const SKILL_MD = [
  "---",
  "name: investor-outreach",
  "description: Intro emails to new investor leads",
  "connectors: [gmail, sheets, linkedin]",
  "gates: [review]",
  "---",
  "",
  "# Investor outreach",
  "",
  "## What this does",
  "Writes one short intro email per new investor lead and logs it. Questions go to jane.doe@acme-capital.com.",
  "",
  "## Steps",
  "1. **Read new leads** (Google Sheets). Read the rows added since the last run.",
  "2. **Draft the intro**. One email per lead from facts.md.",
  "3. **Send the intro** (Gmail). Send exactly the approved text.",
  "",
  "## Rules",
  "- Nothing is sent before the review step approves the exact batch.",
  "- Drafts state only what is in facts.md. Gaps show as [missing: ...].",
  "- company_name: Acme Robotics",
  "- Book calls via https://calendly.com/jane-doe/intro or call +1 416 555 0199.",
  "",
  "## Facts",
  "- company_name: Acme Robotics",
  "- calendly_link: https://calendly.com/jane-doe/intro",
  "",
  "## Tone examples",
  "Hi Sam, loved your last fund letter. Cheers, Jane",
  "",
  "## Recipients",
  "- Sam Patel <sam@vc-partners.example>",
  "",
].join("\n");

export type ProposalObject = Definition & { id: string; kind: "workflow_proposal"; createdAt: number; definitionHash: string };

/** A proposal as the Mac sends it (kind workflow_proposal), with a correct definitionHash unless `hash` is given. */
export function proposal(over: Partial<Definition> = {}, meta: { createdAt?: number; hash?: string } = {}): ProposalObject {
  const def: Definition = {
    localWorkflowId: "wf_investor_outreach",
    workflowId: null,
    version: null,
    name: "Investor outreach",
    description: "Write a short intro email to each new investor lead and log it. Ask jane.doe@acme-capital.com for the list.",
    trigger: { type: "cron", cron: "0 9 * * 1", timezone: "America/Toronto" },
    steps: [
      {
        id: "read_leads",
        title: "Read new leads",
        detail: "Read the rows added to the leads sheet since the last run.",
        class: "read",
        capability: "sheet.read",
        connection: { kind: "gmail", ownership: "personal-allowed", connectionId: null, label: "Google Sheets" },
        gate: "none",
      },
      {
        id: "draft_intro",
        title: "Draft the intro",
        detail: "Draft one email per lead from facts.md. Call +1 416 555 0199 if unsure.",
        class: "draft",
        capability: "text.draft",
        connection: null,
        gate: "none",
      },
      {
        id: "send_intro",
        title: "Send the intro",
        detail: "Send each approved email exactly as approved.",
        class: "commit",
        capability: "mail.send",
        connection: { kind: "gmail", ownership: "personal-allowed", connectionId: null, label: "Gmail" },
        gate: "approval",
      },
      {
        id: "post_linkedin",
        title: "Post on LinkedIn",
        detail: "Share a short post about the new lead.",
        class: "commit",
        capability: "linkedin.post",
        connection: { kind: "linkedin_personal", ownership: "personal-forbidden", connectionId: null, label: "LinkedIn" },
        gate: "approval",
      },
    ],
    skillMd: SKILL_MD,
    factsKeys: ["calendly_link", "company_name"],
    limits: { maxItemsPerRun: 20, maxRunsPerDay: 1 },
    ...over,
  };
  const createdAt = meta.createdAt ?? Date.UTC(2026, 9, 26, 8, 0, 0);
  return { id: ulid(createdAt), kind: "workflow_proposal", createdAt, ...def, definitionHash: meta.hash ?? definitionHash(def) };
}

/** The device principal of a seeded person (what the ingest slice passes to sync handlers). */
export function devicePrincipal(t: SeededTenant, who: PersonKey): Principal {
  const p = t.people[who];
  return {
    kind: "device",
    tenantId: t.id,
    personId: p.id,
    deviceId: crypto.randomUUID(),
    accessRole: p.role as Principal["accessRole"],
    departmentScope: who === "lead" ? [t.departments.sales] : [],
    jurisdiction: "CA-ON",
  };
}

/** Runs the module's `workflow_proposal` sync handler in a tenant transaction, as the ingest slice will. */
export async function ingest(h: Harness, who: PersonKey, obj: unknown, t: SeededTenant = h.a): Promise<void> {
  const principal = devicePrincipal(t, who);
  const handler = registry.syncHandlers!.workflow_proposal!;
  await withTenant(
    h.db.app,
    { tenantId: t.id, principalId: principal.kind === "device" ? principal.deviceId : null, principalPersonId: principal.personId, accessRole: principal.accessRole },
    (tx) => handler(tx, obj, { principal, deps: h.deps }),
  );
}

/** The workflow id a proposal object landed in. */
export async function workflowIdOf(h: Harness, obj: { localWorkflowId: string; definitionHash: string }, t: SeededTenant = h.a): Promise<string> {
  const [r] = await h.db.migrator`select id from workflows where tenant_id = ${t.id}
    and local_workflow_id = ${obj.localWorkflowId} and proposal_hash = ${obj.definitionHash}`;
  if (!r) throw new Error("proposal not stored");
  return r.id as string;
}

/** Ingests a fresh proposal by `who` (a distinct localWorkflowId each call) and returns its workflow id. */
let seq = 0;
export async function propose(h: Harness, who: PersonKey = "member", over: Partial<Definition> = {}, t: SeededTenant = h.a): Promise<{ id: string; obj: ProposalObject }> {
  const obj = proposal({ localWorkflowId: `wf_${++seq}_${Date.now() % 100000}`, ...over });
  await ingest(h, who, obj, t);
  return { id: await workflowIdOf(h, obj, t), obj };
}

export interface ExtraConnections {
  forbidden: string;
  linkedinPersonal: string;
  companyPage: string;
}

/** Connections beyond the seed: a personal-forbidden mailbox, a personal LinkedIn and a Company Page. */
export async function seedConnections(h: Harness, t: SeededTenant = h.a): Promise<ExtraConnections> {
  const conn = async (kind: string, ownership: string, label: string) =>
    ((await h.db.migrator`insert into connections (tenant_id, kind, ownership, label, provider, external_ref)
      values (${t.id}, ${kind}, ${ownership}, ${label}, 'composio', ${`ref_secret_${kind}`}) returning id`)[0]!.id as string);
  return {
    forbidden: await conn("gmail", "personal-forbidden", "Jane's private Gmail"),
    linkedinPersonal: await conn("linkedin_personal", "personal-forbidden", "Jane's LinkedIn"),
    companyPage: await conn("company_linkedin_page", "company", "Acme Company Page"),
  };
}

/** A promote body that binds the fixture's connection steps to the seeded company mailbox and disables LinkedIn. */
export interface Binding {
  stepId: string;
  connectionId: string | null;
  disable: boolean;
}

export function promoteBody(t: SeededTenant, over: Partial<{ jobRoleId: string; departmentId: string; fromVersion: number; bindings: Binding[] }> = {}) {
  return {
    jobRoleId: t.jobRoles.sdr,
    departmentId: t.departments.sales,
    fromVersion: 1,
    bindings: <Binding[]>[
      { stepId: "read_leads", connectionId: t.connections.company, disable: false },
      { stepId: "send_intro", connectionId: t.connections.company, disable: false },
      { stepId: "post_linkedin", connectionId: null, disable: true },
    ],
    ...over,
  };
}

export async function holdJobRole(h: Harness, t: SeededTenant, jobRoleId: string, personId: string): Promise<void> {
  await h.db.migrator`insert into job_role_holders (tenant_id, job_role_id, person_id) values (${t.id}, ${jobRoleId}, ${personId})
    on conflict do nothing`;
}

/** Audit events of one action for a resource id, oldest first. */
export async function auditOf(h: Harness, action: string, resourceId: string, t: SeededTenant = h.a) {
  return h.db.migrator`select actor_type, actor_id, action, subject_person_id, resource_type, resource_id, detail
    from audit_events where tenant_id = ${t.id} and action = ${action} and resource_id = ${resourceId} order by seq`;
}

/** A new-version body built from a role version: same steps unless changed by `edit`, correct hash. */
export function versionBody(base: object, edit: (d: Definition) => void = () => {}) {
  const { id: _id, kind: _kind, createdAt: _c, definitionHash: _h, ...rest } = structuredClone(base) as unknown as ProposalObject;
  const def = rest as Definition;
  def.version = typeof def.version === "number" ? def.version + 1 : null;
  edit(def);
  return { id: ulid(), kind: "workflow_proposal" as const, createdAt: Date.UTC(2026, 9, 27), ...def, definitionHash: definitionHash(def) };
}
