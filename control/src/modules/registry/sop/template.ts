/**
 * SOP export (ADR 0104 §7): a deterministic Markdown template over one role workflow version. Same input, same bytes:
 * no clock, no randomness, no model, and no connection ids, external refs or secrets (connections appear by label).
 */
import { mask } from "../strip.ts";
import type { ConnectionKind, Definition, Step, WorkflowState } from "../types.ts";

export interface SopInput {
  workflow: { id: string; name: string; state: WorkflowState; latestVersion: number };
  jobRole: { name: string };
  department: { name: string };
  /** The version rendered, and its definition. */
  version: number;
  definition: Definition;
  /** Every version of the workflow, any order. */
  history: Array<{ version: number; definitionHash: string; createdAt: number }>;
}

const KIND: Record<ConnectionKind, string> = {
  gmail: "Gmail",
  google_workspace_shared: "Google Workspace shared mailbox",
  outlook: "Outlook",
  m365_shared_mailbox: "Microsoft 365 shared mailbox",
  composio_org: "company app connection",
  company_mcp: "company MCP server",
  api: "API",
  crm: "CRM",
  company_linkedin_page: "LinkedIn Company Page",
  linkedin_personal: "personal LinkedIn",
  other: "other connection",
};

const CLASS: Record<Step["class"], string> = {
  read: "Reads",
  draft: "Drafts (nothing leaves before review)",
  commit: "Commits (sends, posts or writes outside)",
};

const GATE: Record<Step["gate"], string> = {
  none: "no gate",
  approval: "waits for a person to approve the exact batch",
  overnight_policy: "runs unattended only under an approved overnight policy",
};

const OWNERSHIP: Record<string, string> = {
  company: "company connection",
  "personal-allowed": "the runner's own account",
  "personal-forbidden": "personal, not allowed",
};

/** One line of plain text: masked, whitespace collapsed. */
const line = (s: string): string => mask(s).replace(/\s+/g, " ").trim();

function trigger(t: Definition["trigger"]): string {
  switch (t.type) {
    case "manual":
      return "Run by hand when needed.";
    case "cron":
      return t.cron === null ? "Runs on a schedule." : `Runs on a schedule: \`${line(t.cron)}\` (${line(t.timezone ?? "UTC")}).`;
    case "event":
      return "Runs when its triggering event arrives.";
  }
}

/** Bullet lines of the SKILL.md "Rules" sections (any heading level from 2). */
function skillRules(md: string): string[] {
  const out: string[] = [];
  let inRules = false;
  for (const raw of md.split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      inRules = h[1]!.length >= 2 && /^(decision )?rules\b/i.test(h[2]!.trim());
      continue;
    }
    const b = inRules ? /^\s*[-*]\s+(.*)$/.exec(raw) : null;
    if (b && line(b[1]!) !== "") out.push(line(b[1]!));
  }
  return out;
}

function stepLines(s: Step, n: number): string[] {
  const detail = line(s.detail);
  const conn = s.connection === null
    ? "no connection (runs on its own)"
    : `${line(s.connection.label) || KIND[s.connection.kind]} (${KIND[s.connection.kind]}, ${OWNERSHIP[s.connection.ownership]})`;
  return [
    `${n}. **${line(s.title)}**.${detail === "" ? "" : ` ${detail}`}`,
    `   - What it does: ${CLASS[s.class]}; capability \`${s.capability}\`.`,
    `   - Connection: ${conn}.`,
    `   - Gate: ${GATE[s.gate]}.`,
  ];
}

const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export function renderSop(i: SopInput): string {
  const d = i.definition;
  const steps = d.steps;
  const gated = steps.map((s, k) => ({ s, n: k + 1 })).filter(({ s }) => s.gate !== "none");
  const conns = new Map<string, number[]>();
  steps.forEach((s, k) => {
    if (s.connection === null) return;
    const key = `${line(s.connection.label) || KIND[s.connection.kind]} (${KIND[s.connection.kind]})`;
    conns.set(key, [...(conns.get(key) ?? []), k + 1]);
  });
  const facts = [...d.factsKeys].map(line).filter((k) => k !== "");
  const history = [...i.history].sort((a, b) => a.version - b.version);
  const out = [
    `# SOP: ${line(d.name)}`,
    "",
    `This SOP describes version ${i.version} of ${i.workflow.latestVersion}. Owner job role: ${line(i.jobRole.name)} (${line(i.department.name)}).` +
      (i.workflow.state === "retired" ? " This workflow is retired." : ""),
    "",
    "## Purpose",
    line(d.description) || "No purpose was written for this workflow.",
    "",
    "## Trigger",
    trigger(d.trigger),
    "",
    "## Steps",
    ...steps.flatMap((s, k) => stepLines(s, k + 1)),
    "",
    "## Rules",
    `- At most ${d.limits.maxItemsPerRun} items per run and ${d.limits.maxRunsPerDay} ${d.limits.maxRunsPerDay === 1 ? "run" : "runs"} per day.`,
    facts.length === 0
      ? "- Drafts use no stored facts."
      : `- Drafts may state only these facts (the values are kept by the job role, not in this SOP): ${facts.map((k) => `\`${k}\``).join(", ")}.`,
    ...skillRules(d.skillMd).map((r) => `- ${r}`),
    "- No commit step uses a personal-forbidden connection or a personal LinkedIn.",
    "",
    "## Gates",
    ...(gated.length === 0 ? ["- No step waits for a gate."] : gated.map(({ s, n }) => `- Step ${n} (${line(s.title)}): ${GATE[s.gate]}.`)),
    "",
    "## Connections",
    ...(conns.size === 0 ? ["- None."] : [...conns].map(([k, ns]) => `- ${k}: step${ns.length === 1 ? "" : "s"} ${ns.join(", ")}.`)),
    "",
    "## Owner",
    `- Job role: ${line(i.jobRole.name)}`,
    `- Department: ${line(i.department.name)}`,
    `- State: ${i.workflow.state === "retired" ? "retired" : "in use"}`,
    "",
    "## Version history",
    "| Version | Created (UTC) | Definition hash |",
    "|---|---|---|",
    ...history.map((v) => `| ${v.version} | ${utc(v.createdAt)} | \`${v.definitionHash.slice(0, 12)}\` |`),
    "",
  ];
  return out.join("\n");
}
