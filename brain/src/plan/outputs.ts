// s14 generic dry-run outputs: per instance, what the workflow would have produced next to what the user did, for any
// output type. Values (ids, amounts, dates, names, titles) are found and copied by CODE from the masked OCR of the read
// steps; a model only ever writes the text of a text step (ADR 0005). What the user did comes from the commit screen's
// OCR and the frame notes of that instance (evidence ids are kept).
import type { OutputDTO, OutputFieldDTO, OutputType, PlanVariantDTO } from "../api/s14-types.ts";
import type { InstanceEvidence, TaskEvidence } from "./evidence.ts";
import { stepOutputs } from "./steps.ts";

export type ValueKind = "id" | "amount" | "date" | "email" | "title" | "name";
export type Values = Record<ValueKind, string[]>;

const ID_RES = [/\b[A-Z]{2,6}-\d{3,}\b/g, /#\d{3,}\b/g];
const AMOUNT_RE = /\b\d{1,3}(?:,\d{3})+(?:\.\d{2})\b|\b\d+\.\d{2}\b/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b|\bdue in \d+ days\b/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TITLE_RE = /^(.{2,60}?) at (.{2,60})$/;

const uniq = (xs: string[]) => [...new Set(xs)];

/** Values the code can copy from source text, each kind in order of appearance. */
export function extractValues(texts: readonly string[]): Values {
  const out: Values = { id: [], amount: [], date: [], email: [], title: [], name: [] };
  for (const t of texts) {
    for (const re of ID_RES) out.id.push(...(t.match(re) ?? []));
    out.amount.push(...(t.match(AMOUNT_RE) ?? []));
    out.date.push(...(t.match(DATE_RE) ?? []));
    out.email.push(...(t.match(EMAIL_RE) ?? []));
    const lines = t.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    for (const l of lines) {
      const m = TITLE_RE.exec(l);
      if (m !== null && !/\d/.test(m[1]!)) out.title.push(m[1]!.trim());
    }
    const first = lines[0];
    if (first !== undefined && first.length <= 60 && !/\d/.test(first) && !/[<>]/.test(first)) out.name.push(first);
  }
  for (const k of Object.keys(out) as ValueKind[]) out[k] = uniq(out[k]);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A field label in an OCR line: 1 to 3 words of letters before the value ("Reference", "Amount due"). */
function labelBefore(line: string, value: string): string | null {
  const i = line.indexOf(value);
  if (i <= 0) return null;
  const label = line.slice(0, i).replace(/[:\s]+$/, "").trim();
  return /^[A-Za-z][A-Za-z ]{0,30}$/.test(label) && label.split(" ").length <= 3 ? label : null;
}

export interface LearnedField {
  label: string;
  kind: ValueKind;
  /** Instances whose commit screen showed this label with a value of this kind. */
  support: number;
  position: number;
}

/** Field labels of the commit screen learned across the week: label -> the kind of value the user puts there. */
export function learnFields(ev: TaskEvidence, readSteps: ReadonlySet<string>, commitSteps: ReadonlySet<string>): LearnedField[] {
  const votes = new Map<string, { kind: ValueKind; n: number; pos: number }>();
  let seen = 0;
  for (const inst of ev.instances) {
    const commitOcr = [...commitSteps].flatMap((s) => inst.bySteps.get(s)?.ocr ?? []);
    if (commitOcr.length === 0) continue;
    seen += 1;
    const src = extractValues([...readSteps].flatMap((s) => inst.bySteps.get(s)?.ocr ?? []));
    const done = new Set<string>();
    commitOcr.flatMap((t) => t.split("\n")).forEach((line, pos) => {
      for (const kind of Object.keys(src) as ValueKind[]) {
        for (const v of src[kind]) {
          const label = labelBefore(line.trim(), v);
          if (label === null) continue;
          const key = `${label}\u0000${kind}`;
          if (done.has(key)) continue;
          done.add(key);
          const cur = votes.get(key) ?? { kind, n: 0, pos: 0 };
          cur.n += 1;
          cur.pos += pos;
          votes.set(key, cur);
        }
      }
    });
  }
  const min = Math.max(2, Math.ceil(seen * 0.3));
  const best = new Map<string, LearnedField>();
  for (const [key, v] of votes) {
    if (v.n < min) continue;
    const label = key.split("\u0000")[0]!;
    const cur = best.get(label);
    if (cur === undefined || v.n > cur.support) best.set(label, { label, kind: v.kind, support: v.n, position: v.pos / v.n });
  }
  return [...best.values()].sort((a, b) => a.position - b.position || (a.label < b.label ? -1 : 1));
}

/** The kind of value a field name asks for ("job title" -> title, "work email" -> email). */
export function kindForName(name: string): ValueKind | null {
  const n = name.toLowerCase();
  if (/title|role|position/.test(n)) return "title";
  if (/e-?mail/.test(n)) return "email";
  if (/amount|total|price|cost|sum/.test(n)) return "amount";
  if (/date|due/.test(n)) return "date";
  if (/number|\bid\b|ref|reference|invoice|order|ticket/.test(n)) return "id";
  if (/name|company|supplier|customer|vendor/.test(n)) return "name";
  return null;
}

/** "stage change" -> "move to the next stage"; "ticket solved" -> "mark solved"; "public reply" -> "send the reply". */
export function actionFor(output: string): string {
  const o = output.toLowerCase();
  if (/stage/.test(o)) return "move to the next stage";
  if (/solved|closed|resolved/.test(o)) return "mark solved";
  if (/reply|message|answer/.test(o)) return "send the reply";
  if (/^draft /.test(o)) return `save the ${o.slice("draft ".length)} as a draft`;
  return `save the ${o}`;
}

export interface Built {
  ours: OutputDTO;
  theirs: OutputDTO & { excerpt: string };
  match: { matched: number; total: number; value: number; arithmetic: string };
  commit: { verb: string; fields: Array<[string, string]>; tool?: string; missing?: string[] } | null;
  warnings: string[];
}

export interface Shape {
  outputType: OutputType;
  readSteps: Set<string>;
  commitSteps: Set<string>;
  commitVerb: string;
  commitObject: string;
  /** Week-level outputs of the commit steps (frame notes). */
  weekOutputs: string[];
  learned: LearnedField[];
}

/** The parts of a plan the output builders need. */
export function shapeOf(v: PlanVariantDTO, ev: TaskEvidence, outputType: OutputType): Shape {
  const readSteps = new Set(v.steps.filter((s) => s.type === "read").flatMap((s) => s.sourceSteps));
  const commitSteps = new Set(v.steps.filter((s) => s.type === "commit").flatMap((s) => s.sourceSteps));
  // A screen where the item is read and then written (a ticket) is both: its text is the source.
  const first = v.steps.find((s) => s.type === "commit");
  const step = first?.sourceSteps[0] === undefined ? undefined : ev.stepById.get(first.sourceSteps[0]);
  const weekOutputs = stepOutputs([...commitSteps].flatMap((s) => ev.stepFrames.get(s) ?? []));
  const learned = outputType === "form_fields" || outputType === "rows" ? learnFields(ev, new Set([...readSteps].filter((s) => !commitSteps.has(s))), commitSteps) : [];
  return { outputType, readSteps, commitSteps, commitVerb: step?.verb ?? "save", commitObject: step?.object ?? "record", weekOutputs, learned };
}

const round1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;

function matchOf(matched: number, total: number, what: string): Built["match"] {
  const value = total === 0 ? 0 : matched / total;
  return { matched, total, value: Math.round(value * 1000) / 1000, arithmetic: total === 0 ? `nothing on screen to compare ${what} with` : `${matched} of ${total} ${what} match = ${Math.round(value * 100)}%` };
}

/** Source text of an instance: OCR of its read steps (masked), or of the commit screen when that is where it is read. */
export function sourceText(sh: Shape, inst: InstanceEvidence): string {
  const own = [...sh.readSteps].filter((s) => !sh.commitSteps.has(s)).flatMap((s) => inst.bySteps.get(s)?.ocr ?? []);
  const shared = [...sh.readSteps].filter((s) => sh.commitSteps.has(s)).flatMap((s) => (inst.bySteps.get(s)?.ocr ?? []).slice(0, 1));
  return [...own, ...shared].join("\n").trim();
}

function instanceOutputs(sh: Shape, inst: InstanceEvidence): string[] {
  return stepOutputs([...sh.commitSteps].flatMap((s) => inst.bySteps.get(s)?.frames ?? []));
}

function excerptOf(sh: Shape, inst: InstanceEvidence): string {
  const ocr = [...sh.commitSteps].flatMap((s) => inst.bySteps.get(s)?.ocr ?? []);
  const frame = [...sh.commitSteps].flatMap((s) => inst.bySteps.get(s)?.frames ?? []).find((f) => f.confidence >= 0.5);
  const parts = [ocr.at(-1) ?? "", frame === undefined ? "" : `(${frame.activity})`].filter((p) => p !== "");
  return parts.join("\n").slice(0, 400).trim();
}

/** Fields: form_fields and rows. `text` is null. */
export function buildFields(sh: Shape, inst: InstanceEvidence): Built {
  const src = extractValues([sourceText(sh, inst)]);
  const commitOcr = [...sh.commitSteps].flatMap((s) => inst.bySteps.get(s)?.ocr ?? []);
  const warnings: string[] = [];
  let ours: OutputFieldDTO[];
  let theirs: OutputFieldDTO[];
  if (sh.learned.length > 0) {
    ours = sh.learned.map((f) => ({ label: f.label, value: src[f.kind][0] ?? null }));
    const lines = commitOcr.flatMap((t) => t.split("\n")).map((l) => l.trim());
    theirs = [];
    for (const f of sh.learned) {
      const line = lines.find((l) => l.startsWith(`${f.label} `) || l.startsWith(`${f.label}:`));
      if (line !== undefined) theirs.push({ label: f.label, value: line.slice(f.label.length).replace(/^[:\s]+/, "").trim() });
    }
  } else {
    // The screen does not show the values typed (a sheet without OCR): compare the fields by name, from the notes.
    const names = sh.weekOutputs.length > 0 ? sh.weekOutputs : [sh.commitObject];
    ours = names.map((n) => {
      const k = kindForName(n);
      return { label: n, value: k === null ? null : (src[k][0] ?? null) };
    });
    theirs = instanceOutputs(sh, inst).map((n) => ({ label: n, value: null }));
  }
  for (const f of ours) if (f.value === null) warnings.push(`${f.label}: not on the screen it reads; left for you`);
  let matched = 0;
  for (const t of theirs) {
    const o = ours.find((x) => norm(x.label) === norm(t.label));
    if (o === undefined || o.value === null) continue;
    if (t.value === null || norm(t.value) === norm(o.value)) matched += 1;
  }
  const filled = ours.filter((f) => f.value !== null);
  const verb = sh.commitVerb;
  return {
    ours: { kind: sh.outputType, summary: `${verb.charAt(0).toUpperCase()}${verb.slice(1)} the ${sh.commitObject}: ${filled.length} of ${ours.length} fields filled from the source`, fields: ours, text: null, actions: [sh.outputType === "rows" ? `update the ${sh.commitObject}` : actionFor(sh.weekOutputs[0] ?? sh.commitObject)] },
    theirs: { kind: sh.outputType, summary: theirs.length === 0 ? "No screen note of what you filled in" : `You filled ${theirs.length} field${theirs.length === 1 ? "" : "s"}`, fields: theirs, text: null, actions: instanceOutputs(sh, inst).map(actionFor), excerpt: excerptOf(sh, inst) },
    match: matchOf(matched, theirs.length, "fields"),
    commit: filled.length === 0 ? null : { verb, fields: filled.map((f) => [f.label, f.value!] as [string, string]) },
    warnings,
  };
}

/** Text outputs (ticket_reply, message, email) and stage changes / records with a text part. `text` is drafted
 * elsewhere (text-step.ts) and passed in. */
export function buildActions(sh: Shape, inst: InstanceEvidence, text: string | null, typed: string | null): Built {
  const outs = sh.weekOutputs.length > 0 ? sh.weekOutputs : [sh.outputType === "ticket_reply" || sh.outputType === "message" || sh.outputType === "email" ? "reply" : sh.commitObject];
  const actions = uniq(outs.map(actionFor));
  const theirOuts = instanceOutputs(sh, inst);
  const theirActions = uniq(theirOuts.map(actionFor));
  let matched = theirActions.filter((a) => actions.includes(a)).length;
  let total = theirActions.length;
  if (typed !== null) {
    total += 1;
    if (text !== null && text.trim() !== "") matched += 1;
  }
  const fields: OutputFieldDTO[] = sh.outputType === "stage_change" ? outs.map((o) => ({ label: o, value: /stage/.test(o) ? "next stage" : "drafted" })) : [];
  return {
    ours: { kind: sh.outputType, summary: actions.map((a) => a.charAt(0).toUpperCase() + a.slice(1)).join(", then "), fields, text, actions },
    theirs: { kind: sh.outputType, summary: theirActions.length === 0 ? "No screen note of what you did" : `You did: ${theirActions.join(", then ")}`, fields: theirOuts.map((o) => ({ label: o, value: null })), text: typed, actions: theirActions, excerpt: excerptOf(sh, inst) },
    match: matchOf(matched, total, "actions"),
    commit: { verb: sh.commitVerb, fields: [...fields.map((f) => [f.label, f.value ?? ""] as [string, string]), ...(text === null ? [] : [["text", text] as [string, string]])] },
    warnings: [],
  };
}

export { round1 };
