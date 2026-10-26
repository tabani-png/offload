// Who is in these messages (the identity set) and the masked text every model and every playbook field is built from.
// Personal things are names (the author, the recipients, people and companies they mention), addresses, phones,
// links and figures. The playbook keeps patterns; these never leave this file unmasked. Pure string code.
import { createHash } from "node:crypto";
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
  /** Other proper nouns of the messages (lower case): capitalised words mid-sentence that are not generic, and
   * capitalised words at the start of a sentence that are neither common words nor ever written in lower case. */
  words: Set<string>;
  /** Words the messages also write in lower case (contacts masked first): ordinary words, not names. Input masking
   * only; the leak check never relies on it, so it gives the same answer with or without the tone pack. */
  vocab?: Set<string>;
  /** The build-time identity as salted hashes (store.ts identity digest), when the messages are no longer here. */
  hashed?: IdentityDigest;
}

/** Salted SHA-256 of the identity's words, per kind. Lets a later notes edit or promotion re-check against the names
 * of the build without keeping them in plain text. */
export interface IdentityDigest {
  salt: string;
  author: Set<string>;
  company: Set<string>;
  /** people, orgs and words. */
  names: Set<string>;
  /** people and orgs only: the known contacts, matched in lower case too. */
  contacts: Set<string>;
}

export const hashWord = (salt: string, w: string) => createHash("sha256").update(`${salt}\u0000${w}`).digest("hex");

/** Is `b` (a base word) in the identity, plain or hashed? `contacts` is the recipients and their organisations only
 * (the names known from addresses and greetings, not from capitalisation), checked whatever the case of the word. */
export function inIdentity(id: Identity, kind: "author" | "company" | "names" | "contacts", b: string): boolean {
  const plain = kind === "names" ? id.people.has(b) || id.orgs.has(b) || id.words.has(b) : kind === "contacts" ? id.people.has(b) || id.orgs.has(b) : id[kind].has(b);
  return plain || (id.hashed !== undefined && id.hashed[kind].has(hashWord(id.hashed.salt, b)));
}

/** Capitalised words that name nothing personal: days, months, common products, abbreviations. */
const GENERIC = new Set(
  (
    "i mac macs macos iphone ipad windows gmail google linkedin zoom slack teams excel sheets outlook monday tuesday wednesday thursday friday saturday " +
    "sunday january february march april may june july august september october november december am pm ok ceo cto cfo coo vp hr pdf csv uk us eu " +
    "saas ai api crm ats series seed ps"
  ).split(" "),
);
/** Words that often start a sentence and name nothing: function words, greetings and the verbs of writing advice.
 * A capitalised word at the start of a sentence is masked unless it is one of these, generic, or (input only) a word
 * the messages also write in lower case. */
const COMMON = new Set(
  (
    "a an the this that these those there here it its i'm i've i'll i'd we us our ours you your yours they them their he she him her his " +
    "my me mine who what when where why how which whose whom if then than so but and or nor yet also as at by for from in into on onto of off out " +
    "over under to up down with without about after before again all any both each every few more most other some such no not only own same too " +
    "very just now still even ever never always often once twice sometimes maybe perhaps please thanks thank thx cheers hi hey hello dear best " +
    "regards sincerely kind warm yes yeah sure okay great good happy glad sorry apologies welcome congrats congratulations quick short one two three " +
    "first second third next last new old few many much little long big small is are was were be been being am do does did done doing have has had " +
    "having can could will would shall should may might must let lets let's get gets got make makes made take takes took give gives gave go goes " +
    "going went come comes came see saw look looking looks hope hoping think thought know knew want wanted need needs needed like liked love would've " +
    "following follow follows circling bumping bump checking check just raising building built hiring helping help helps we're you're they're it's " +
    "that's there's here's what's don't doesn't didn't can't won't isn't aren't wasn't weren't open start starts end ends close keep use add say " +
    "says said mention ask asks asked offer offers write writes wrote show shows name names state states avoid include includes try send sends sent " +
    "reply replies replied lead leads put tell sign greet answer note notes per via because since while until unless though although however instead " +
    "otherwise meanwhile overall finally also again later today tomorrow yesterday tonight morning afternoon evening week weeks month year " +
    "attached enclosed re fwd fw subject message messages rule rules template templates opener openers ask asks proof cta outcome outcomes " +
    "role roles reader readers recipient recipients sender company draft drafts playbook skeleton skeletons slot slots none " +
    "back figures figure links link follow-up follow-ups don dont aim goal goals point points keep mail email call calls chat meet meeting " +
    "demo deck intro introduction question questions idea ideas update updates thing things time times way ways part parts team teams people " +
    "customer customers founder founders investor investors candidate candidates order orders refund delivery ticket account " +
    "tired curious wondering imagine imagined noticed loved enjoyed read heard met spoke spent spending losing struggling stuck " +
    "straight worth free available interested excited delighted pleased afraid unfortunately luckily hopefully honestly actually basically " +
    "really simply clearly certainly definitely absolutely exactly especially usually typically currently recently already soon " +
    "every everyone everything someone something anyone anything nobody nothing most many several plenty lots whether either neither " +
    "fine nice cool awesome perfect lovely amazing ideal important useful helpful easy hard simple clear true real right wrong " +
    "bring brought build builds call called feel felt find found hear keep kept leave left mean meant move moved pay paid plan planned " +
    "run ran set share shared stop talk talked turn turned wait work worked works working cover covered explain fix fixed resend reset " +
    "confirm confirmed agree agreed apply applied join joined reach reached schedule scheduled book booked suggest suggested recommend"
  ).split(" "),
);
/** Mail providers and generic hosts: their domain is not the recipient's organisation. */
const GENERIC_HOSTS = new Set("gmail googlemail outlook hotmail live yahoo icloud me mac aol proton protonmail gmx seznam mail email web www help support info".split(" "));
/** Address local parts that are a role, not a person ("sales@", "support@"). */
const ROLE_LOCALS = new Set("info sales support hello contact contacts team jobs careers admin office press hr billing accounts marketing partners noreply no reply enquiries inquiries mail email".split(" "));
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
const TOKEN_RE = /\[[a-z_]+\]|\{[a-z_]+\}|\p{L}[\p{L}\p{M}'’-]*/gu;

export const emptyIdentity = (): Identity => ({ author: new Set(), company: new Set(), people: new Set(), orgs: new Set(), words: new Set() });

const base = (w: string) => w.toLowerCase().replace(/['’]s$/, "").replace(/[-'’]+$/, "");
/** Upper case, title case, or a letter of a script without case (a name in Chinese, Arabic, Hebrew...). */
const isCap = (w: string) => /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(w);
/** A word that is not a name by itself, wherever it stands: generic, common or a contraction of "I". */
const plainWord = (b: string) => GENERIC.has(b) || COMMON.has(b) || /^i['’]/.test(b);
/** Does this text start with a capitalised word that is not a plain word (an unmasked name)? */
export function startsUnmasked(text: string): boolean {
  const w = text.match(TOKEN_RE)?.[0];
  return w !== undefined && !w.startsWith("[") && !w.startsWith("{") && isCap(w) && [...w].length >= 2 && !plainWord(base(w));
}

/** Address -> person name parts and organisation stem ("anna.weber@northzone.com" -> [anna, weber], northzone). */
export function addressParts(addr: string): { people: string[]; org: string | null } {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  const local = at >= 0 ? a.slice(0, at) : a.includes(":") ? a.slice(a.indexOf(":") + 1) : a;
  const people = local.split(/[._+\-:]/).filter((p) => /^\p{L}{2,}$/u.test(p) && !ROLE_LOCALS.has(p));
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
      const words = part.split(/\s+/).filter((w) => /^\p{Lu}[\p{L}\p{M}\d'-]+$/u.test(w));
      if (words.length === 0) continue;
      if (i === 0 && /^\p{Lu}[\p{L}\p{M}'-]+(?: \p{Lu}[\p{L}\p{M}'-]+){0,2}$/u.test(part)) for (const w of words) id.author.add(base(w));
      else for (const w of words) if (!TITLE_WORDS.has(w.toLowerCase()) && !GENERIC.has(w.toLowerCase())) id.company.add(base(w));
    }
  });
}

/** The name after the greeting word ("Hi Łukasz," -> Łukasz). */
const GREETING_NAME_RE = /^\p{L}+\s+([\p{Lu}\p{Lt}\p{Lo}][\p{L}\p{M}'-]*)/u;

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
  for (const w of (f.sign ?? "").split(/\s+/)) if (/^\p{L}[\p{L}\p{M}\d'-]+$/u.test(w)) id.author.add(base(w));
  for (const w of (f.company ?? "").split(/\s+/)) if (/^\p{L}[\p{L}\p{M}\d'-]+$/u.test(w) && !GENERIC.has(w.toLowerCase())) id.company.add(base(w));
  const cores: string[] = [];
  for (const m of messages) {
    const c = cleanEmail({ id: m.id, to: m.to, subject: m.subject, body: m.body, sentAt: m.sentAt });
    for (const addr of m.to) {
      const p = addressParts(addr);
      for (const n of p.people) id.people.add(n);
      if (p.org !== null) id.orgs.add(p.org);
    }
    const g = c.greeting === null ? null : GREETING_NAME_RE.exec(c.greeting)?.[1];
    if (g !== undefined && g !== null) id.people.add(base(g));
    if (c.signName !== null) for (const w of c.signName.split(/\s+/)) id.author.add(base(w));
    addSignature(id, signatureLines(m.body));
    cores.push(c.core, stripRe(m.subject));
  }
  // Proper nouns: capitalised mid-sentence and not generic, or capitalised at the start of a sentence and neither a
  // common word nor ever written in lower case ("Priya is an engineer"). Brand words: capitalised in at least half
  // the subjects and never written in lower case (the author's product, e.g. the company name in every subject).
  // Contacts are masked first, so the local part of an address is not a lower-case word.
  const lower = new Set<string>();
  const masked = cores.map(maskContacts);
  for (const t of masked) for (const w of t.match(TOKEN_RE) ?? []) if (!isCap(w)) lower.add(base(w));
  for (const t of masked) {
    for (const mm of t.matchAll(TOKEN_RE)) {
      const w = mm[0];
      if (w.startsWith("[") || w.startsWith("{") || !isCap(w) || [...w].length < 2) continue;
      const b = base(w);
      if (GENERIC.has(b) || /^i['’]/.test(b)) continue;
      if (!initialAt(t, mm.index ?? 0) || (!COMMON.has(b) && !lower.has(b))) id.words.add(b);
    }
  }
  id.vocab = lower;
  const subjects = messages.map((m) => stripRe(m.subject)).filter((s) => s !== "");
  const inSubjects = new Map<string, number>();
  for (const s of subjects) for (const w of new Set((s.match(TOKEN_RE) ?? []).filter(isCap).map(base))) inSubjects.set(w, (inSubjects.get(w) ?? 0) + 1);
  for (const [w, n] of inSubjects) if (n * 2 >= subjects.length && subjects.length >= 2 && !lower.has(w) && !GENERIC.has(w) && w.length >= 3) id.company.add(w);
  // A name is never also a generic word of the identity's other sets, and never an ordinary word.
  for (const set of [id.people, id.orgs, id.words]) for (const w of [...set]) if (id.author.has(w) || id.company.has(w)) set.delete(w);
  for (const set of [id.author, id.company, id.people, id.orgs, id.words]) for (const w of set) lower.delete(w);
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
 * ({first}, {their_org}) and every other identity word or proper noun ([name]): known contacts in any case, any
 * capitalised word mid-sentence that
 * is not generic, and any at the start of a sentence that is not generic, common or written in lower case too. */
export function maskText(text: string, id: Identity, scope: MaskScope = {}): string {
  const t = maskContacts(text);
  const first = scope.first == null ? null : base(scope.first);
  const org = scope.org == null ? null : scope.org.toLowerCase();
  return t.replace(TOKEN_RE, (w, offset: number) => {
    if (w.startsWith("[") || w.startsWith("{")) return w;
    const b = base(w);
    if (inIdentity(id, "author", b)) return "{sender}";
    if (inIdentity(id, "company", b)) return "{company}";
    // A known contact is masked whatever its case ("we help alice at northzone"), unless it is also an ordinary word
    // ("will", "hope"): then only its capitalised form is taken for the name.
    if (!isCap(w)) {
      if (plainWord(b)) return w;
      if (first !== null && b === first) return "{first}";
      if (org !== null && b === org) return "{their_org}";
      return inIdentity(id, "contacts", b) ? "[name]" : w;
    }
    if (first !== null && b === first) return "{first}";
    if (org !== null && b.length >= 3 && (b === org || org.startsWith(b))) return "{their_org}";
    if (inIdentity(id, "names", b)) return "[name]";
    if (GENERIC.has(b) || /^i['’]/.test(b) || [...w].length < 2) return w;
    if (!initialAt(t, offset)) return "[name]";
    return COMMON.has(b) || id.vocab?.has(b) === true ? w : "[name]";
  });
}

/** The masked core of one message (greeting, sign-off, quotes and signature removed) and its greeting name. */
export function maskedCore(m: PlaybookMessage, id: Identity): { core: string; first: string | null } {
  const c = cleanEmail({ id: m.id, to: m.to, subject: m.subject, body: m.body, sentAt: m.sentAt });
  const first = c.greeting === null ? null : (GREETING_NAME_RE.exec(c.greeting)?.[1] ?? null);
  const org = m.to.map((a) => addressParts(a).org).find((o) => o !== null) ?? null;
  return { core: maskText(c.core, id, { first, org }), first };
}

export { EMAIL_RE, HOST_RE, PHONE_RE, TOKEN_RE, URL_RE, WWW_RE, base as identityBase, isCap, plainWord, GENERIC };
