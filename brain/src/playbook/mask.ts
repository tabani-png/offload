// Who is in these messages (the identity set) and the masked text every model and every playbook field is built from.
// Personal things are names (the author, the recipients, people and companies they mention), addresses, phones,
// links and figures. The playbook keeps patterns; these never leave this file unmasked. Pure string code.
import { createHash } from "node:crypto";
import { cleanEmail } from "../tone/clean.ts";
import { AMBIGUOUS_GIVEN, FAMILY, GIVEN } from "../privacy/lexicon.ts";
import { COMMON_WORDS_TEXT } from "./wordlist/common-words.ts";
import { PROPER_WORDS_TEXT } from "./wordlist/proper-words.ts";
import { SUPPLEMENT_WORDS } from "./wordlist/supplement.ts";
import type { ContactEntry } from "../privacy/names.ts";
import { SLOTS, type PlaybookMessage } from "./types.ts";

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
    "saas ai api crm ats series seed ps mr mrs ms mx dr prof sir madam"
  ).split(" "),
);
/** Default deny: the only capitalised words that may stand mid-sentence unmasked. Weekdays, languages, common
 * acronyms, funding stages and honorifics name nobody; months only in a date (see allowedCap). Product and company
 * names are deliberately NOT here: "Spotify" or "Slack" mid-sentence is masked, and refused in notes. */
const CAP_ALLOW = new Set(
  (
    "monday tuesday wednesday thursday friday saturday sunday " +
    "english french german spanish italian portuguese dutch swedish danish norwegian finnish polish russian ukrainian " +
    "arabic hebrew hindi urdu bengali chinese mandarin cantonese japanese korean turkish greek " +
    "am pm ok ps ceo cto cfo coo cmo vp hr pdf csv uk us eu usa saas ai api crm ats cta roi kpi faq url sql seo b2b " +
    "series seed mr mrs ms mx dr prof"
  ).split(" "),
);
const MONTHS = new Set("january february march april may june july august september october november december".split(" "));
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
    "confirm confirmed agree agreed apply applied join joined reach reached schedule scheduled book booked suggest suggested recommend " +
    "folks guys friends friend all everybody"
  ).split(" "),
);
/** Words the playbook generator itself writes (synth.ts phrases and rule text) that are not already common words. They
 * are ordinary words of every playbook, so no heuristic promotes them into the identity and the leak check never reads
 * them as a name; a drift test (fixes4.test.ts) fails when synth.ts writes a word missing here. */
const GENERATOR_WORDS = new Set(
  (
    "acknowledgement acknowledges adds alternative apology attach backed backs baseline bracket cadence changed compute copy core counted " +
    "counts credential data date detail details different dropped earlier example examples fact facts failed form frustration greeting handled " +
    "happens hook identity invites issue key knows lands learned length line lines location lowers messaging missing model nudge number " +
    "original patterns person personal phrases piece plain plainly preface problem progress quote rates reads reason recent reference request " +
    "resolved reuse reword seen sentence sentences sign-off smaller specific stage step strings text traction tries unknown used uses usual " +
    "voice wording words written"
  ).split(" "),
);
/** Mail providers and generic hosts: their domain is not the recipient's organisation. */
const GENERIC_HOSTS = new Set("gmail googlemail outlook hotmail live yahoo icloud me mac aol proton protonmail gmx seznam mail email web www help support info".split(" "));
/** Second-level labels under a country code ("co.uk", "com.au"). */
const SECOND_LEVEL = new Set("co com org net ac gov edu ltd plc ne or go".split(" "));
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
/** The placeholders Offload writes, exactly: what masking writes ([email] ... {their_org}), the template slots
 * ({greeting} ... {sign_off}) and the skeleton brackets ([hook], [proof], [ask], [thanks] ...). Only these are exempt
 * from masking and from the leak check; any other word in brackets ("{northzone}", "[priya]") is read as plain text. */
export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  ...["email", "link", "phone", "number", "name", "thanks", ...SLOTS].map((w) => `[${w}]`),
  ...["sender", "company", "first", "their_org", ...SLOTS].map((w) => `{${w}}`),
]);
const esc = (s: string) => s.replace(/[[\]{}]/g, "\\$&");
/** A defined placeholder (exact list), or a word. A bracket around any other word is not part of the token, so the
 * word inside is masked and checked like the rest of the text. */
const TOKEN_RE = new RegExp(`${[...PLACEHOLDERS].map(esc).join("|")}|\\p{L}[\\p{L}\\p{M}'’-]*`, "gu");
/** Is this token one of the defined placeholders? */
export const isPlaceholder = (w: string) => PLACEHOLDERS.has(w);
/** "{{company}}" or "[[name]]": a bracketed word masked to a placeholder, kept as the placeholder alone. */
const NESTED_RE = /[[{](\[[a-z_]+\]|\{[a-z_]+\})[\]}]/g;

export const emptyIdentity = (): Identity => ({ author: new Set(), company: new Set(), people: new Set(), orgs: new Set(), words: new Set() });

const base = (w: string) => w.toLowerCase().replace(/['’]s$/, "").replace(/[-'’]+$/, "");
/** Upper case, title case, or a letter of a script without case (a name in Chinese, Arabic, Hebrew...). */
const isCap = (w: string) => /^[\p{Lu}\p{Lt}\p{Lo}]/u.test(w);
/** A word that is not a name by itself, wherever it stands: generic, common or a contraction of "I". */
const plainWord = (b: string) => GENERIC.has(b) || COMMON.has(b) || /^i['’]/.test(b);
/** Words the generator writes capitalised at the start of a sentence (synth.ts; drift-tested in fixes5.test.ts). A known
 * contact named like one of these ("Anna Short") is not read as a name where the generator would write the word itself:
 * capitalised at the start of a sentence. Anywhere else it is. */
export const GENERATOR_OPENERS: ReadonlySet<string> = new Set(
  "answer back code do don't end figures first follow-up if it keep links name open reply reword say short the when you".split(" "),
);
/** A plain word or a word the generator writes: never a name by itself, never masked in lower case, never a leak. */
export const ordinaryWord = (b: string) => plainWord(b) || GENERATOR_WORDS.has(b);
/** May this base word name the author or their company (sets matched whatever the case)? Two letters or more, letters
 * only (no digits, no brackets), not an ordinary word and not a job-title word. Anything else would mask ordinary text
 * and make the generator's own wording a leak. */
const promotable = (b: string) => [...b].length >= 2 && /^\p{L}[\p{L}\p{M}'’-]*$/u.test(b) && !ordinaryWord(b) && !TITLE_WORDS.has(b);
/** A person or organisation name part: two letters or more, letters only. Plain words may stay (they are skipped in
 * lower case and by the leak check), single letters and digits may not. */
const nameLike = (b: string) => [...b].length >= 2 && /^\p{L}[\p{L}\p{M}'’-]*$/u.test(b);
/** Does this text start with a capitalised word that is not a plain word (an unmasked name)? */
export function startsUnmasked(text: string): boolean {
  const w = text.match(TOKEN_RE)?.[0];
  return w !== undefined && !isPlaceholder(w) && isCap(w) && [...w].length >= 2 && !plainWord(base(w));
}

/** Address -> person name parts and organisation stem ("anna.weber@northzone.com" -> [anna, weber], northzone). */
export function addressParts(addr: string): { people: string[]; org: string | null } {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  const local = at >= 0 ? a.slice(0, at) : a.includes(":") ? a.slice(a.indexOf(":") + 1) : a;
  const people = local.split(/[._+\-:]/).filter((p) => /^\p{L}{2,}$/u.test(p) && !ROLE_LOCALS.has(p));
  let org: string | null = null;
  if (at >= 0) {
    // The registrable label names the organisation ("app.northzone.com" -> northzone, "northzone.co.uk" -> northzone),
    // not a subdomain ("app", "go", "mail").
    const labels = a.slice(at + 1).split(".").filter((l) => l !== "");
    const sld = labels.length >= 3 && SECOND_LEVEL.has(labels.at(-2)!) && labels.at(-1)!.length === 2;
    const stem = labels.length >= 2 ? labels.at(sld ? -3 : -2) : undefined;
    org = stem !== undefined && stem.length >= 2 && !GENERIC_HOSTS.has(stem) && /^\p{L}/u.test(stem) ? stem : null;
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

/** Add to the author or company set only a word that may name them (promotable). */
const addIf = (set: Set<string>, b: string) => {
  if (promotable(b)) set.add(b);
};

function addSignature(id: Identity, lines: readonly string[]): void {
  lines.forEach((line, i) => {
    for (const part of line.split(/[,|·]/).map((p) => p.trim()).filter((p) => p !== "")) {
      for (const h of part.match(HOST_RE) ?? []) for (const l of h.toLowerCase().split(".").slice(0, -1)) if (!GENERIC_HOSTS.has(l) && !SECOND_LEVEL.has(l)) addIf(id.company, l);
      if (/\d/.test(part) || /[@/]/.test(part)) continue;
      const words = part.split(/\s+/).filter((w) => /^\p{Lu}[\p{L}\p{M}\d'-]+$/u.test(w));
      if (words.length === 0) continue;
      if (i === 0 && /^\p{Lu}[\p{L}\p{M}'-]+(?: \p{Lu}[\p{L}\p{M}'-]+){0,2}$/u.test(part)) for (const w of words) addIf(id.author, base(w));
      else for (const w of words) addIf(id.company, base(w));
    }
  });
}

/** The name after the greeting word ("Hi Łukasz," -> Łukasz). */
const GREETING_NAME_RE = /^\p{L}+\s+(?:(?:mr|mrs|ms|mx|dr|prof)\.?\s+)?([\p{Lu}\p{Lt}\p{Lo}][\p{L}\p{M}'-]*)/iu;

const stripRe = (s: string) => s.replace(/^\s*(?:(?:re|fwd?|fw|aw)\s*:\s*)+/i, "").trim();

/** Sentence-initial: nothing before it on the line, or after . ! ? : and spaces/quotes. */
function initialAt(text: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && /[ \t"'“‘(]/.test(text[i]!)) i--;
  return i < 0 || /[.!?:\n]/.test(text[i]!);
}

/** The s18 name registry (privacy/policy.ts readNamePolicy): every workflow's recipients and the user's own name. */
export interface NameRegistry {
  contacts?: readonly ContactEntry[];
  self?: readonly string[];
}

/** Every personal name, organisation and proper noun of these messages, plus the author's facts and the s18 registry
 * (a contact s18 masks on the way to a model is a known contact here too; the user's own name is the author). */
export function buildIdentity(messages: readonly PlaybookMessage[], facts = "", registry: NameRegistry = {}): Identity {
  const id = emptyIdentity();
  for (const c of registry.contacts ?? []) {
    for (const part of [c.firstName ?? "", c.lastName ?? ""].join(" ").split(/[\s-]+/)) if (nameLike(base(part))) id.people.add(base(part));
    if (c.email !== undefined) {
      const p = addressParts(c.email);
      for (const n of p.people) if (nameLike(n)) id.people.add(n);
      if (p.org !== null) id.orgs.add(p.org);
    }
  }
  for (const s of registry.self ?? []) for (const w of s.split(/[\s,]+/)) addIf(id.author, base(w));
  const f = factLines(facts);
  for (const w of (f.sign ?? "").split(/[\s,]+/)) addIf(id.author, base(w));
  for (const w of (f.company ?? "").split(/[\s,]+/)) if (!GENERIC.has(w.toLowerCase())) addIf(id.company, base(w));
  const cores: string[] = [];
  for (const m of messages) {
    const c = cleanEmail({ id: m.id, to: m.to, subject: m.subject, body: m.body, sentAt: m.sentAt });
    for (const addr of m.to) {
      const p = addressParts(addr);
      for (const n of p.people) if (nameLike(n)) id.people.add(n);
      if (p.org !== null) id.orgs.add(p.org);
    }
    const g = c.greeting === null ? null : GREETING_NAME_RE.exec(c.greeting)?.[1];
    if (g !== undefined && g !== null && nameLike(base(g)) && !GENERIC.has(base(g))) id.people.add(base(g));
    if (c.signName !== null) for (const w of c.signName.split(/\s+/)) addIf(id.author, base(w));
    addSignature(id, signatureLines(m.body));
    cores.push(c.core);
  }
  // A Title Case subject ("Your Order Has Shipped") capitalises every word, so its capitals say nothing: each of its
  // words is read as if it started a sentence (a name only if it is not common and never written in lower case).
  const subjects = messages.map((m) => stripRe(m.subject)).filter((s) => s !== "");
  const titleCase = (s: string) => {
    const long = (s.match(TOKEN_RE) ?? []).filter((w) => !isPlaceholder(w) && [...w].length >= 4);
    return long.length >= 2 && long.every(isCap);
  };
  const nCores = cores.length;
  cores.push(...subjects);
  // Proper nouns: capitalised mid-sentence and not generic, or capitalised at the start of a sentence and neither a
  // common word nor ever written in lower case ("Priya is an engineer"). Brand words: capitalised in at least half
  // the subjects and never written in lower case (the author's product, e.g. the company name in every subject).
  // Contacts are masked first, so the local part of an address is not a lower-case word.
  const lower = new Set<string>();
  const masked = cores.map(maskContacts);
  for (const t of masked) for (const w of t.match(TOKEN_RE) ?? []) if (!isPlaceholder(w) && !isCap(w)) lower.add(base(w));
  masked.forEach((t, ti) => {
    const allInitial = ti >= nCores && titleCase(t);
    for (const mm of t.matchAll(TOKEN_RE)) {
      const w = mm[0];
      if (isPlaceholder(w) || !isCap(w) || [...w].length < 2) continue;
      const b = base(w);
      if (GENERIC.has(b) || /^i['’]/.test(b)) continue;
      if ((!allInitial && !initialAt(t, mm.index ?? 0)) || (!COMMON.has(b) && !lower.has(b))) id.words.add(b);
    }
  });
  id.vocab = lower;
  // Brand words count only capitals that carry meaning: a word capitalised in a subject that is not Title Case.
  const inSubjects = new Map<string, number>();
  for (const s of subjects) if (!titleCase(s)) for (const w of new Set((s.match(TOKEN_RE) ?? []).filter((x) => !isPlaceholder(x) && isCap(x)).map(base))) inSubjects.set(w, (inSubjects.get(w) ?? 0) + 1);
  for (const [w, n] of inSubjects) if (n * 2 >= subjects.length && subjects.length >= 2 && !lower.has(w) && !GENERIC.has(w) && w.length >= 3) addIf(id.company, w);
  // A name is never also a generic word of the identity's other sets, and never an ordinary word.
  for (const set of [id.people, id.orgs, id.words]) for (const w of [...set]) if (id.author.has(w) || id.company.has(w)) set.delete(w);
  for (const set of [id.author, id.company, id.people, id.orgs, id.words]) for (const w of set) lower.delete(w);
  return id;
}

/** Contact patterns and figures -> placeholders. No identity needed. */
export function maskContacts(text: string): string {
  return maskHandles(text
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[link]")
    .replace(WWW_RE, "[link]")
    .replace(HOST_RE, (m) => (LOCAL_FILES.has(m.toLowerCase()) || /^\d+(?:\.\d+)+$/.test(m) ? m : "[link]"))
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? "[phone]" : m))
    .replace(NUMBER_RE, (m) => (/\d/.test(m) ? "[number]" : m))
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ""));
}

export interface MaskScope {
  /** This message's recipient: their first name becomes {first}, their organisation {their_org}. */
  first?: string | null;
  org?: string | null;
}

/** Vocabulary default deny: a word of mail is kept only when it is a common English word (the bundled SCOWL size-50
 * list, wordlist/README.md) that is not an unambiguous given or family name of s18's lexicon, a common or generic word
 * of this file, a word the generator writes, or allowed (CAP_ALLOW). Anything else (a name in any case: "priya raman",
 * "o'brien", "Zorblax", a word in another script) is masked. */
const DICTIONARY: ReadonlySet<string> = (() => {
  const out = new Set([...COMMON_WORDS_TEXT.split("\n"), ...SUPPLEMENT_WORDS]);
  for (const n of [...GIVEN, ...FAMILY]) if (!AMBIGUOUS_GIVEN.has(n)) out.delete(n);
  return out;
})();
/** Is this base word known vocabulary? A hyphenated word is known when every part is ("time-boxed"). */
export function knownWord(b: string): boolean {
  if (ordinaryWord(b) || CAP_ALLOW.has(b) || DICTIONARY.has(b) || /^i(?:['’]\p{L}+)?$/u.test(b)) return true;
  const parts = b.split("-").filter((x) => x !== "");
  return parts.length > 1 && parts.every((x) => ordinaryWord(x) || CAP_ALLOW.has(x) || DICTIONARY.has(x));
}

/** Handles, snake_case names and paths: "@priyaraman", "priya_raman", "[link]/in/priya-raman", "and/or". Placeholders
 * ({sign_off}, [link]) are not touched. Shared by masking (maskContacts) and the leak check (handleLeaks). */
const HANDLE_RE = /(?<![\p{L}\p{N}.])@[\p{L}\p{N}_.-]*[\p{L}\p{N}]/gu;
/** A spelled-out address: "priya at acme dot com", "priya (at) acme (dot) com", "priya [at] acme [dot] io". */
const SPELLED_EMAIL_RE = /[\p{L}\p{N}._'-]+(?:[ \t]+at[ \t]+|[ \t]*[([]at[)\]][ \t]*)[\p{L}\p{N}-]+(?:(?:[ \t]+dot[ \t]+|[ \t]*[([]dot[)\]][ \t]*)[\p{L}\p{N}-]+)+/giu;
const SNAKE_RE = /(?<![{[\p{L}\p{N}_])[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+(?![}\]\p{L}\p{N}_])/gu;
const PATH_RE = /[^\s,;()<>"'`]*(?:[\p{L}\p{N}\]]\/|\/[\p{L}\p{N}])[^\s,;()<>"'`]*/gu;
const trimPath = (m: string) => m.replace(/[.!?:]+$/, "");
function maskHandles(text: string): string {
  return text
    .replace(SPELLED_EMAIL_RE, "[email]")
    .replace(HANDLE_RE, "[name]")
    .replace(SNAKE_RE, "[name]")
    .replace(PATH_RE, (m) => {
      const core = trimPath(m);
      return (core.startsWith("[link]") ? "[link]" : "[name]") + m.slice(core.length);
    });
}
/** The handles, snake_case names and paths of a text (the leak check's view of maskHandles). */
export function handleLeaks(text: string): string[] {
  return [...(text.match(SPELLED_EMAIL_RE) ?? []), ...(text.match(HANDLE_RE) ?? []), ...(text.match(SNAKE_RE) ?? []), ...(text.match(PATH_RE) ?? []).map(trimPath)];
}

/** May this capitalised word stand unmasked mid-sentence? The allow list and "I" and its contractions. A month only
 * in a date (monthKept). */
function allowedCap(text: string, w: string, offset: number): boolean {
  const b = base(w);
  if (CAP_ALLOW.has(b) || /^i(?:['’]\p{L}+)?$/u.test(b)) return true;
  return MONTHS.has(b) && monthKept(text, w, offset);
}

/** A month is kept before a figure ("May 5", "May [number]"), or after in/on/by/since/until/before/after/from/of when no
 * name follows ("in April and", "by June."); "in April Smith's office", "on May Chen", "April said yes" are names. */
function monthKept(text: string, w: string, offset: number): boolean {
  const after = text.slice(offset + w.length);
  if (/^[ \t]+(?:\d|\[number\])/.test(after)) return true;
  if (!/(?:^|[^\p{L}])(?:in|on|by|since|until|before|after|from|of)[ \t]+$/iu.test(text.slice(Math.max(0, offset - 8), offset))) return false;
  return !nextIsName(text, offset + w.length);
}

/** The word after `end` (spaces only between), with its offset, or null. */
function nextWord(text: string, end: number): { w: string; at: number } | null {
  const m = /^[ \t]+(\[name\]|\p{L}[\p{L}\p{M}'’-]*)/u.exec(text.slice(end));
  return m === null ? null : { w: m[1]!, at: end + m[0].length - m[1]!.length };
}
/** The word before `start` (spaces only between), with its offset, or null. */
function prevWord(text: string, start: number): { w: string; at: number } | null {
  const m = /(\[name\]|\p{L}[\p{L}\p{M}'’-]*)[ \t]+$/u.exec(text.slice(0, start));
  return m === null ? null : { w: m[1]!, at: m.index };
}
/** Does this neighbour read as a name on its own: a [name] placeholder, an unknown word, or a capitalised word that is
 * not allowed (months only before a figure)? Contacts and identity words count too. */
function neighbourIsName(text: string, n: { w: string; at: number } | null, id?: Identity): boolean {
  if (n === null) return false;
  if (n.w === "[name]") return true;
  if ([...n.w].length < 2) return false;
  const b = base(n.w);
  if (!knownWord(b)) return true;
  if (id !== undefined && (inIdentity(id, "contacts", b) || inIdentity(id, "names", b)) && isCap(n.w)) return true;
  if (!isCap(n.w)) return false;
  if (CAP_ALLOW.has(b) || /^i(?:['’]\p{L}+)?$/u.test(b)) return false;
  if (MONTHS.has(b)) return !/^[ \t]+(?:\d|\[number\])/.test(text.slice(n.at + n.w.length));
  return !initialAt(text, n.at);
}
const nextIsName = (text: string, end: number, id?: Identity) => neighbourIsName(text, nextWord(text, end), id);

/** A given or family name of the s18 lexicon, ambiguous or not ("frank", "rose", "will"). */
const lexName = (b: string) => GIVEN.has(b) || FAMILY.has(b) || AMBIGUOUS_GIVEN.has(b);
/** Dictionary words SCOWL also lists as proper nouns ("baker", "king", "young"): names in lower case next to a person
 * or a cue, like lexicon names (not capitalised-anywhere: "Long story short" stays). Common and generator words
 * ("more", "short") are left out: "ask more" is wording. */
const PROPER_WORDS: ReadonlySet<string> = new Set(PROPER_WORDS_TEXT.split("\n").filter((w) => !ordinaryWord(w)));
const personWord = (b: string) => lexName(b) || PROPER_WORDS.has(b);
/** Modal verbs that are also given names: in lower case they are the verb ("we will", "it may"), a cue, never a name. */
const MODALS = new Set(["will", "may"]);
/** Words that announce a person right after them ("thanks rose", "loop in june", "my colleague frank"). */
const CUE_BEFORE = new Set("hi hey dear thanks thank cc to with ask from met intro introduce introducing ping colleague colleagues cofounder co-founder boss manager wife husband partner".split(" "));
const CUE_BEFORE_2 = /(?:^|[^\p{L}])(?:spoke[ \t]+with|loop[ \t]+in)[ \t]+$/iu;
/** Words that follow a person ("parker said", "frank will", "rose is my"). */
const CUE_AFTER = new Set("said says wrote replied called will".split(" "));
const CUE_AFTER_2 = /^[ \t]+is[ \t]+my(?![\p{L}])/iu;
/** Does this neighbour stand for a person: a [name] placeholder, a lexicon name (not a lower-case modal), or a word
 * that reads as a name on its own (neighbourIsName)? */
function personNeighbour(text: string, n: { w: string; at: number } | null, id: Identity): boolean {
  if (n === null) return false;
  const b = base(n.w);
  if (n.w !== "[name]" && personWord(b) && !(MODALS.has(b) && !isCap(n.w))) return true;
  return neighbourIsName(text, n, id);
}
/** A lower-case lexicon name is a name next to another person ("frank baker"), after "and"/"or" that follows one
 * ("hunter and mason", "sue or pat"), after a cue ("thanks rose") or before one ("parker said", "rose is my"). */
function lowerLexName(text: string, w: string, offset: number, id: Identity): boolean {
  const prev = prevWord(text, offset);
  const next = nextWord(text, offset + w.length);
  if (personNeighbour(text, prev, id) || personNeighbour(text, next, id)) return true;
  if (prev !== null && CUE_BEFORE.has(prev.w.toLowerCase())) return true;
  if (CUE_BEFORE_2.test(text.slice(Math.max(0, offset - 16), offset))) return true;
  if (next !== null && CUE_AFTER.has(next.w.toLowerCase())) return true;
  if (CUE_AFTER_2.test(text.slice(offset + w.length))) return true;
  const joins = (x: { w: string } | null) => x !== null && /^(?:and|or|&)$/i.test(x.w);
  if (joins(prev) && personNeighbour(text, prevWord(text, prev!.at), id)) return true;
  if (joins(next) && personNeighbour(text, nextWord(text, next!.at + next!.w.length), id)) return true;
  return false;
}
/** "john at acme." / "[name] at acme": the word after "at" that follows a person, at the end of a clause, is the
 * organisation of an address. */
function addressOrg(text: string, w: string, offset: number, id: Identity): boolean {
  const prev = prevWord(text, offset);
  if (prev === null || prev.w.toLowerCase() !== "at") return false;
  if (!/^[ \t]*(?:[.,;:!?)\n]|$)/.test(text.slice(offset + w.length))) return false;
  return personNeighbour(text, prevWord(text, prev.at), id);
}

/** What a word of a text is, for masking and for the leak check alike (one decision, so the two can never disagree):
 * the author, their company, this recipient ({first}, {their_org}), another person or proper noun ("name"), or null
 * (a known word, kept).
 * - Vocabulary default deny: a word that is not known vocabulary (knownWord) is a name in any case.
 * - Known words: never the author or company when ordinary. A known contact is a name when capitalised ("Ask Will"),
 *   and in lower case when it is not an ordinary word. A capitalised known word mid-sentence is a name unless allowed
 *   (weekdays, languages, acronyms; a month only in a date). At the start of a sentence it is a name when the next
 *   word is one ("Will Smith", "April Smith"), when it is a month outside a date, or on evidence (a name of these
 *   messages, an unambiguous s18 given or family name, the same word capitalised mid-sentence in this text).
 * - A given name that is also a word ("grace", "Will") next to a name goes with it ("grace raman", "Raman Will").
 * `vocab` is kept for callers; vocabulary default deny no longer needs it. */
export type IdentityHit = "author" | "company" | "first" | "their_org" | "name" | null;
export function identityHit(text: string, w: string, offset: number, id: Identity, vocab: ReadonlySet<string>, scope: MaskScope = {}): IdentityHit {
  void vocab;
  if (isPlaceholder(w)) return null;
  const b = base(w);
  const ordinary = ordinaryWord(b);
  if (!ordinary && inIdentity(id, "author", b)) return "author";
  if (!ordinary && inIdentity(id, "company", b)) return "company";
  const first = scope.first == null ? null : base(scope.first);
  const org = scope.org == null ? null : scope.org.toLowerCase();
  if (first !== null && b === first) return "first";
  if (!isCap(w) && org !== null && b === org) return "their_org";
  if (isCap(w) && org !== null && b.length >= 3 && (b === org || org.startsWith(b))) return "their_org";
  if ([...w].length < 2) return null;
  // A lexicon name (s18 GIVEN, FAMILY or ambiguous): capitalised anywhere (a month only outside a date; the
  // generator's own sentence openers stay), or in lower case next to a person or a cue word.
  if (lexName(b) && isCap(w)) {
    const initial = initialAt(text, offset);
    if (MONTHS.has(b)) return monthKept(text, w, offset) ? null : "name";
    // "Will you", "May I": a modal opening a question is the verb.
    const modalQuestion = MODALS.has(b) && initial && /^[ \t]+(?:i|you|we|they|he|she|it|this|that|there)(?![\p{L}])/iu.test(text.slice(offset + w.length));
    if (!modalQuestion && !(GENERATOR_OPENERS.has(b) && initial)) return "name";
  } else if (personWord(b) && !isCap(w) && !MODALS.has(b) && lowerLexName(text, w, offset, id)) return "name";
  if (addressOrg(text, w, offset, id)) return "name";
  if (!knownWord(b)) return "name";
  const adjacent = () => (GIVEN.has(b) || AMBIGUOUS_GIVEN.has(b)) && (nextIsName(text, offset + w.length, id) || neighbourIsName(text, prevWord(text, offset), id));
  if (!isCap(w)) {
    if (ordinary) return adjacent() ? "name" : null;
    if (inIdentity(id, "contacts", b)) return "name";
    return adjacent() ? "name" : null;
  }
  const initial = initialAt(text, offset);
  if (inIdentity(id, "contacts", b) && !(ordinary && GENERATOR_OPENERS.has(b) && initial)) return "name";
  // Mid-sentence: a capitalised word is a name unless it is allowed (allowedCap).
  if (!initial) return allowedCap(text, w, offset) ? null : "name";
  if (MONTHS.has(b)) return monthKept(text, w, offset) ? null : "name";
  if (nextIsName(text, offset + w.length, id)) return "name";
  if (ordinary || CAP_ALLOW.has(b) || /^i(?:['’]\p{L}+)?$/u.test(b)) return null;
  if (inIdentity(id, "names", b)) return "name";
  if ((GIVEN.has(b) || FAMILY.has(b)) && !AMBIGUOUS_GIVEN.has(b)) return "name";
  for (const m of text.matchAll(TOKEN_RE)) if (m.index !== offset && base(m[0]) === b && isCap(m[0]) && !initialAt(text, m.index ?? 0)) return "name";
  return null;
}

const HIT_PLACEHOLDER = { author: "{sender}", company: "{company}", first: "{first}", their_org: "{their_org}", name: "[name]" } as const;

/** Masked text: contacts, figures, handles and paths, then every word identityHit names, as its placeholder, repeated
 * until nothing changes (a word next to a name masked in the first pass is masked in the next), so masked text is
 * never itself a leak. `vocab` is kept for callers. */
export function maskText(text: string, id: Identity, scope: MaskScope = {}, vocab: ReadonlySet<string> = id.vocab ?? new Set()): string {
  let t = maskContacts(text);
  for (let pass = 0; pass < 8; pass++) {
    const cur = t;
    const out = cur.replace(TOKEN_RE, (w, offset: number) => {
      const hit = identityHit(cur, w, offset, id, vocab, scope);
      return hit === null ? w : HIT_PLACEHOLDER[hit];
    });
    t = out.replace(NESTED_RE, (m, p: string) => (isPlaceholder(p) ? p : m));
    if (t === cur) break;
  }
  return t;
}

/** The masked core of one message (greeting, sign-off, quotes and signature removed) and its greeting name. */
export function maskedCore(m: PlaybookMessage, id: Identity): { core: string; first: string | null } {
  const c = cleanEmail({ id: m.id, to: m.to, subject: m.subject, body: m.body, sentAt: m.sentAt });
  const first = c.greeting === null ? null : (GREETING_NAME_RE.exec(c.greeting)?.[1] ?? null);
  const org = m.to.map((a) => addressParts(a).org).find((o) => o !== null) ?? null;
  return { core: maskText(c.core, id, { first, org }), first };
}

export { EMAIL_RE, HOST_RE, PHONE_RE, TOKEN_RE, URL_RE, WWW_RE, base as identityBase, initialAt, isCap, plainWord, GENERIC };
