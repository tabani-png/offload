/**
 * The compliance pack's notice and policy templates (`compliance/templates/*.md`, ADR 0108 §9). Each file starts with
 * frontmatter: `id`, `title`, `jurisdictions: [..]`, `requiredFields: [..]`; each required field appears in the body as
 * a `{{field}}` placeholder the tenant fills in. They are drafts for counsel, not legal advice.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const COMPLIANCE_DIR = join(import.meta.dir, "../../../../compliance");
export const TEMPLATES_DIR = join(COMPLIANCE_DIR, "templates");
export const COUNSEL_LINE = "Not legal advice; review by counsel before use.";
/** A notice written from scratch rather than from a template. */
export const CUSTOM_TEMPLATE = "custom";

export interface Template {
  id: string;
  title: string;
  jurisdictions: string[];
  requiredFields: string[];
  body: string;
}

function value(raw: string): string | string[] {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return v;
}

/** Parses one template file; throws when the frontmatter or a field is missing. */
export function parseTemplate(text: string): Template {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("template has no frontmatter");
  const fm: Record<string, string | string[]> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = value(line.slice(i + 1));
  }
  const str = (k: string) => {
    const v = fm[k];
    if (typeof v !== "string" || v === "") throw new Error(`template frontmatter needs ${k}`);
    return v;
  };
  const arr = (k: string) => {
    const v = fm[k];
    if (!Array.isArray(v) || v.length === 0) throw new Error(`template frontmatter needs ${k}`);
    return v;
  };
  return { id: str("id"), jurisdictions: arr("jurisdictions"), title: str("title"), requiredFields: arr("requiredFields"), body: m[2]! };
}

/** Static files shipped with the build: read once, frozen, so the one copy shared by every app cannot drift. */
let cache: readonly Template[] | null = null;

export function listTemplates(): readonly Template[] {
  cache ??= Object.freeze(
    readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        const t = parseTemplate(readFileSync(join(TEMPLATES_DIR, f), "utf8"));
        Object.freeze(t.jurisdictions);
        Object.freeze(t.requiredFields);
        return Object.freeze(t);
      }),
  );
  return cache;
}

export function isTemplate(id: string): boolean {
  return id === CUSTOM_TEMPLATE || listTemplates().some((t) => t.id === id);
}

export function templateById(id: string): Template | undefined {
  return listTemplates().find((t) => t.id === id);
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text that holds a field's place without filling it: TBD, TODO, "...", "-", "<fill in>", "[placeholder]" and the like. */
const FILLER = /^(?:tbd|tba|tbc|todo|fixme|xxx+|placeholder|fill in|lorem ipsum.*|[-–—_.?…]*|<[^>]*>|\[[^\]]*\])$/i;

/** Whether `text` is an actual value: not blank and not filler, ignoring markdown emphasis and trailing punctuation. */
function isValue(text: string): boolean {
  const v = text.replace(/[*_`]/g, "").trim().replace(/[.:;,!]+$/, "").trim();
  return v !== "" && !FILLER.test(v);
}

/**
 * The fields a notice drafted from template `t` has not filled in, in the template's field order:
 * - any `{{field}}` still in the text;
 * - a field whose every template mention is gone from the notice: its labelled line ("**Employer:** {{employer_name}}")
 *   or its section (`{{how}}` under "## How we monitor") was removed, so the notice never says it;
 * - a field left blank or filled with filler (TBD, TODO, ...) where the notice does keep its line or section.
 */
export function unfilledFields(t: Template, markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(PLACEHOLDER)) out.add(m[1]!);
  const lines = markdown.split("\n");
  const tl = t.body.split("\n");
  // Per field: whether some template mention of it is present in the notice with a real value.
  const filled = new Set<string>();
  const found = (f: string, value: string) => (isValue(value) ? filled.add(f) : out.add(f));
  tl.forEach((line, i) => {
    const parts = line.split(PLACEHOLDER);
    const fields = parts.filter((_, k) => k % 2 === 1);
    if (fields.length === 0) return;
    const literals = parts.filter((_, k) => k % 2 === 0);
    if (fields.length === 1 && literals.every((l) => l.trim() === "")) {
      const above = tl.slice(0, i).reverse().find((l) => l.trim() !== "");
      const below = tl.slice(i + 1).find((l) => l.trim() !== "")?.trim();
      const at = above === undefined ? -1 : lines.findIndex((l) => l.trim() === above.trim());
      if (at < 0) return;
      const section: string[] = [];
      for (let j = at + 1; j < lines.length && lines[j]!.trim() !== below && !lines[j]!.startsWith("#"); j++) section.push(lines[j]!);
      found(fields[0]!, section.join("\n"));
      return;
    }
    const re = new RegExp(`^${literals.map(escapeRe).join("(.*?)")}$`);
    for (const l of lines) {
      const m = re.exec(l);
      if (m) fields.forEach((f, k) => found(f, m[k + 1]!));
    }
  });
  for (const f of t.requiredFields) if (!filled.has(f)) out.add(f);
  const order = [...t.body.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  return [...out].sort((a, b) => (order.indexOf(a) + 1 || Infinity) - (order.indexOf(b) + 1 || Infinity));
}
