// Small BM25 (Okapi, k1 1.2, b 0.75) for retrieving the user's own past emails (LaMP: BM25 is strong for email).
// No dependencies. Deterministic: ties break by id.

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have hi hello hey i if in into is it its me my of on or our so that the their them then there these they this to us was we were will with you your dear".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$%]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export interface Bm25Doc {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export class Bm25 {
  private readonly docs: Array<{ id: string; tf: Map<string, number>; len: number }>;
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(
    docs: readonly Bm25Doc[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    this.docs = docs.map((d) => {
      const tokens = tokenize(d.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { id: d.id, tf, len: tokens.length };
    });
    this.avgLen = this.docs.length === 0 ? 0 : this.docs.reduce((n, d) => n + d.len, 0) / this.docs.length;
  }

  private idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
  }

  /** Documents with a positive score, best first, at most k. */
  search(query: string, k: number): Bm25Hit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.docs.length === 0) return [];
    const hits: Bm25Hit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (f === undefined) continue;
        score += (this.idf(t) * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1)));
      }
      if (score > 0) hits.push({ id: d.id, score });
    }
    hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return hits.slice(0, k);
  }
}
