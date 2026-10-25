// Blind test (research section 4): hold back N sent emails, build the pack on the rest, draft each held-back email
// from its content, and report. Proxy metrics are computed in code; the real test is the human one: a shuffled
// A/B file (which one did you write?) with the answer key in a separate file. Ship when the user cannot pick their
// own email in more than 1 of 3 pairs.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, ModelConfig } from "../models/model.ts";
import { tokenize } from "./bm25.ts";
import { cleanEmail } from "./clean.ts";
import { draftInTone } from "./draft.ts";
import { bucketCorpus, styleCardFor, toneDir, type TonePack } from "./pack.ts";
import { greetingForm, signForm } from "./style.ts";
import { BUCKETS, type SentEmail } from "./types.ts";
import { ruleBucket } from "./bucket.ts";

export interface BlindItem {
  id: string;
  subject: string;
  real: string;
  draft: string;
  metrics: { wordRatio: number; greetingMatch: boolean; signMatch: boolean; overlap: number };
  warnings: string[];
}

export interface BlindReport {
  items: BlindItem[];
  trainedOn: string[];
  summary: { n: number; meanWordRatio: number; greetingMatch: number; signMatch: number; meanOverlap: number; rule: string };
  abFile: string;
  keyFile: string;
}

export interface BlindOptions {
  home: string;
  emails: readonly SentEmail[];
  holdBack: number;
  model: Model;
  models: ModelConfig;
  now?: () => number;
}

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const round2 = (x: number) => Math.round(x * 100) / 100;

function jaccard(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export async function runBlindTest(o: BlindOptions): Promise<BlindReport> {
  const now = (o.now ?? Date.now)();
  const n = Math.max(1, Math.min(Math.floor(o.holdBack), o.emails.length - 1));
  // Deterministic hold-out: the n emails with the smallest hash of their id.
  const order = [...o.emails].sort((a, b) => (h(a.id) < h(b.id) ? -1 : 1));
  const held = order.slice(0, n);
  const rest = order.slice(n);

  const corpus = await bucketCorpus(rest);
  const pack: TonePack = { corpus, cards: {} };
  for (const b of BUCKETS) {
    const entries = corpus.filter((e) => e.bucket === b);
    if (entries.length > 0) pack.cards[b] = await styleCardFor(b, entries, o.model, o.models, now);
  }

  const items: BlindItem[] = [];
  for (const m of held) {
    const real = cleanEmail(m);
    const first = /^(?:Hi|Hello|Hey|Dear)\s+([A-Z][\w'-]*),$/.exec(real.greeting ?? "")?.[1] ?? "";
    // The held-back email's own content is the brief: this tests the voice, not the facts.
    const facts = `content to convey (the user's own points for this email, keep them):\n${real.core}`;
    const d = await draftInTone({ pack, bucket: ruleBucket(real), recipient: { email: m.to[0] ?? "", firstName: first }, subject: m.subject, facts, model: o.model, models: o.models });
    const draft = cleanEmail({ ...m, body: d.body });
    const realWords = Math.max(1, real.core.split(/\s+/).length);
    items.push({
      id: m.id,
      subject: m.subject,
      real: real.text,
      draft: d.body,
      metrics: {
        wordRatio: round2(draft.core.split(/\s+/).length / realWords),
        greetingMatch: greetingForm(draft.greeting) === greetingForm(real.greeting),
        signMatch: signForm(draft) === signForm(real),
        overlap: round2(jaccard(draft.core, real.core)),
      },
      warnings: d.warnings,
    });
  }

  const dir = join(toneDir(o.home), "blind-test", String(now));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pairs: string[] = ["# Which one did you write?", "", "For each pair, note A or B. Then compare with key.json.", ""];
  const key: Array<{ pair: number; id: string; real: "A" | "B" }> = [];
  items.forEach((it, i) => {
    const realFirst = parseInt(h(`${it.id}:${now}`).slice(0, 2), 16) % 2 === 0;
    const [a, b] = realFirst ? [it.real, it.draft] : [it.draft, it.real];
    pairs.push(`## Pair ${i + 1}: ${it.subject}`, "", "### A", "", a, "", "### B", "", b, "");
    key.push({ pair: i + 1, id: it.id, real: realFirst ? "A" : "B" });
  });
  const abFile = join(dir, "pairs.md");
  const keyFile = join(dir, "key.json");
  writeFileSync(abFile, pairs.join("\n"), { mode: 0o600 });
  writeFileSync(keyFile, JSON.stringify(key, null, 2) + "\n", { mode: 0o600 });

  const mean = (f: (i: BlindItem) => number) => round2(items.reduce((s, i) => s + f(i), 0) / Math.max(1, items.length));
  return {
    items,
    trainedOn: rest.map((m) => m.id),
    summary: {
      n: items.length,
      meanWordRatio: mean((i) => i.metrics.wordRatio),
      greetingMatch: mean((i) => (i.metrics.greetingMatch ? 1 : 0)),
      signMatch: mean((i) => (i.metrics.signMatch ? 1 : 0)),
      meanOverlap: mean((i) => i.metrics.overlap),
      rule: "ship when you pick your own email in at most 1 of 3 pairs",
    },
    abFile,
    keyFile,
  };
}
