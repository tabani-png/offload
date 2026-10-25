// Contact-pattern masking for the only free text a device sends (workflow proposals, ADR 0104: "SKILL.md text after
// masking"). The collector already replaced facts values; this pass removes what still looks like an address, link,
// host or phone number. Pure string code: no brain state.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?|ftp|mailto|file):\/{0,2}[^\s)\]>"'`]+/gi;
const WWW_RE = /\bwww\.[^\s)\]>"'`]+/gi;
// Host names with a real top-level domain. File names (recipients.csv, facts.md, workflow.json) are not hosts.
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|vc|co|ai|app|dev|uk|de|fr|ca|us|eu|me|xyz|info|biz|edu|gov|ch|nl|se|no|fi|dk|es|it|jp|au|nz|in|tech|cloud|so|gg|ly|to)\b/gi;
const PHONE_RE = /\+?\d[\d ().-]{6,}\d/g;

/** Masks emails, URLs, host names and phone-like digit runs (at least 9 digits). */
export function mask(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[link]")
    .replace(WWW_RE, "[link]")
    .replace(HOST_RE, "[host]")
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m))
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/** Masked and cut to `max` code points. */
export const maskTo = (text: string, max: number): string => [...mask(text)].slice(0, max).join("");
