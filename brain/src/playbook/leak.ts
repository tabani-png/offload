// De-personalisation check, fail closed: a playbook (or a notes edit, or a model's wording) that still holds a
// person's name, an address, a phone, a link, a figure that is not one of the playbook's own counts, or the author's
// name or company is refused. Findings carry the kind and the field path, never the value.
import { EMAIL_RE, HOST_RE, identityBase, inIdentity, isCap, isPlaceholder, ordinaryWord, PHONE_RE, TOKEN_RE, URL_RE, WWW_RE, type Identity } from "./mask.ts";
import type { Playbook } from "./types.ts";

export type LeakKind = "author" | "company" | "name" | "email" | "phone" | "link" | "number";

export interface Leak {
  kind: LeakKind;
  /** Field path, e.g. "rules[2].text". */
  path: string;
}

export class PlaybookLeakError extends Error {
  constructor(readonly leaks: Leak[]) {
    super(`the playbook kept a personal detail (${leaks.slice(0, 5).map((l) => `${l.kind} in ${l.path}`).join(", ")}${leaks.length > 5 ? ", ..." : ""}); nothing was written`);
  }
}

const NUM_RE = /\d+(?:\.\d+)?/g;
const LOCAL = new Set(["playbook.json", "playbook.md", "facts.md", "skill.md"]);

/** Every word written in lower case in these texts: the vocabulary a capitalised word may come from. */
export function lowerWords(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of t.match(TOKEN_RE) ?? []) if (!isPlaceholder(w) && !isCap(w)) out.add(identityBase(w));
  return out;
}

/** Leaks in one text field. A name is a word of the identity (plain or hashed), a known contact in lower case, or any
 * capitalised word that is not
 * generic, not common and not written in lower case anywhere in `vocab` or this text: a name the identity set never
 * saw (one a model added, or one from mail no longer here) is caught too. */
export function findTextLeaks(text: string, id: Identity, allowedNumbers: ReadonlySet<string>, path: string, vocab: ReadonlySet<string> = lowerWords([text])): Leak[] {
  const out: Leak[] = [];
  const add = (kind: LeakKind) => {
    if (!out.some((l) => l.kind === kind)) out.push({ kind, path });
  };
  if ((text.match(EMAIL_RE) ?? []).length > 0) add("email");
  if ((text.match(URL_RE) ?? []).length > 0 || (text.match(WWW_RE) ?? []).length > 0 || (text.match(HOST_RE) ?? []).some((h) => !LOCAL.has(h.toLowerCase()) && !/^\d+(?:\.\d+)+$/.test(h))) add("link");
  if ((text.match(PHONE_RE) ?? []).some((p) => p.replace(/\D/g, "").length >= 9)) add("phone");
  for (const n of text.match(NUM_RE) ?? []) if (!allowedNumbers.has(n)) add("number");
  for (const w of text.match(TOKEN_RE) ?? []) {
    // Only the defined placeholders are skipped: a word in any other brackets ("{northzone}") is checked as text.
    if (isPlaceholder(w)) continue;
    const b = identityBase(w);
    // An ordinary word (common, generic, or one the generator writes) is never a leak, even when an identity set or an
    // older digest holds it: the generator's own wording must not fail the build.
    if (ordinaryWord(b)) continue;
    if (inIdentity(id, "author", b)) add("author");
    else if (inIdentity(id, "company", b)) add("company");
    else if (isCap(w) && [...w].length >= 2 && (inIdentity(id, "names", b) || !vocab.has(b))) add("name");
    else if (!isCap(w) && [...w].length >= 2 && inIdentity(id, "contacts", b)) add("name");
  }
  return out;
}

/** Every number the playbook's own counts hold (the only figures its text may state, ADR 0005). */
export function allowedNumbers(pb: Pick<Playbook, "stats" | "outcomes" | "cadence">): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.add(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(pb.stats);
  walk(pb.outcomes);
  walk(pb.cadence);
  return out;
}

/** Text fields of a playbook, with their paths. Warnings are fixed code text (kinds and paths, never content). */
export function textFields(pb: Pick<Playbook, "message" | "rules" | "templates" | "skeletons" | "avoid" | "notes">): Array<[string, string]> {
  const out: Array<[string, string]> = [["message", pb.message]];
  pb.rules.forEach((r, i) => out.push([`rules[${i}].text`, r.text]));
  pb.templates.forEach((t, i) => {
    out.push([`templates[${i}].text`, t.text]);
    t.slots.forEach((s, j) => out.push([`templates[${i}].slots[${j}].says`, s.says]));
  });
  pb.skeletons.forEach((s, i) => out.push([`skeletons[${i}]`, s]));
  pb.avoid.forEach((a, i) => out.push([`avoid[${i}]`, a]));
  out.push(["notes", pb.notes]);
  return out;
}

/** All leaks of a playbook against an identity set. Empty = clean. */
export function checkDepersonalised(pb: Playbook, id: Identity): Leak[] {
  const nums = allowedNumbers(pb);
  const fields = textFields(pb);
  const vocab = lowerWords(fields.map(([, t]) => t));
  return fields.flatMap(([path, text]) => findTextLeaks(text, id, nums, path, vocab));
}

/** Throws PlaybookLeakError on any leak (fail closed). */
export function assertDepersonalised(pb: Playbook, id: Identity): void {
  const leaks = checkDepersonalised(pb, id);
  if (leaks.length > 0) throw new PlaybookLeakError(leaks);
}
