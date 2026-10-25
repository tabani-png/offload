// Contact-pattern masking for the only free text a device sends (workflow proposals, ADR 0104: "SKILL.md text after
// masking"). The collector already replaced facts values; this pass removes what still looks like an address, link,
// host or phone number. Pure string code: no brain state.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?|ftp|mailto|file):\/{0,2}[^\s)\]>"'`]+/gi;
const WWW_RE = /\bwww\.[^\s)\]>"'`]+/gi;
// Any dotted name whose last label is 2-63 letters is treated as a host: no list of top-level domains, so new or
// country domains (.studio, .health, .pl, .com.br) are masked too. Only the brain's own workflow file names stay.
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;
const LOCAL_FILES = new Set(["recipients.csv", "facts.md", "workflow.json", "skill.md"]);
const PHONE_RE = /\+?\d[\d ().-]{6,}\d/g;

/** Masks emails, URLs, host names and phone-like digit runs (at least 9 digits). */
export function mask(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[link]")
    .replace(WWW_RE, "[link]")
    .replace(HOST_RE, (m) => (LOCAL_FILES.has(m.toLowerCase()) ? m : "[host]"))
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m))
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/** Masked and cut to `max` code points. */
export const maskTo = (text: string, max: number): string => [...mask(text)].slice(0, max).join("");
