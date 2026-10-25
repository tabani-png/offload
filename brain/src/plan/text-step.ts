// s14 text steps of a general workflow (a ticket reply, a chat message, a scorecard note): the cheap model
// (claude-sonnet-5-5, role "step") writes the text from the item's MASKED source text, the user's measured style card,
// 3-5 of their own past texts (BM25) and the user context. Everything copied from the screen is an untrusted block
// (REVIEW-1 M5). The draft is checked in code: a number that is not in the source is flagged (ADR 0005).
import { maskText } from "../grouping/normalize.ts";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { numbersNotIn } from "../tone/draft.ts";
import { retrieveTextExamples, type TextTonePack } from "../tone/text-source.ts";
import type { UserContext } from "../types.ts";
import { userContextBlock } from "../understanding/context.ts";
import { UNTRUSTED_RULE, untrustedBlock } from "../workflows/untrusted.ts";

const BLOCKS = ["style_card", "examples", "source"] as const;

export const STEP_SYSTEM = [
  "You write one short piece of text a person writes many times a day at work: a reply, a message or a note.",
  "Write it the way they do: follow their style card and their past texts. Use only facts in the source block.",
  "Never invent a number, a date, an amount or a name. If something is missing, write [missing: what].",
  "Reply with the text only.",
  UNTRUSTED_RULE,
].join("\n");

export function stepPrompt(o: { what: string; source: string; pack: TextTonePack | null; user?: UserContext }): string {
  const examples = o.pack === null ? [] : retrieveTextExamples(o.pack, o.source);
  return [
    userContextBlock(o.user),
    untrustedBlock("style_card", o.pack?.card ?? "(no examples of their own texts yet: keep it short and plain)", BLOCKS),
    untrustedBlock("examples", examples.map((e, i) => `--- example ${i + 1}\n${e.text}`).join("\n"), BLOCKS),
    untrustedBlock("source", maskText(o.source).slice(0, 4000), BLOCKS),
    "",
    `Write the ${o.what} now.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface TextStepResult {
  text: string;
  examplesUsed: string[];
  warnings: string[];
}

/** The router's check of a text step (ADR 0008 ladder): an empty draft or a number not in the source escalates. */
export function stepCheck(source: string): (text: string) => string | null {
  return (text) => {
    if (text.trim() === "") return "empty draft";
    return numbersNotIn(text, [maskText(source)]).length > 0 ? "a number that is not in the source" : null;
  };
}

export async function draftTextStep(o: { what: string; source: string; pack: TextTonePack | null; user?: UserContext; model: Model; models: ModelConfig; stepKey?: string }): Promise<TextStepResult> {
  const examples = o.pack === null ? [] : retrieveTextExamples(o.pack, o.source);
  const raw = await o.model.complete({ role: "step", model: modelFor("step", o.models), system: STEP_SYSTEM, prompt: stepPrompt(o), maxTokens: 800, validate: stepCheck(o.source), ...(o.stepKey === undefined ? {} : { stepKey: o.stepKey }) });
  const text = raw.replace(/^```\w*\n?|\n?```$/g, "").trim();
  const warnings: string[] = [];
  for (const n of numbersNotIn(text, [o.source])) warnings.push(`number not in the source: ${n}`);
  for (const m of text.match(/\[missing:[^\]]*\]/g) ?? []) warnings.push(`gap: ${m}`);
  if (text === "") warnings.push("empty draft");
  return { text, examplesUsed: examples.map((e) => e.id), warnings };
}
