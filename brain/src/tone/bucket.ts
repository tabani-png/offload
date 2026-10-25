// Bucket sent emails by kind. Rules by default; the cheap model may decide, but only within BUCKETS
// (any other answer falls back to the rules).
import { untrustedBlock } from "../workflows/untrusted.ts";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { BUCKETS, type Bucket, type CleanEmail } from "./types.ts";

const FOLLOW_UP_RE = /\b(?:following up|follow up|bump|bumping|circling back|any thoughts)\b/i;
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;
const RESCHEDULE_RE = /\b(?:invite|reschedul\w*|move our call|calendar)\b/i;
const OUTREACH_RE = /\b(?:raising|seed|round|deck|investors?|mrr|traction)\b/i;

export function ruleBucket(e: CleanEmail): Bucket {
  const text = `${e.subject}\n${e.core}`;
  if (FOLLOW_UP_RE.test(e.core)) return "follow_up";
  if (TIME_RE.test(e.core) || (/^re:/i.test(e.subject) && RESCHEDULE_RE.test(e.core))) return "scheduling";
  if (OUTREACH_RE.test(text)) return "investor_outreach";
  return "other";
}

export interface Bucketer {
  bucket(e: CleanEmail): Promise<Bucket>;
}

export const ruleBucketer: Bucketer = { bucket: async (e) => ruleBucket(e) };

const isBucket = (s: string): s is Bucket => (BUCKETS as readonly string[]).includes(s);

export function modelBucketer(model: Model, cfg: ModelConfig): Bucketer {
  return {
    async bucket(e) {
      const hint = ruleBucket(e);
      const answer = await model.complete({
        role: "bucket",
        model: modelFor("bucket", cfg),
        system: "You sort a person's sent emails by kind. Answer with one label only.",
        prompt: [
          `Labels: ${BUCKETS.join(", ")}.`,
          "investor_outreach = a first email to an investor about a raise; scheduling = finding or moving a meeting time;",
          "follow_up = a nudge on an earlier email; other = anything else.",
          `A rule-based guess is given; overrule it only when it is wrong.`,
          `<bucket_hint>${hint}</bucket_hint>`,
          untrustedBlock("email", `Subject: ${e.subject}\n\n${e.core}`, ["bucket_hint"]),
        ].join("\n"),
        maxTokens: 10,
      });
      const label = answer.trim().toLowerCase().replace(/[^a-z_]/g, "");
      return isBucket(label) ? label : hint;
    },
  };
}
