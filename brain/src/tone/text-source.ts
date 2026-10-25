// s14 text tone source: the user's own words for text-producing workflow steps that are not Sent mail (ticket replies,
// chat messages, notes). Same approach as the Sent-mail pack (research 10 section 4, LaMP): a measured style card +
// BM25 retrieval of 3-5 of the user's own past texts. The examples are what the user TYPED on the commit screen:
// text that appeared between two OCR snapshots of one span while keys were being pressed, masked, never the text
// they were reading. Kept in memory for one dry run or batch; nothing here is written to disk.
import { maskText } from "../grouping/normalize.ts";
import type { Span } from "../types.ts";
import { Bm25 } from "./bm25.ts";

export interface TextExample {
  id: string;
  /** Output type the text belongs to ("ticket_reply", "message", ...). */
  kind: string;
  text: string;
  ts: number;
  /** Event id of the OCR snapshot it was read from. */
  eventId: string;
}

export interface TextTonePack {
  kind: string;
  examples: TextExample[];
  /** Measured in code; rendered as the style card the step prompt gets. */
  card: string;
  measured: { examples: number; medianWords: number; greeting: string | null; signOff: string | null };
}

const GREETING_RE = /^(hi|hello|hey|dear|good (?:morning|afternoon))\b[^\n]{0,40}$/i;
const MIN_TEXT_CHARS = 20;

/**
 * Lines the user typed in one span: lines of a later OCR snapshot that were not in any earlier snapshot of the span,
 * when the span had typing (keys > 0). The first snapshot is what was on screen before typing started.
 */
export function typedText(span: Span): { text: string; eventId: string; ts: number } | null {
  if (span.keys <= 0 || span.ocr.length < 2) return null;
  const seen = new Set<string>();
  for (const l of span.ocr[0]!.text.split("\n")) seen.add(l.trim());
  let best: { text: string; eventId: string; ts: number } | null = null;
  for (const snap of span.ocr.slice(1)) {
    const added = snap.text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !seen.has(l));
    const text = maskText(added.join("\n")).trim();
    if (text.length >= MIN_TEXT_CHARS && (best === null || text.length > best.text.length)) best = { text, eventId: snap.eventId, ts: snap.ts };
  }
  return best;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

function mostCommon(xs: Array<string | null>): string | null {
  const n = new Map<string, number>();
  for (const x of xs) if (x !== null) n.set(x, (n.get(x) ?? 0) + 1);
  const top = [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return top !== undefined && top[1] * 2 >= xs.length ? top[0] : null;
}

/** The pack for one output kind from the spans of the commit step(s). */
export function buildTextTonePack(kind: string, spans: readonly Span[]): TextTonePack {
  const examples: TextExample[] = [];
  for (const s of spans) {
    const t = typedText(s);
    if (t !== null) examples.push({ id: `tx_${t.eventId}`, kind, text: t.text, ts: t.ts, eventId: t.eventId });
  }
  examples.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const words = examples.map((e) => e.text.split(/\s+/).filter((w) => w !== "").length);
  const greeting = mostCommon(examples.map((e) => {
    const first = e.text.split("\n")[0]!.trim();
    return GREETING_RE.test(first) ? first.split(/\s+/)[0]!.replace(/,$/, "") + "," : null;
  }));
  const signOff = mostCommon(examples.map((e) => {
    const last = e.text.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";
    return /^[A-Z][\w'-]{1,30}$/.test(last) ? last : null;
  }));
  const measured = { examples: examples.length, medianWords: median(words), greeting, signOff };
  const card = [
    `# Your ${kind.replace(/_/g, " ")} style (measured from ${examples.length} of your own texts)`,
    `- length: about ${measured.medianWords} words`,
    ...(greeting === null ? [] : [`- greeting: "${greeting}"`]),
    ...(signOff === null ? [] : [`- sign-off: "${signOff}"`]),
  ].join("\n");
  return { kind, examples, card, measured };
}

/** 3-5 of the user's texts closest to `query` (BM25), topped up with the newest ones. */
export function retrieveTextExamples(pack: TextTonePack, query: string, k = 4): TextExample[] {
  const n = Math.min(5, Math.max(3, Math.floor(k)));
  const byId = new Map(pack.examples.map((e) => [e.id, e]));
  const idx = new Bm25(pack.examples.map((e) => ({ id: e.id, text: e.text })));
  const out = idx.search(query, n).map((h) => byId.get(h.id)!);
  for (const e of [...pack.examples].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1))) {
    if (out.length >= n) break;
    if (!out.includes(e)) out.push(e);
  }
  return out.slice(0, Math.min(n, pack.examples.length));
}
