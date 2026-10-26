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
    "reply answer respond write send message comment post draft compose fill key look note fix code test run debug plan " +
    // s20 review 3: action verbs and presence verbs, so their gerunds ("paying", "listening") map too.
    "submit pay publish delete remove export download import deploy merge sign invoice share archive rename order buy purchase refund " +
    "transfer install configure build commit push listen join monitor observe wait inspect examine study"
  ).split(" "),
);

/** s20 review 3: actions that change something outside (a payment, a deletion, a deploy): a gated commit, like a record
 * write. Before, they fell through to reading. */
export const ACTION_VERBS: ReadonlySet<string> = new Set(["submit", "pay", "publish", "delete", "remove", "export", "download", "import", "run", "code", "fix", "debug", "test", "merge", "deploy", "sign", "invoice", "share", "archive", "rename", "order", "buy", "purchase", "refund", "transfer", "install", "configure", "build", "commit", "push"]);

/** s20 review 4: THE verb table (plan/steps.ts, the judge in labeler.ts and the saving all classify with it). */
export const READ_VERBS: ReadonlySet<string> = new Set(["read", "view", "browse", "skim", "check", "look up", "find", "open", "search", "watch", "scroll", "look at", "reading", "reviewing", "comparing", "chat",
  // being there (a call, a meeting) and looking closely are reads too: nothing is changed.
  "attend", "meet", "call", "present", "listen", "join", "monitor", "observe", "wait", "inspect", "examine", "study",
  // getting in and showing a screen change nothing in the app's data.
  "sign in", "sign up", "sign out", "log in", "log out", "share screen"]);
export const JUDGE_VERBS: ReadonlySet<string> = new Set(["review", "screen", "assess", "evaluate", "compare", "triage", "decide", "approve", "score", "grade", "vet"]);
export const RECORD_VERBS: ReadonlySet<string> = new Set(["enter", "key in", "fill in", "update", "edit", "create", "add", "move", "log", "record", "tag", "file", "upload", "match", "reconcile", "copy", "paste", "type", "entering", "editing", "updating", "book", "schedule", "assign", "close"]);
export const TEXT_VERBS: ReadonlySet<string> = new Set(["reply", "answer", "respond", "write", "send", "message", "comment", "post", "draft", "compose", "note"]);
/** Irreversible or money-moving actions: risk 0.5 in the judge, like writing to a person. */
export const IRREVERSIBLE_VERBS: ReadonlySet<string> = new Set(["pay", "refund", "transfer", "buy", "purchase", "order", "delete", "remove", "publish", "deploy", "merge", "push", "sign"]);

/** s20 review 5: approving money (a payment, an expense, an invoice, a refund) in an app is an irreversible commit, not a
 * judgement read. */
export const MONEY_OBJECT_RE = /\b(payments?|expenses?|invoices?|refunds?|bills?|payouts?|transfers?|reimbursements?|purchase orders?)\b/i;
export const isMoneyApproval = (base: string, object: string) => base === "approve" && MONEY_OBJECT_RE.test(object);

/** A base verb that changes something (text, record or action). */
export const isWriteBase = (b: string) => TEXT_VERBS.has(b) || RECORD_VERBS.has(b) || ACTION_VERBS.has(b);
/** A base verb that positively only reads or judges. */
export const isReadOnlyBase = (b: string) => READ_VERBS.has(b) || JUDGE_VERBS.has(b);

/** Particle verbs kept as two words, gerund -> base. */
const PHRASES: Readonly<Record<string, string>> = {
  "signing in": "sign in",
  "sign in": "sign in",
  "signing up": "sign up",
  "sign up": "sign up",
  "signing out": "sign out",
  "sign out": "sign out",
  "logging in": "log in",
  "log in": "log in",
  "logging out": "log out",
  "log out": "log out",
  "sharing screen": "share screen",
  "share screen": "share screen",
  "sharing the screen": "share screen",
  "share the screen": "share screen",
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
  // s20 review 4: several verbs ("reading and replying", "checking, then submitting"): a write or action wins, else the
  // first. Only clause heads count, so an object ("reviewing the post") is never taken for a verb.
  const clauses = v.split(/\s*(?:,|&|\/|\bthen\b|\band\b)\s*/).filter((c) => c !== "");
  if (clauses.length > 1) {
    // s20 review 5: the most dangerous verb names the step: irreversible > action > any other write; a bare "close"
    // ("open and close") is not a write without its object.
    const bases = clauses.map((c) => ({ b: phraseBase(c), bare: !c.includes(" ") }));
    const write = (x: { b: string; bare: boolean }) => isWriteBase(x.b) && !(x.bare && x.b === "close");
    return (bases.find((x) => IRREVERSIBLE_VERBS.has(x.b)) ?? bases.find((x) => ACTION_VERBS.has(x.b)) ?? bases.find(write) ?? bases[0]!).b;
  }
  return phraseBase(v);
}

const SIGN_IN = new Set(["sign in", "sign up", "sign out", "log in", "log out"]);
const SIGN_IN_NEXT = new Set(["to", "into", "with", "on", "at", "account", "app", "portal", "again"]);

function phraseBase(v: string): string {
  if (PHRASES[v] !== undefined) return PHRASES[v]!;
  const words = v.split(" ");
  if (words.length > 1) {
    const two = `${words[0]} ${words[1]}`;
    // s20 review 5: "log in" / "sign in" is signing in only on its own or before a sign-in object ("log in to the
    // portal"); "log in the call" logs the call.
    const signIn = PHRASES[two] !== undefined && SIGN_IN.has(PHRASES[two]!);
    if (PHRASES[two] !== undefined && (!signIn || words.length === 2 || SIGN_IN_NEXT.has(words[2]!))) return PHRASES[two]!;
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
