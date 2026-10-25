// Draft one email in the user's tone: style card + 3-5 retrieved past emails + facts + recipient -> drafting model.
// The draft is checked in code: numbers must come from the facts or recipient (ADR 0005), gaps are flagged.
import { readFileSync } from "node:fs";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { untrustedBlock } from "../workflows/untrusted.ts";
import { retrieveExamples, type TonePack } from "./pack.ts";
import type { Bucket } from "./types.ts";

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

const BLOCKS = ["style_card", "examples", "facts", "recipient", "subject"] as const;

/**
 * The user turn for one draft. Everything copied from mail, the screen (OCR subject and recipient in a dry run), the
 * recipient list or a model-written style card is an untrusted block (REVIEW-1 M5); the instructions are fixed text.
 */
export function draftPrompt(req: Omit<DraftRequest, "model" | "models">, examples: ReturnType<typeof retrieveExamples>): string {
  const block = (name: (typeof BLOCKS)[number], text: string) => untrustedBlock(name, text, BLOCKS);
  return [
    block("style_card", req.pack.cards[req.bucket] ?? "(no style card yet: follow the examples)"),
    block("examples", examples.map((e, i) => `--- example ${i + 1}\nSubject: ${e.subject}\n\n${e.text}`).join("\n")),
    block("facts", req.facts.trim()),
    block("recipient", JSON.stringify(req.recipient)),
    block("subject", req.subject),
    "",
    "Write the email body now.",
  ].join("\n");
}

export async function draftInTone(req: DraftRequest): Promise<DraftResult> {
  const query = [req.subject, req.recipient.org ?? "", req.recipient.notes ?? "", req.recipient.email.split("@")[1] ?? ""].join(" ");
  const examples = retrieveExamples(req.pack, query, { bucket: req.bucket, k: 4 });
  const raw = await req.model.complete({ role: "draft", model: modelFor("draft", req.models), system: draftSystemPrompt(), prompt: draftPrompt(req, examples), maxTokens: 800 });
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
