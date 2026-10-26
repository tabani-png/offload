// s18 person-name masker (ADR 0010). Deterministic rules, no model: names from the run so far, the user's own name and
// their contacts; honorific + name; greeting/role cue + name; given + family pairs; signatures; lone given names; email
// local parts that equal a name. Common words, UI labels, months, products and organisations are left alone
// (privacy/lexicon.ts). `NameMap.mask` gives stable per-run placeholders (<person:qzkt.1>, <person:qzkt.1.first>,
// <person:qzkt.me>; "qzkt" is the run's random tag) so a model can refer to people consistently; `unmask` restores them
// exactly, on the Mac. The map lives in memory only. Placeholder-shaped text that arrives in the input (a notes cell, an
// inbound message) carries no run tag: it becomes <name> before masking, so it can never restore to a real name.
import { randomBytes } from "node:crypto";
import { AMBIGUOUS_GIVEN, CLOSINGS, COMMON, FAMILY, GIVEN, GREETING_CUES, HONORIFICS, ORG, PARTICLES, PRODUCT, PROTECTED_PHRASES, ROLE_CUES, ROLE_MAILBOXES, STRONG_CUE_PAIRS, WEAK_CUES } from "./lexicon.ts";

/** Every placeholder a NameMap writes: <person:TAG.N>, <person:TAG.N.first>, <person:TAG.me~2> (TAG = 4 letters). */
export const PERSON_PLACEHOLDER_RE = /<person:[a-z]{4}\.(?:\d+|me)(?:\.[a-z]+)?(?:~\d+)?>/g;
/** Anything shaped like a person placeholder, in any case, with or without a run tag (also after maskText turned its
 * digits into <n>): what input text may carry to impersonate one. */
const PERSON_LIKE_RE = /<\s*person\s*:[^\n>]{0,40}>+/gi;
/** The grouping code's token for a name in stored text (grouping/normalize.ts NAME). */
export const NAME_TOKEN = "<name>";

export interface NameMapOptions {
  /** Names known to be people (contacts): matched wherever they appear, any case. */
  known?: readonly string[];
  /** The user's own name(s), e.g. "Muhammad Ali" (placeholder <person:me>). */
  self?: readonly string[];
  /** true = the user's own name is sent as written and never masked. Default false (masked, restored locally). */
  keepSelf?: boolean;
}

type Part = "full" | "first" | "last" | "email";

interface Person {
  id: string;
  full?: string;
  first?: string;
  last?: string;
  bareUsed: boolean;
}

interface Tok {
  start: number;
  end: number;
  text: string;
  lower: string;
  /** Punctuation right after the token ("," ":" "." ...), "" when a space or the line end follows. */
  rest: string;
  /** Punctuation right before the token ("(", "\"" ...). */
  lead: string;
  /** Everything between this word and the next one on the line. */
  after: string;
  protectedTok: boolean;
}

const NAME_RE = /^\p{Lu}\p{Ll}*(?:\p{Lu}\p{Ll}+)?(?:[-'’]\p{Lu}?\p{Ll}+)*$/u;
const INITIAL_RE = /^\p{Lu}$/u;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Tokens other masking already wrote (<email>, <n>, <name>, <*>, <person:1.first>): never touched again. */
const ANY_PLACEHOLDER_RE = /<(?:[a-z][a-z0-9_]*(?::[a-z0-9.~]+)?|\*)>/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const B_START = "(?<![\\p{L}\\p{N}_])";
const B_END = "(?![\\p{L}\\p{N}_])";

const isNameWord = (t: Tok) => NAME_RE.test(t.text) && t.text.length >= 2 && !COMMON.has(t.lower) && !GREETING_CUES.has(t.lower) && !HONORIFICS.has(t.lower);
const isBlocker = (lower: string) => ORG.has(lower) || PRODUCT.has(lower);
/** An organisation or product word ("Couriers", "Xero"): a run with one is never a person. */
export const isOrgOrProductWord = (word: string) => isBlocker(word.toLowerCase().replace(/[.,]+$/, ""));

/** Name-shaped tokens of a single name part ("Amara", "O'Brien"): no common, product or organisation word. */
function usablePart(s: string | undefined): s is string {
  if (s === undefined || s.length < 2 || !NAME_RE.test(s)) return false;
  const l = s.toLowerCase();
  return !COMMON.has(l) && !isBlocker(l) && !GREETING_CUES.has(l) && !HONORIFICS.has(l);
}

/** A name part the user gave (their own name, a contact) or a cue confirmed ("Dear Will,"): any word of two letters
 * or more except a title or a greeting. The common-word filter is not applied again, so "Will" and "May" count. */
function trustedPart(s: string | undefined): s is string {
  if (s === undefined || s.length < 2 || !/^\p{L}[\p{L}\p{M}'’-]*$/u.test(s)) return false;
  const l = s.toLowerCase();
  return !GREETING_CUES.has(l) && !HONORIFICS.has(l);
}

/** The words of one line, with the punctuation around each. Words are letter runs (apostrophes and hyphens inside),
 * so a JSON row ("firstName":"Anna") or a slug splits into words as well as plain text does. */
function tokenize(line: string, offset: number, isProtected: (start: number, end: number) => boolean): Tok[] {
  const words = [...line.matchAll(/\p{L}[\p{L}'’-]*/gu)];
  const out: Tok[] = [];
  words.forEach((m, i) => {
    let core = m[0];
    let tail = "";
    const poss = /['’]s$/.exec(core);
    if (poss !== null && core.length > 3) {
      core = core.slice(0, -2);
      tail = poss[0];
    }
    const trim = /[-'’]+$/.exec(core);
    if (trim !== null) {
      core = core.slice(0, -trim[0].length);
      tail = `${trim[0]}${tail}`;
    }
    const start = m.index!;
    const prevEnd = i === 0 ? 0 : words[i - 1]!.index! + words[i - 1]![0].length;
    const nextStart = i + 1 < words.length ? words[i + 1]!.index! : line.length;
    const before = line.slice(prevEnd, start);
    const after = tail + line.slice(start + m[0].length, nextStart);
    const lead = /\S*$/u.exec(before)?.[0] ?? "";
    const rest = /^\S*/u.exec(after)?.[0] ?? "";
    out.push({ start: offset + start, end: offset + start + core.length, text: core, lower: core.toLowerCase(), rest, lead, after, protectedTok: isProtected(offset + start, offset + start + core.length) || lead.endsWith("<") });
  });
  return out;
}

/** Joined tokens: only spaces between them (a middle initial "J." may continue a run). */
function joins(a: Tok, b: Tok): boolean {
  return /^[ \t]+$/.test(a.after) || (INITIAL_RE.test(a.text) && /^\.[ \t]+$/.test(a.after)) ? b.lead === "" : false;
}

interface Context {
  greeting: boolean;
  role: boolean;
  weak: boolean;
  honorific: boolean;
  signature: boolean;
}

function contextBefore(toks: readonly Tok[], i: number, signature: boolean): Context {
  const p = toks[i - 1];
  const pp = toks[i - 2];
  const c: Context = { greeting: false, role: false, weak: false, honorific: false, signature };
  if (p === undefined) return c;
  const sep = p.rest.replace(/['’]s$/, "").replace(/["'“”‘’]/g, "");
  if (HONORIFICS.has(p.lower) && (sep === "" || sep === ".")) c.honorific = true;
  if (GREETING_CUES.has(p.lower) && /^[,:!]?$/.test(sep)) c.greeting = true;
  if (ROLE_CUES.has(p.lower) && sep === ":") c.role = true;
  if (WEAK_CUES.has(p.lower) && /^:?$/.test(sep) && p.text === p.lower) c.weak = true;
  if (pp !== undefined && pp.rest === "" && /^:?$/.test(sep) && STRONG_CUE_PAIRS.includes(`${pp.lower} ${p.lower}`)) c.role = true;
  return c;
}

/** The name inside one segment of name-shaped tokens, or null. */
function decide(seg: Tok[], c: Context): Tok[] | null {
  if (seg.length === 0 || seg.some((t) => isBlocker(t.lower))) return null;
  const words = seg.filter((t) => !INITIAL_RE.test(t.text) && !PARTICLES.has(t.text));
  if (words.length === 0) return null;
  const strong = c.greeting || c.role || c.signature || c.honorific;
  if (words.length === 1) {
    const w = words[0]!;
    // A lone family name from the lexicon ("CV - <*> Moreau.pdf"): the lexicon holds no everyday words.
    return GIVEN.has(w.lower) || FAMILY.has(w.lower) || strong ? [w] : null;
  }
  const gi = seg.findIndex((t) => GIVEN.has(t.lower));
  if (strong && seg.length <= 3) return seg;
  if (gi >= 0) return seg.slice(gi, gi + 4);
  const fi = (() => {
    for (let k = seg.length - 1; k >= 1; k--) if (FAMILY.has(seg[k]!.lower)) return k;
    return -1;
  })();
  // "Xander Okafor", not "Reviewing Okafor": the word before a family name must not read as a verb or a noun form.
  if (fi >= 1) return /(?:ing|ed|tion|ment|ness|ly|ity)$/.test(seg[fi - 1]!.lower) ? null : seg.slice(fi - 1, fi + 1);
  // "Ludovica van der Berg": a particle between capitalised words is a family name.
  if (seg.length <= 5 && seg.some((t, k) => k > 0 && k < seg.length - 1 && PARTICLES.has(t.text))) return seg;
  // "with Ngozi Adeyemi": two or three name-shaped words after a weak cue.
  if (c.weak && words.length >= 2 && seg.length <= 3) return seg;
  return null;
}

export class NameMap {
  private readonly people: Person[] = [];
  /** Candidate surfaces (exact text) -> the person and part they name. */
  private readonly surfaces = new Map<string, { person: Person; part: Part }>();
  /** Contacts not met yet: lower-case full name -> the name as written. */
  private readonly known = new Map<string, string>();
  private readonly toPlaceholder = new Map<string, string>();
  private readonly toSurface = new Map<string, string>();
  private readonly kept = new Set<string>();
  private readonly regexes = new Map<string, RegExp>();
  private keptRes: RegExp[] = [];
  private next = 1;
  /** This map's random run tag: input text cannot know it, so it cannot name a placeholder this map wrote. */
  private readonly tag = [...randomBytes(4)].map((b) => String.fromCharCode(97 + (b % 26))).join("");

  constructor(o: NameMapOptions = {}) {
    for (const k of o.known ?? []) {
      const t = k.replace(/\s+/g, " ").trim();
      if (t.split(" ").some(trustedPart)) this.known.set(t.toLowerCase(), t);
    }
    const self = (o.self ?? []).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length >= 2);
    if (self.length > 0) {
      if (o.keepSelf === true) {
        for (const s of self) {
          this.kept.add(s.toLowerCase());
          for (const p of s.split(" ")) if (trustedPart(p)) this.kept.add(p.toLowerCase());
        }
        this.keptRes = [...this.kept].sort((a, b) => b.length - a.length).map((k) => new RegExp(`${B_START}${escapeRe(k)}${B_END}`, "giu"));
      } else {
        const me: Person = { id: "me", bareUsed: false };
        this.people.push(me);
        for (const s of self) this.attach(me, s.split(" "), true);
      }
    }
  }

  /** People this map has placeholders for. */
  get size(): number {
    return this.people.filter((p) => p.bareUsed).length;
  }

  /** The map never serialises its names (a log or a JSON body gets a count only). */
  toJSON(): { people: number } {
    return { people: this.size };
  }

  /** `trusted`: the user gave the name or a cue confirmed it, so its parts skip the common-word filter. A name found in
   * uncued prose keeps it: "Will Smith" there registers the full name, not "Will" alone. */
  private attach(p: Person, tokens: readonly string[], trusted = false): void {
    const ok = trusted ? trustedPart : usablePart;
    const words = tokens.filter((t) => t !== "" && !PARTICLES.has(t) && !/^\p{Lu}\.?$/u.test(t));
    if (tokens.length >= 2) {
      p.full ??= tokens.join(" ");
      this.addSurface(tokens.join(" "), p, "full");
    }
    const first = words[0];
    const last = words.length >= 2 ? words[words.length - 1] : undefined;
    if (ok(first)) {
      p.first ??= first;
      this.addSurface(first, p, "first");
    }
    if (ok(last)) {
      p.last ??= last;
      this.addSurface(last, p, "last");
    }
  }

  private addSurface(s: string, person: Person, part: Part): void {
    if (!this.surfaces.has(s) && !this.kept.has(s.toLowerCase())) this.surfaces.set(s, { person, part });
  }

  private personFor(tokens: readonly string[], trusted = false): Person {
    const text = tokens.join(" ");
    const lower = text.toLowerCase();
    for (const p of this.people) if (p.full?.toLowerCase() === lower) return p;
    if (tokens.length === 1) {
      for (const p of this.people) if (p.first === text || p.last === text) return p;
      for (const p of this.people) if (p.full === undefined && p.first?.toLowerCase() === lower) return p;
    } else {
      const words = tokens.filter((t) => !PARTICLES.has(t) && !/^\p{Lu}\.?$/u.test(t));
      // "Amara" seen alone first, then "Amara Okafor": the same person.
      const lone = this.people.find((p) => p.full === undefined && p.last === undefined && p.first === words[0]);
      if (lone !== undefined) {
        this.attach(lone, tokens, trusted);
        return lone;
      }
    }
    const p: Person = { id: "", bareUsed: false };
    this.people.push(p);
    this.attach(p, tokens, trusted);
    return p;
  }

  private placeholderFor(surface: string, person: Person, part: Part): string {
    const hit = this.toPlaceholder.get(surface);
    if (hit !== undefined) return hit;
    if (person.id === "") person.id = String(this.next++);
    let ph: string;
    if (!person.bareUsed) {
      ph = `<person:${this.tag}.${person.id}>`;
      person.bareUsed = true;
    } else {
      ph = `<person:${this.tag}.${person.id}.${part}>`;
      for (let k = 2; this.toSurface.has(ph); k++) ph = `<person:${this.tag}.${person.id}.${part}~${k}>`;
    }
    this.toPlaceholder.set(surface, ph);
    this.toSurface.set(ph, surface);
    return ph;
  }

  private isKept(text: string): boolean {
    return this.kept.has(text.toLowerCase());
  }

  /** Finds names in `text` by rule and adds them to the map (no replacement). */
  learn(text: string): void {
    const prot = protectedRanges(text, this.keptRes);
    const isProt = (s: number, e: number) => prot.some(([a, b]) => s < b && e > a);
    /** Names found, and whether a cue (greeting, role, honorific, signature) confirmed each one. */
    const found: Array<{ name: string[]; cued: boolean }> = [];
    let offset = 0;
    let prevLine = "";
    for (const line of text.split("\n")) {
      const toks = tokenize(line, offset, isProt);
      const signature = CLOSINGS.test(prevLine.trim()) && toks.length >= 1 && toks.length <= 3 && toks.every((t, i) => isNameWord(t) && !isBlocker(t.lower) && (i === toks.length - 1 || joins(t, toks[i + 1]!)));
      let i = 0;
      while (i < toks.length) {
        const t = toks[i]!;
        const nx = toks[i + 1];
        // "Will Smith", "May Chen", "Dear Will": a given name that is also a word needs a name after it or a cue before.
        const ambiguous = !t.protectedTok && AMBIGUOUS_GIVEN.has(t.lower) && NAME_RE.test(t.text) && ((nx !== undefined && joins(t, nx) && isNameWord(nx) && (FAMILY.has(nx.lower) || GIVEN.has(nx.lower))) || (() => {
          const c = contextBefore(toks, i, false);
          return c.greeting || c.honorific || c.role;
        })());
        const startsSeg = !t.protectedTok && (isNameWord(t) || ambiguous || (INITIAL_RE.test(t.text) && t.rest === "."));
        if (!startsSeg || INITIAL_RE.test(t.text)) {
          i++;
          continue;
        }
        const seg: Tok[] = [t];
        let j = i;
        while (j + 1 < toks.length && joins(toks[j]!, toks[j + 1]!)) {
          const n = toks[j + 1]!;
          if (n.protectedTok) break;
          if (isNameWord(n) || (INITIAL_RE.test(n.text) && n.rest === ".")) {
            seg.push(n);
            j++;
            continue;
          }
          // Particles ("van der", "de la") only between name words.
          let k = j + 1;
          while (k < toks.length && PARTICLES.has(toks[k]!.text) && k + 1 < toks.length && joins(toks[k]!, toks[k + 1]!)) k++;
          if (k === j + 1 || !isNameWord(toks[k]!) || toks[k]!.protectedTok) break;
          for (let q = j + 1; q < k; q++) seg.push(toks[q]!);
          j = k - 1;
        }
        while (seg.length > 0 && (INITIAL_RE.test(seg[seg.length - 1]!.text) || PARTICLES.has(seg[seg.length - 1]!.text))) seg.pop();
        const c = contextBefore(toks, i, signature);
        const name = ambiguous ? seg : decide(seg, c);
        const cued = c.greeting || c.role || c.honorific || c.signature;
        if (name !== null && !this.isKept(name.map((x) => x.text).join(" ")) && !(name.length === 1 && this.isKept(name[0]!.text))) found.push({ name: name.map((x) => x.text), cued });
        i = j + 1;
      }
      offset += line.length + 1;
      if (line.trim() !== "") prevLine = line;
    }
    // Full names before lone names, so "Amara" after "Amara Okafor" is the same person.
    for (const f of found.filter((x) => x.name.length > 1)) this.personFor(f.name, f.cued);
    for (const f of found.filter((x) => x.name.length === 1)) if (!this.surfaces.has(f.name[0]!)) this.personFor(f.name, f.cued);
    // Contacts and names already known that appear in this text, any case.
    for (const [lower, written] of this.known) {
      if ([...this.people].some((p) => p.full?.toLowerCase() === lower || (p.full === undefined && p.first?.toLowerCase() === lower))) continue;
      if (surfaceRegex(written, written.includes(" ")).test(text)) this.personFor(written.split(" "), true);
    }
    for (const m of text.matchAll(EMAIL_RE)) this.learnEmail(m[0]);
  }

  private learnEmail(email: string): void {
    const local = email.slice(0, email.indexOf("@"));
    if (ROLE_MAILBOXES.has(local.toLowerCase()) || this.isKept(local)) return;
    const segs = local.split(/[._+-]/).filter((s) => s !== "" && !/^\d+$/.test(s));
    if (segs.length === 0 || segs.length > 3) return;
    const knownParts = new Map<string, Person>();
    for (const [s, v] of this.surfaces) if (v.part !== "email" && !s.includes(" ")) knownParts.set(s.toLowerCase(), v.person);
    const ok = segs.every((s) => s.length === 1 || GIVEN.has(s.toLowerCase()) || FAMILY.has(s.toLowerCase()) || knownParts.has(s.toLowerCase()));
    const anchor = segs.find((s) => knownParts.has(s.toLowerCase()) || GIVEN.has(s.toLowerCase()));
    if (!ok || anchor === undefined || segs.some((s) => ROLE_MAILBOXES.has(s.toLowerCase()))) return;
    if (this.surfaces.has(local)) return;
    const person = knownParts.get(segs.map((s) => s.toLowerCase()).find((s) => knownParts.has(s)) ?? "") ?? this.personFor([cap(anchor)]);
    this.surfaces.set(local, { person, part: "email" });
  }

  /** Placeholder-shaped text this map did not write becomes <name>: only the map's own placeholders survive. */
  neutralise(text: string): string {
    return text.includes("<") ? text.replace(PERSON_LIKE_RE, (m) => (this.toSurface.has(m) ? m : NAME_TOKEN)) : text;
  }

  /** `text` with every person name replaced by its placeholder. Idempotent: this map's placeholders already in the text
   * stay; any other placeholder-shaped text (injected in the input) becomes <name>. */
  mask(input: string): string {
    if (input === "") return input;
    const text = this.neutralise(input);
    this.learn(text);
    const prot = protectedRanges(text, this.keptRes);
    const spans: Array<{ start: number; end: number; found: string; person: Person; part: Part }> = [];
    const add = (start: number, end: number, found: string, person: Person, part: Part) => {
      if (prot.some(([a, b]) => start < b && end > a)) return;
      if (spans.some((x) => start < x.end && end > x.start)) return;
      spans.push({ start, end, found, person, part });
    };
    // Longest first, so "Amara Okafor" wins over "Amara"; full names match any case and across . _ - (slugs, ids).
    const lower = text.toLowerCase();
    const sorted = [...this.surfaces.entries()].filter(([s]) => s.length >= 2 && lower.includes(s.split(/[\s._-]/)[0]!.toLowerCase())).sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
    for (const [surface, { person, part }] of sorted) {
      let re = this.regexes.get(surface);
      if (re === undefined) {
        re = surfaceRegex(surface, part === "full");
        this.regexes.set(surface, re);
      }
      for (const m of text.matchAll(re)) add(m.index!, m.index! + m[0].length, m[0], person, part);
    }
    // Placeholders are numbered in order of first appearance.
    spans.sort((a, b) => a.start - b.start);
    let out = "";
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + this.placeholderFor(s.found, s.person, s.part);
      at = s.end;
    }
    return out + text.slice(at);
  }

  /** Placeholders back to the real names. A placeholder this map never wrote stays as it is. */
  unmask(text: string): string {
    return text.replace(PERSON_PLACEHOLDER_RE, (ph) => this.toSurface.get(ph) ?? ph);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Regex for one surface, any case ("AMARA", "amara's", "zorblax"); multi-word names also across space . _ - ("amara.okafor",
 * "amara-okafor"). A single word that is also an everyday word ("Will", "May", "Bill") matches only as written: the
 * lower-case "will" is the verb, and masking it would garble every sentence the model reads. */
function surfaceRegex(surface: string, loose: boolean): RegExp {
  if (!loose) {
    const l = surface.toLowerCase();
    const word = COMMON.has(l) || AMBIGUOUS_GIVEN.has(l) || isBlocker(l);
    return new RegExp(`${B_START}${escapeRe(surface)}${B_END}`, word ? "gu" : "giu");
  }
  const parts = surface.split(/[\s._-]+/).filter((p) => p !== "").map(escapeRe);
  return new RegExp(`${B_START}${parts.join("[\\s._-]+")}${B_END}`, "giu");
}

const PROTECTED_RES = PROTECTED_PHRASES.map((p) => new RegExp(`${B_START}${escapeRe(p)}${B_END}`, "gu"));

/** Ranges never masked: placeholders already present, protected company phrases and names the user keeps. */
function protectedRanges(text: string, kept: readonly RegExp[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const re of [ANY_PLACEHOLDER_RE, ...PROTECTED_RES, ...kept]) for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Placeholders (any placeholder-shaped text) -> the grouping token <name>; a run of them ("<name> <name>") becomes one. */
export function collapsePlaceholders(text: string): string {
  return text.replace(PERSON_LIKE_RE, NAME_TOKEN).replace(/<name>(?:[ \t]+<name>)+/g, NAME_TOKEN);
}

/** Names a reply still leaves unfilled after unmasking: any placeholder-shaped text (the model invented it, or echoed
 * one from the input) and the <name> token. */
export function unrestoredPlaceholders(text: string): string[] {
  return [...new Set([...(text.match(PERSON_LIKE_RE) ?? []), ...(text.match(/<name>/g) ?? [])])];
}

/** Text for a note or a description: every person name becomes <name> (no numbering, no map kept). */
export function maskNamesForStorage(text: string, o: NameMapOptions | NameMap = {}): string {
  const m = o instanceof NameMap ? o : new NameMap(o);
  return collapsePlaceholders(m.mask(text));
}
