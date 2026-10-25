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

let cache: Template[] | null = null;

export function listTemplates(): Template[] {
  cache ??= readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseTemplate(readFileSync(join(TEMPLATES_DIR, f), "utf8")));
  return cache;
}

export function isTemplate(id: string): boolean {
  return id === CUSTOM_TEMPLATE || listTemplates().some((t) => t.id === id);
}
