// facts.md: "key: value" lines (company, pitch, raise, traction, ask, sign, subject). Drafts may only state these.
import type { Recipient } from "../tone/draft.ts";

export function parseFacts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^-?\s*([A-Za-z][\w ]{0,30}?):\s*(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined && m[2].trim() !== "") out[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return out;
}

/** Subject from facts.md `subject:` (or the workflow default) with {company}, {org}, {first} filled in. */
export function renderSubject(template: string, facts: Record<string, string>, r: Recipient): string {
  return template
    .replace(/\{company\}/g, facts.company ?? "[missing: company]")
    .replace(/\{org\}/g, r.org ?? r.email.split("@")[1] ?? "")
    .replace(/\{first\}/g, r.firstName)
    .trim();
}
