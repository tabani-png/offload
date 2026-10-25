// Tone pack on disk: $OFFLOAD_HOME/tone/<bucket>.md (editable style cards), index.json (hashes, so user edits are
// kept on rebuild) and corpus.jsonl (cleaned sent emails for retrieval; local only, mode 0600).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelFor, type Model, type ModelConfig } from "../models/model.ts";
import { Bm25 } from "./bm25.ts";
import { ruleBucketer, type Bucketer } from "./bucket.ts";
import { cleanEmail } from "./clean.ts";
import type { MailSource } from "./mail-source.ts";
import { measureStyle, renderStyleCard, STYLE_CARD_SYSTEM, styleCardPrompt } from "./style.ts";
import { BUCKETS, type Bucket, type CorpusEntry, type SentEmail } from "./types.ts";

export interface TonePack {
  corpus: CorpusEntry[];
  cards: Partial<Record<Bucket, string>>;
}

export const toneDir = (home: string) => join(home, "tone");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface ToneIndex {
  version: 1;
  builtAt: number;
  cheapModel: string;
  corpus: number;
  buckets: Partial<Record<Bucket, { file: string; sha256: string; emails: number }>>;
}

export async function bucketCorpus(emails: readonly SentEmail[], bucketer: Bucketer = ruleBucketer): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  for (const m of emails) {
    const c = cleanEmail(m);
    if (c.core === "") continue;
    out.push({ ...c, bucket: await bucketer.bucket(c) });
  }
  return out;
}

/** Style card text for one bucket: measured in code + voice from the cheap model. */
export async function styleCardFor(bucket: Bucket, entries: readonly CorpusEntry[], model: Model, models: ModelConfig, builtAt: number): Promise<string> {
  const st = measureStyle(entries);
  const examples = [...entries].sort((a, b) => b.sentAt - a.sentAt).slice(0, 8);
  const voice = await model.complete({ role: "style_card", model: modelFor("style_card", models), system: STYLE_CARD_SYSTEM, prompt: styleCardPrompt(bucket, st, examples), maxTokens: 600 });
  return renderStyleCard(bucket, st, voice, { model: modelFor("style_card", models), builtAt });
}

export interface BuildToneOptions {
  home: string;
  source: MailSource;
  model: Model;
  models: ModelConfig;
  bucketer?: Bucketer;
  /** Overwrite cards the user edited. */
  force?: boolean;
  limit?: number;
  now?: () => number;
}

export interface BuildToneResult {
  corpus: number;
  buckets: Array<{ bucket: Bucket; emails: number; file: string; action: "written" | "kept_edited" }>;
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readIndex(home: string): ToneIndex | null {
  const p = join(toneDir(home), "index.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as ToneIndex) : null;
}

export async function buildTonePack(o: BuildToneOptions): Promise<BuildToneResult> {
  const now = (o.now ?? Date.now)();
  const dir = toneDir(o.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const corpus = await bucketCorpus(await o.source.listSent({ limit: o.limit ?? 500 }), o.bucketer);
  writePrivate(join(dir, "corpus.jsonl"), corpus.map((e) => JSON.stringify(e)).join("\n") + (corpus.length > 0 ? "\n" : ""));

  const prev = readIndex(o.home);
  const index: ToneIndex = { version: 1, builtAt: now, cheapModel: modelFor("style_card", o.models), corpus: corpus.length, buckets: {} };
  const result: BuildToneResult = { corpus: corpus.length, buckets: [] };
  for (const bucket of BUCKETS) {
    const entries = corpus.filter((e) => e.bucket === bucket);
    if (entries.length === 0) continue;
    const file = join(dir, `${bucket}.md`);
    const recorded = prev?.buckets[bucket]?.sha256;
    if (!o.force && existsSync(file) && recorded !== undefined && sha(readFileSync(file, "utf8")) !== recorded) {
      // The user edited this card: keep it and keep the hash of the version we wrote, so it stays "edited".
      index.buckets[bucket] = { file, sha256: recorded, emails: entries.length };
      result.buckets.push({ bucket, emails: entries.length, file, action: "kept_edited" });
      continue;
    }
    const card = await styleCardFor(bucket, entries, o.model, o.models, now);
    writePrivate(file, card);
    index.buckets[bucket] = { file, sha256: sha(card), emails: entries.length };
    result.buckets.push({ bucket, emails: entries.length, file, action: "written" });
  }
  writePrivate(join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return result;
}

export function loadTonePack(home: string): TonePack | null {
  const dir = toneDir(home);
  const corpusPath = join(dir, "corpus.jsonl");
  if (!existsSync(corpusPath)) return null;
  const corpus = readFileSync(corpusPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as CorpusEntry);
  const cards: Partial<Record<Bucket, string>> = {};
  for (const b of BUCKETS) {
    const p = join(dir, `${b}.md`);
    if (existsSync(p)) cards[b] = readFileSync(p, "utf8");
  }
  return { corpus, cards };
}

/** 3-5 past emails of the bucket closest to `query` by BM25; topped up with the newest ones when few match. */
export function retrieveExamples(pack: TonePack, query: string, opts: { bucket: Bucket; k: number }): CorpusEntry[] {
  const k = Math.min(5, Math.max(3, Math.floor(opts.k)));
  const pool = pack.corpus.filter((e) => e.bucket === opts.bucket);
  const byId = new Map(pool.map((e) => [e.id, e]));
  const idx = new Bm25(pool.map((e) => ({ id: e.id, text: `${e.subject}\n${e.to.join(" ")}\n${e.core}` })));
  const out = idx.search(query, k).map((h) => byId.get(h.id)!);
  for (const e of [...pool].sort((a, b) => b.sentAt - a.sentAt || (a.id < b.id ? -1 : 1))) {
    if (out.length >= k) break;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}
