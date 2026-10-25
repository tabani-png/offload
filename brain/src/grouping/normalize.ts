// Rule features for task grouping: masked titles, title templates, URL path patterns, OCR tokens, identifiers.
// All pure functions.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const TIME_RE = /\b\d{1,2}:\d{2}(?:\s?[ap]m)?\b|\b\d{1,2}\s?[ap]m\b/gi;
/** Long tokens mixing letters and digits (thread ids, doc ids, hashes). */
const ID_RE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\b/g;
const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

export const WILDCARD = "<*>";

/** s18: a person placeholder (privacy/names.ts) keeps its number, so a masked prompt can still be un-masked. */
const PERSON_RE = /(<person:(?:\d+|me)(?:\.[a-z]+)?(?:~\d+)?>)/;

/** Masks the parts of a title or OCR text that vary per item: emails, URLs, dates, times, ids, numbers. */
export function maskText(text: string): string {
  const parts = text.includes("<person:") ? text.split(PERSON_RE) : [text];
  if (parts.length > 1) return parts.map((part, i) => (i % 2 === 1 ? part : maskText(part))).join("");
  return text
    .replace(EMAIL_RE, "<email>")
    .replace(URL_RE, "<url>")
    .replace(DATE_RE, "<date>")
    .replace(TIME_RE, "<time>")
    .replace(ID_RE, "<id>")
    .replace(NUMBER_RE, "<n>");
}

export function tokenize(maskedTitle: string): string[] {
  return maskedTitle.split(/\s+/).filter((t) => t !== "");
}

export function extractEmails(text: string): string[] {
  const found = text.match(EMAIL_RE) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase()))].sort();
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/** URL path with ids and numbers masked; query and fragment dropped. "" when there is no URL. */
export function urlPattern(url: string): string {
  if (url === "") return "";
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL (e.g. a bare host): there is no path pattern to learn.
    return "";
  }
  return path
    .split("/")
    .map((seg) => {
      if (seg === "") return seg;
      if (/^\d+$/.test(seg)) return "<n>";
      if (seg.length >= 16 || (seg.length >= 8 && /\d/.test(seg) && /[A-Za-z]/.test(seg))) return "<id>";
      // Hyphenated slugs name one item (a person, a post): "/in/kofi-larsen/" -> "/in/<slug>/".
      if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(seg)) return "<slug>";
      return seg;
    })
    .join("/");
}

export function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** 2 * LCS / (|a| + |b|): 1 for identical token lists, 0 for disjoint ones. */
export function sequenceSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/** Aligns `tokens` with a template; literals both share are kept, every gap becomes one wildcard. */
export function mergeTemplate(template: readonly string[], tokens: readonly string[]): string[] {
  const lit: string[] = [];
  const wildBefore: boolean[] = [];
  let pendingWild = false;
  for (const t of template) {
    if (t === WILDCARD) pendingWild = true;
    else {
      lit.push(t);
      wildBefore.push(pendingWild);
      pendingWild = false;
    }
  }
  const wildAtEnd = pendingWild;
  const n = lit.length;
  const m = tokens.length;
  // dp[i][j] = LCS length of lit[i..] and tokens[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = lit[i] === tokens[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lit[i] === tokens[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  const out: string[] = [];
  const wild = () => {
    if (out[out.length - 1] !== WILDCARD) out.push(WILDCARD);
  };
  let pi = -1;
  let pj = -1;
  for (const [mi, mj] of matches) {
    let gap = mi - pi > 1 || mj - pj > 1;
    for (let k = pi + 1; k <= mi; k++) if (wildBefore[k] === true) gap = true;
    if (gap) wild();
    out.push(lit[mi]!);
    pi = mi;
    pj = mj;
  }
  if (n - pi > 1 || m - pj > 1 || wildAtEnd) wild();
  return out;
}

export interface TitleCluster {
  /** Template text, e.g. "Re: Acme seed round for <*> - <email> - Gmail". */
  template: string;
  tokens: string[];
  /** Indices into the input list. */
  members: number[];
}

const PROPER_WORD_RE = /^[A-Z][A-Za-z'’-]*$/;
export const NAME = "<name>";

/** Runs of two or more capitalised words ("Kofi Larsen", "Sequoia Capital") collapse to one name token. */
export function collapseNames(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let run = 0;
  for (const t of tokens) {
    if (PROPER_WORD_RE.test(t)) {
      run++;
      if (run === 2) out[out.length - 1] = NAME;
      else if (run === 1) out.push(t);
      continue;
    }
    run = 0;
    out.push(t);
  }
  return out;
}

/** Similarity of a title to a template counts only the template's literal tokens; names are collapsed first. */
function templateSimilarity(template: readonly string[], tokens: readonly string[]): number {
  return sequenceSimilarity(
    collapseNames(template.filter((t) => t !== WILDCARD)),
    collapseNames(tokens),
  );
}

/**
 * Greedy, order-stable template clustering (a Drain-style log template miner that allows different lengths).
 * Titles join the first cluster at or above `threshold`; the cluster template keeps the shared literals. This is how
 * names normalise: tokens that vary between otherwise identical titles become wildcards.
 */
export function clusterTitles(titles: readonly (readonly string[])[], threshold = 0.6): TitleCluster[] {
  const clusters: TitleCluster[] = [];
  titles.forEach((tokens, idx) => {
    let best: TitleCluster | null = null;
    let bestSim = threshold;
    for (const c of clusters) {
      const sim = templateSimilarity(c.tokens, tokens);
      if (sim >= bestSim && (best === null || sim > bestSim)) {
        best = c;
        bestSim = sim;
      }
    }
    if (best === null) {
      clusters.push({ template: tokens.join(" "), tokens: [...tokens], members: [idx] });
      return;
    }
    const target: TitleCluster = best;
    target.tokens = mergeTemplate(target.tokens, tokens);
    target.template = target.tokens.join(" ");
    target.members.push(idx);
  });
  return clusters;
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have hi i i'm if in is it its me my of on or our so that the this to us was we we're with you your".split(" "),
);

/** Lowercased content words of masked OCR text, placeholders and stopwords removed. */
export function ocrTokens(text: string): string[] {
  return maskText(text)
    .toLowerCase()
    .replace(/<[a-z*]+>/g, " ")
    .split(/[^a-z']+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
