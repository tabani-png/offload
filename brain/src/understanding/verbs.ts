// s20 verb normalisation. Captioners (small local vision models above all) write verbs as gerunds ("writing",
// "typing a message", "filling in"); every verb table in the brain (labeler, plan/steps) is keyed on base forms, so a
// gerund silently typed a write as reading (blind test, 7 real days). One deterministic mapping, applied where frame
// verbs enter the brain (describe.ts) and again by the verb classifiers. Pure.

/** Base verbs the brain's tables know (labeler WRITE/TRANSFER/REVIEW/LIVE/READ, plan/steps READ/JUDGE/RECORD/TEXT). */
const KNOWN = new Set(
  (
    "read view browse skim check find open search watch scroll chat attend meet call present " +
    "review screen assess evaluate compare triage decide approve score grade vet " +
    "enter copy paste update edit create add move log record tag file upload match reconcile type book schedule assign close " +
    "reply answer respond write send message comment post draft compose fill key look note fix code test run debug plan"
  ).split(" "),
);

/** Particle verbs kept as two words, gerund -> base. */
const PHRASES: Readonly<Record<string, string>> = {
  "filling in": "fill in",
  "filling out": "fill in",
  "fill out": "fill in",
  "keying in": "key in",
  "looking at": "look at",
  "looking up": "look up",
  "looking": "look at",
  "look": "look at",
  "filling": "fill in",
  "fill": "fill in",
  "keying": "key in",
  "key": "key in",
};

/** Gerunds of judgement verbs stay as they are: a small model says "reviewing" for any screen it looks at, and
 * plan/steps.ts (s14) deliberately reads those as reading, not as a judgement step. */
const KEEP = new Set(["reviewing", "comparing"]);

function baseOfWord(w: string): string {
  if (KEEP.has(w) || KNOWN.has(w)) return w;
  if (w.length > 4 && w.endsWith("ing")) {
    const stem = w.slice(0, -3);
    const candidates = [stem, `${stem}e`, /([b-df-hj-np-tv-z])\1$/.test(stem) ? stem.slice(0, -1) : ""];
    const hit = candidates.find((c) => c !== "" && KNOWN.has(c));
    if (hit !== undefined) return hit;
  }
  if (w.length > 3 && w.endsWith("ies") && KNOWN.has(`${w.slice(0, -3)}y`)) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("es") && KNOWN.has(w.slice(0, -2))) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s") && KNOWN.has(w.slice(0, -1))) return w.slice(0, -1);
  return w;
}

/**
 * The base form of a captioned verb: "writing" -> "write", "typing" -> "type", "filling in" -> "fill in",
 * "replies" -> "reply", "typing a message" -> "type" (a known first word wins over the rest of a phrase). Unknown
 * words come back lower-cased and trimmed, unchanged otherwise.
 */
export function baseVerb(verb: string): string {
  const v = verb.toLowerCase().replace(/\s+/g, " ").trim();
  if (v === "") return v;
  if (PHRASES[v] !== undefined) return PHRASES[v]!;
  const words = v.split(" ");
  if (words.length > 1) {
    const two = `${words[0]} ${words[1]}`;
    if (PHRASES[two] !== undefined) return PHRASES[two]!;
    const first = baseOfWord(words[0]!);
    if (KNOWN.has(first) || KEEP.has(first)) return PHRASES[first] ?? first;
    return v;
  }
  const b = baseOfWord(v);
  return PHRASES[b] ?? b;
}

/** Verbs that say someone is looking at a screen, not what they do there: down-weighted in task induction. */
export const GENERIC_VERBS: ReadonlySet<string> = new Set(["review", "reviewing", "view", "look at", "look", "read", "check", "browse", "watch", "scroll", "skim", "open", "comparing", "use", "work", "work on", "see"]);

export const isGenericVerb = (v: string) => GENERIC_VERBS.has(baseVerb(v));
