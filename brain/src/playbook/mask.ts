// Who is in these messages (the identity set) and the masked text every model and every playbook field is built from.
// Personal things are names (the author, the recipients, people and companies they mention), addresses, phones,
// links and figures. The playbook keeps patterns; these never leave this file unmasked. Pure string code.
import { cleanEmail } from "../tone/clean.ts";
import type { PlaybookMessage } from "./types.ts";

export interface Identity {
  /** The author's names (lower case): sign names, the signature's name line, facts `sign:`. */
  author: Set<string>;
  /** The author's company (lower case): facts `company:`, the signature, brand words of the subjects. */
  company: Set<string>;
  /** Recipients and people named (lower case): greeting names, address local parts. */
  people: Set<string>;
  /** Recipients' organisations (lower case): address domain stems. */
  orgs: Set<string>;
  /** Other proper nouns of the messages (lower case): capitalised words mid-sentence that are not generic. */
  words: Set<string>;
}

/** Capitalised words that name nothing personal: days, months, common products, abbreviations. */
const GENERIC = new Set(
  (
    "i mac macs macos iphone ipad windows gmail google linkedin zoom slack teams excel sheets outlook monday tuesday wednesday thursday friday saturday " +
    "sunday january february march april may june july august september october november december am pm ok ceo cto cfo coo vp hr pdf csv uk us eu " +
    "saas ai api crm ats series seed ps"
  ).split(" "),
);
/** Mail providers and generic hosts: their domain is not the recipient's organisation. */
const GENERIC_HOSTS = new Set("gmail googlemail outlook hotmail live yahoo icloud me mac aol proton protonmail gmx seznam mail email web www help support info".split(" "));
/** Job titles and generic words of signature lines. */
const TITLE_WORDS = new Set("founder cofounder co-founder ceo cto coo cfo head of support sales team manager director engineer recruiter partner lead talent people operations ops customer success".split(" "));

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?|ftp|mailto|file):\/{0,2}[^\s)\]>"'`]+/gi;
const WWW_RE = /\bwww\.[^\s)\]>"'`]+/gi;
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const PHONE_RE = /\+?\d[\d ().-]{6,}\d/g;
const NUMBER_RE = /[$£€#]?\b[\w-]*\d[\w-]*(?:[.,]\d[\w-]*)*%?/g;
const LOCAL_FILES = new Set(["recipients.csv", "facts.md", "workflow.json", "skill.md", "playbook.json", "playbook.md"]);
/** A placeholder this module writes, or a word. */
const TOKEN_RE = /\[[a-z_]+\]|\{[a-z_]+\}|[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*/g;

export const emptyIdentity = (): Identity => ({ author: new Set(), company: new Set(), people: new Set(), orgs: new Set(), words: new Set() });

const base = (w: string) => w.toLowerCase().replace(/['’]s$/, "").replace(/[-'’]+$/, "");
const isCap = (w: string) => /^[A-ZÀ-Þ]/.test(w);

/** Address -> person name parts and organisation stem ("anna.weber@northzone.com" -> [anna, weber], northzone). */
export function addressParts(addr: string): { people: string[]; org: string | null } {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  const local = at >= 0 ? a.slice(0, at) : a.includes(":") ? a.slice(a.indexOf(":") + 1) : a;
  const people = local.split(/[._+\-:]/).filter((p) => /^[a-zà-ÿ]{2,}$/.test(p));
  let org: string | null = null;
  if (at >= 0) {
    const labels = a.slice(at + 1).split(".").filter((l) => l !== "");
    const stem = labels.length >= 2 ? labels.slice(0, -1).find((l) => !GENERIC_HOSTS.has(l)) : undefined;
    org = stem !== undefined && stem.length >= 2 ? stem : null;
  }
  return { people, org };
}

/** Facts lines `key: value`, lower-cased keys. */
export function factLines(facts: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of facts.split("\n")) {
    const m = /^-?\s*([A-Za-z][\w ]*?):\s*(.+)$/.exec(line.trim());
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return out;
}

/** The signature block of a raw body: lines after "--" (or "—"), before any quoted reply. */
function signatureLines(body: string): string[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^(?:-- ?|—+)\s*$/.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^On .+wrote:\s*$/.test(l.trim()) || l.trim().startsWith(">") || /^-{2,}\s*(?:forwarded|original)/i.test(l.trim())) break;
    if (l.trim() !== "") out.push(l.trim());
  }
  return out.slice(0, 6);
}

function addSignature(id: Identity, lines: readonly string[]): void {
  lines.forEach((line, i) => {
    for (const part of line.split(/[,|·]/).map((p) => p.trim()).filter((p) => p !== "")) {
      for (const h of part.match(HOST_RE) ?? []) for (const l of h.toLowerCase().split(".").slice(0, -1)) if (!GENERIC_HOSTS.has(l) && l.length >= 2) id.company.add(l);
      if (/\d/.test(part) || /[@/]/.test(part)) continue;
      const words = part.split(/\s+/).filter((w) => /^[A-Z][\w'-]+$/.test(w));
      if (words.length === 0) continue;
      if (i === 0 && /^[A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+){0,2}$/.test(part)) for (const w of words) id.author.add(base(w));
      else for (const w of words) if (!TITLE_WORDS.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase())) id.company.add(base(w));
    }
  });
}

const stripRe = (s: string) => s.replace(/^\s*(?:(?:re|fwd?|fw|aw)\s*:\s*)+/i, "").trim();

/** Sentence-initial: nothing before it on the line, or after . ! ? : and spaces/quotes. */
function initialAt(text: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && /[ \t"'“‘(]/.test(text[i]!)) i--;
  return i < 0 || /[.!?:\n]/.test(text[i]!);
}

/** Every personal name, organisation and proper noun of these messages, plus the author's facts. */
export function buildIdentity(messages: readonly PlaybookMessage[], facts = ""): Identity {
  const id = emptyIdentity();
  const f = factLines(facts);
  for (const w of (f.sign ?? "").split(/\s+/)) if (/^[A-Za-z][\w'-]+$/.test(w)) id.author.add(base(w));
  for (const w of (f.company ?? "").split(/\s+/)) if (/^[A-Za-z][\w'-]+$/.test(w) && !GENERIC.has(w.toLowerCase())) id.company.add(base(w));
  const cores: string[] = [];
  for (const m of messages) {
    const c = cleanEmail({ id: m.id, to: m.to, subject: m.subject, body: m.body, sentAt: m.sentAt });
    for (const addr of m.to) {
      const p = addressParts(addr);
      for (const n of p.people) id.people.add(n);
      if (p.org !== null) id.orgs.add(p.org);
    }
    const g = c.greeting === null ? null : /^\w+\s+([A-ZÀ-Þ][\w'-]*)/.exec(c.greeting)?.[1];
    if (g !== undefined && g !== null) id.people.add(base(g));
    if (c.signName !== null) for (const w of c.signName.split(/\s+/)) id.author.add(base(w));
    addSignature(id, signatureLines(m.body));
    cores.push(c.core, stripRe(m.subject));
  }
  // Proper nouns: capitalised mid-sentence and not generic. Brand words: capitalised in at least half the subjects
  // and never written in lower case (the author's product, e.g. the company name at the start of every subject).
  const lower = new Set<string>();
  for (const t of cores) for (const w of t.match(TOKEN_RE) ?? []) if (!isCap(w)) lower.add(base(w));
  for (const t of cores) {
    for (const mm of t.matchAll(TOKEN_RE)) {
      const w = mm[0];
      if (w.startsWith("[") || w.startsWith("{") || !isCap(w) || w.length < 2) continue;
      const b = base(w);
      if (GENERIC.has(b) || /^i['’]/.test(b)) continue;
      if (!initialAt(t, mm.index ?? 0)) id.words.add(b);
    }
  }
  const subjects = messages.map((m) => stripRe(m.subject)).filter((s) => s !== "");
  const inSubjects = new Map<string, number>();
  for (const s of subjects) for (const w of new Set((s.match(TOKEN_RE) ?? []).filter(isCap).map(base))) inSubjects.set(w, (inSubjects.get(w) ?? 0) + 1);
  for (const [w, n] of inSubjects) if (n * 2 >= subjects.length && subjects.length >= 2 && !lower.has(w) && !GENERIC.has(w) && w.length >= 3) id.company.add(w);
  // A name is never also a generic word of the identity's other sets.
  for (const set of [id.people, id.orgs, id.words]) for (const w of [...set]) if (id.author.has(w) || id.company.has(w)) set.delete(w);
  return id;
}

/** Contact patterns and figures -> placeholders. No identity needed. */
export function maskContacts(text: string): string {
  return text
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[link]")
    .replace(WWW_RE, "[link]")
    .replace(HOST_RE, (m) => (LOCAL_FILES.has(m.toLowerCase()) || /^\d+(?:\.\d+)+$/.test(m) ? m : "[link]"))
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m))
    .replace(NUMBER_RE, (m) => (/\d/.test(m) ? "[number]" : m))
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

export interface MaskScope {
  /** This message's recipient: their first name becomes {first}, their organisation {their_org}. */
  first?: string | null;
  org?: string | null;
}

/** Masked text: contacts and figures, then the author ({sender}), their company ({company}), this recipient
 * ({first}, {their_org}) and every other identity word or mid-sentence proper noun ([name]). */
export function maskText(text: string, id: Identity, scope: MaskScope = {}): string {
  const t = maskContacts(text);
  const first = scope.first == null ? null : base(scope.first);
  const org = scope.org == null ? null : scope.org.toLowerCase();
  return t.replace(TOKEN_RE, (w, offset: number) => {
    if (w.startsWith("[") || w.startsWith("{")) return w;
    const b = base(w);
    if (id.author.has(b)) return "{sender}";
    if (id.company.has(b)) return "{company}";
    if (!isCap(w)) return w;
    if (first !== null && b === first) return "{first}";
    if (org !== null && b.length >= 3 && (b === org || org.startsWith(b))) return "{their_org}";
    if (id.people.has(b) || id.orgs.has(b) || id.words.has(b)) return "[name]";
    if (GENERIC.has(b) || /^i['’]/.test(b) || w.length < 2) return w;
    return initialAt(t, offset) ? w : "[name]";
  });
}

/** The masked core of one message (greeting, sign-off, quotes and signature removed) and its greeting name. */
export function maskedCore(m: PlaybookMessage, id: Identity): { core: string; first: string | null } {
  const c = cleanEmail({ id: m.id, to: m.to, subject: m.subject, body: m.body, sentAt: m.sentAt });
  const first = c.greeting === null ? null : (/^\w+\s+([A-ZÀ-Þ][\w'-]*)/.exec(c.greeting)?.[1] ?? null);
  const org = m.to.map((a) => addressParts(a).org).find((o) => o !== null) ?? null;
  return { core: maskText(c.core, id, { first, org }), first };
}

export { EMAIL_RE, HOST_RE, PHONE_RE, TOKEN_RE, URL_RE, WWW_RE, base as identityBase, isCap, GENERIC };
