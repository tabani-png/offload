/**
 * What promotion removes (ADR 0104 §4): facts values (only factsKeys survive), recipient lists, tone examples and
 * anything that still looks like an address, link, host or phone number. Pure and deterministic: the same definition
 * always strips to the same bytes, and stripping a stripped definition changes nothing.
 */
import type { Definition, Step, StepConnection } from "./types.ts";

// The patterns of the Mac's projector (brain/src/sync/project/mask.ts), applied again on the server: a role workflow
// must be clean even if a device skipped or weakened its pass.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?|ftp|mailto|file):\/{0,2}[^\s)\]>"'`]+/gi;
const WWW_RE = /\bwww\.[^\s)\]>"'`]+/gi;
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
const LOCAL_FILES = new Set(["recipients.csv", "facts.md", "workflow.json", "skill.md"]);
const PHONE_RE = /\+?\d[\d ().-]{6,}\d/g;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Masks emails, links, host names and phone-like digit runs (at least 9 digits); drops control characters. */
export function mask(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[link]")
    .replace(WWW_RE, "[link]")
    .replace(HOST_RE, (m) => (LOCAL_FILES.has(m.toLowerCase()) ? m : "[host]"))
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m))
    .replace(CONTROL_RE, "");
}

const cut = (text: string, max: number): string => [...text].slice(0, max).join("");

/** SKILL.md sections that hold personal material: facts values, tone examples, recipients, contacts, signatures. */
const PERSONAL_SECTION = /\b(facts?|tone|examples?|samples?|recipients?|contacts?|signatures?|people|sent)\b/i;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** SKILL.md without personal sections, with `key: value` lines of facts keys reduced to `key: [fact]`, masked. */
export function stripSkillMd(md: string, factsKeys: readonly string[]): string {
  const keys = factsKeys.filter((k) => k.trim() !== "").map(escapeRe);
  const factLine = keys.length === 0 ? null : new RegExp(`^(\\s*(?:[-*]\\s+)?\`?(?:${keys.join("|")})\`?\\s*)[:=].*$`, "i");
  const out: string[] = [];
  let skipLevel = 0; // inside a removed section of this heading level (0 = not skipping)
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const h = HEADING_RE.exec(raw);
    if (h) {
      const level = h[1]!.length;
      if (skipLevel > 0 && level > skipLevel) continue;
      // The document title (level 1) is never a personal section, whatever its words.
      skipLevel = level >= 2 && PERSONAL_SECTION.test(h[2]!) ? level : 0;
      if (skipLevel > 0) continue;
    } else if (skipLevel > 0) continue;
    const m = factLine?.exec(raw);
    out.push(m ? `${m[1]!.trimEnd()}: [fact]` : mask(raw));
  }
  return cut(out.join("\n").replace(/\n{3,}/g, "\n\n"), 32768);
}

const oneLine = (text: string, max: number, fallback: string): string => {
  const t = cut(mask(text), max);
  return t.trim() === "" ? fallback : t;
};

function stripConnection(c: StepConnection | null): StepConnection | null {
  return c === null ? null : { kind: c.kind, ownership: c.ownership, connectionId: c.connectionId, label: cut(mask(c.label), 120) };
}

function stripStep(s: Step, i: number): Step {
  return {
    id: s.id,
    title: oneLine(s.title, 120, `Step ${i + 1}`),
    detail: cut(mask(s.detail), 600),
    class: s.class,
    capability: s.capability,
    connection: stripConnection(s.connection),
    gate: s.gate,
  };
}

/**
 * The role-workflow form of a definition. Picks the definition fields only (object metadata is the caller's), drops
 * the proposer's local workflow id and strips every text field.
 */
export function stripDefinition(d: Definition): Definition {
  return {
    localWorkflowId: "",
    workflowId: d.workflowId,
    version: d.version,
    name: oneLine(d.name, 120, "Workflow"),
    description: cut(mask(d.description), 1000),
    trigger: { type: d.trigger.type, cron: d.trigger.cron, timezone: d.trigger.timezone },
    steps: d.steps.map(stripStep),
    skillMd: stripSkillMd(d.skillMd, d.factsKeys),
    factsKeys: [...d.factsKeys],
    limits: { maxItemsPerRun: d.limits.maxItemsPerRun, maxRunsPerDay: d.limits.maxRunsPerDay },
  };
}

// The registry half of the "never automate a personal LinkedIn" rule (ADR 0104 §5, enforced again by broker and Mac).
const COMMIT_VERB = /\.(send|post|publish|append|create|update|delete|write|comment|like|react|share|message|connect|reply|invite|upload|follow|endorse)$/;

/** A step that changes something outside: class commit, or a capability whose verb commits. */
export function commits(step: Pick<Step, "class" | "capability">): boolean {
  return step.class === "commit" || COMMIT_VERB.test(step.capability);
}

/** Why this binding is forbidden on this step, or null when it is not. */
export function forbiddenBinding(step: Pick<Step, "id" | "class" | "capability">, conn: { kind: string; ownership: string }): string | null {
  if (!commits(step)) return null;
  if (conn.kind === "linkedin_personal") return `step ${step.id} commits through a personal LinkedIn, which is never automated`;
  if (conn.ownership === "personal-forbidden") return `step ${step.id} commits through a personal-forbidden connection`;
  return null;
}
