// Draft one email in the user's tone: style card + 3-5 retrieved past emails + facts + recipient -> drafting model.
// The draft is checked in code: numbers must come from the facts or recipient (ADR 0005), gaps are flagged.
import { readFileSync } from "node:fs";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { untrustedBlock } from "../workflows/untrusted.ts";
import { retrieveExamples, type TonePack } from "./pack.ts";
import type { Bucket } from "./types.ts";
import type { Playbook } from "../playbook/types.ts";

export interface Recipient {
  email: string;
  firstName: string;
  lastName?: string;
  org?: string;
  notes?: string;
}

export interface DraftRequest {
  pack: TonePack;
  bucket: Bucket;
  recipient: Recipient;
  subject: string;
  /** facts.md text: the only facts the draft may state. */
  facts: string;
  model: Model;
  models: ModelConfig;
  /** s19: the workflow's messaging playbook. The draft says its message in the voice of `pack` (the current user). */
  playbook?: Playbook | null;
}

export interface DraftResult {
  body: string;
  /** Corpus ids of the retrieved examples. */
  examplesUsed: string[];
  warnings: string[];
}

let cachedPrompt: string | null = null;
export function draftSystemPrompt(): string {
  cachedPrompt ??= readFileSync(new URL("../workflows/prompts/draft-email.md", import.meta.url), "utf8");
  return cachedPrompt;
}

const NUM_RE = /\$?\d[\d,]*(?:\.\d+)?(?:(?:k|m|bn)(?![a-z])|%)?/gi;
const normNum = (s: string) => s.toLowerCase().replace(/[\s,]/g, "");

/** Numbers in `text` that appear in none of `sources` (after removing spaces and thousands separators). */
export function numbersNotIn(text: string, sources: readonly string[]): string[] {
  const known = new Set(sources.flatMap((s) => (s.match(NUM_RE) ?? []).map(normNum)));
  const bare = new Set([...known].map((n) => n.replace(/[^\d.]/g, "")));
  const out: string[] = [];
  for (const m of text.match(NUM_RE) ?? []) {
    const n = normNum(m);
    if (!known.has(n) && !bare.has(n.replace(/[^\d.]/g, "")) && !out.includes(m.trim())) out.push(m.trim());
  }
  return out;
}

const BLOCKS = ["style_card", "examples", "playbook", "facts", "recipient", "subject"] as const;

/** s19: appended to the system prompt when a playbook is given. */
export const PLAYBOOK_DRAFT_RULES = [
  "",
  "## The playbook",
  "- <playbook> says what this kind of message says: the message to get across, the rules, the shape (slots in order).",
  "  It was learned from someone's past messages with everything personal removed.",
  "- Say the playbook's message, in the shape of its template, but in the voice of <style_card> and <examples>: their",
  "  greeting, sentence length, sign-off and name. Never use another person's name, sign-off or phrases.",
  "- The playbook never adds facts: state only what is in <facts> and <recipient>.",
].join("\n");

/** The playbook as the drafting model sees it: the message, the rules and the first-message template on one line. */
export function playbookBlockText(pb: Playbook): string {
  const t = pb.templates.find((x) => x.id === "first_touch") ?? pb.templates[0];
  return [
    `message: ${pb.message}`,
    ...pb.rules.map((r) => `${r.kind === "do" ? "do" : "don't"}: ${r.text}`),
    ...(t === undefined ? [] : [`template: ${t.slots.map((s) => `{${s.slot}}`).join(" ")}`, ...t.slots.map((s) => `- {${s.slot}}: ${s.says}`)]),
    ...(pb.notes.trim() === "" ? [] : [`notes: ${pb.notes.trim()}`]),
  ].join("\n");
}

/**
 * The user turn for one draft. Everything copied from mail, the screen (OCR subject and recipient in a dry run), the
 * recipient list or a model-written style card is an untrusted block (REVIEW-1 M5); the instructions are fixed text.
 */
export function draftPrompt(req: Omit<DraftRequest, "model" | "models">, examples: ReturnType<typeof retrieveExamples>): string {
  const block = (name: (typeof BLOCKS)[number], text: string) => untrustedBlock(name, text, BLOCKS);
  return [
    block("style_card", req.pack.cards[req.bucket] ?? "(no style card yet: follow the examples)"),
    block("examples", examples.map((e, i) => `--- example ${i + 1}\nSubject: ${e.subject}\n\n${e.text}`).join("\n")),
    ...(req.playbook == null ? [] : [block("playbook", playbookBlockText(req.playbook))]),
    block("facts", req.facts.trim()),
    block("recipient", JSON.stringify(req.recipient)),
    block("subject", req.subject),
    "",
    "Write the email body now.",
  ].join("\n");
}

export async function draftInTone(req: DraftRequest): Promise<DraftResult> {
  const query = [req.subject, req.recipient.org ?? "", req.recipient.notes ?? "", req.recipient.email.split("@")[1] ?? ""].join(" ");
  // s19: with a playbook, a user with no emails of this kind (a successor) still gets their own voice from all of
  // their sent emails; the message comes from the playbook.
  const own = req.pack.corpus.some((e) => e.bucket === req.bucket);
  const pack = req.playbook != null && !own ? { ...req.pack, corpus: req.pack.corpus.map((e) => ({ ...e, bucket: req.bucket })) } : req.pack;
  const examples = retrieveExamples(pack, query, { bucket: req.bucket, k: 4 });
  const system = req.playbook == null ? draftSystemPrompt() : `${draftSystemPrompt()}${PLAYBOOK_DRAFT_RULES}\n`;
  const raw = await req.model.complete({ role: "draft", model: modelFor("draft", req.models), system, prompt: draftPrompt(req, examples), maxTokens: 800 });
  const body = raw.replace(/^```\w*\n?|\n?```$/g, "").trim();
  const warnings: string[] = [];
  for (const n of numbersNotIn(body, [req.facts, JSON.stringify(req.recipient), req.subject])) warnings.push(`number not in the facts: ${n}`);
  for (const m of body.match(/\[missing:[^\]]*\]/g) ?? []) warnings.push(`gap: ${m}`);
  const signs = examples.map((e) => e.signName).filter((s): s is string => s !== null);
  const usual = signs[0];
  if (usual !== undefined && signs.filter((s) => s === usual).length * 2 > signs.length && !body.trimEnd().endsWith(usual)) warnings.push(`does not sign off as "${usual}"`);
  if (body === "") warnings.push("empty draft");
  return { body, examplesUsed: examples.map((e) => e.id), warnings };
}
