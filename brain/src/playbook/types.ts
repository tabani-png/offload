// s19 messaging playbook types. A playbook says WHAT a person's messages of one workflow say, to whom, in what shape
// and with what result, with nothing personal left in it: the style card (tone/) says how they sound. Every count,
// share, length and gap is computed in code (ADR 0005); models only label within the vocabularies below and reword.

export const CHANNELS = ["email", "dm", "ticket"] as const;
export type Channel = (typeof CHANNELS)[number];

/** One sent message of a messaging workflow, as sent (quotes and signature still in the body). */
export interface PlaybookMessage {
  id: string;
  channel: Channel;
  to: string[];
  subject: string;
  body: string;
  sentAt: number;
  /** Thread state when the source knows it: the reader answered this message (true) or did not (false). */
  replied?: boolean | null;
  /** Tone bucket of an email, when it came from the tone pack. */
  bucket?: string;
}

export const ROLES = ["first_touch", "follow_up", "reply"] as const;
export const INTENTS = ["book_meeting", "get_reply", "resolve_issue", "confirm_details", "share_resource"] as const;
export const OPENERS = ["personal_hook", "direct_pitch", "problem_first", "short_preface", "acknowledge", "context_reference"] as const;
export const MOVES = ["apology", "hook", "claim", "proof", "fix", "next_step", "alternative", "attachment", "ask"] as const;
export const CTAS = ["meeting", "confirm", "resource", "reply", "none"] as const;
export const PROOFS = ["traction", "customer_outcome", "momentum", "social_proof", "credential", "specific_fix", "timeline", "role_fact"] as const;
export const HOOKS = ["their_portfolio", "their_writing", "their_expertise", "their_preference", "their_work_history", "their_issue_details"] as const;
export const OBJECTIONS = ["adds_new_proof", "lowers_the_ask", "adds_urgency", "plain_bump", "asks_for_feedback", "acknowledges_frustration", "offers_alternative"] as const;
export const AUDIENCES = ["investors", "customers", "candidates", "contacts"] as const;

export type Role = (typeof ROLES)[number];
export type Intent = (typeof INTENTS)[number];
export type Opener = (typeof OPENERS)[number];
export type Move = (typeof MOVES)[number];
export type Cta = (typeof CTAS)[number];
export type Proof = (typeof PROOFS)[number];
export type Hook = (typeof HOOKS)[number];
export type Objection = (typeof OBJECTIONS)[number];
export type Audience = (typeof AUDIENCES)[number];

export type Outcome = "replied" | "no_reply" | "unknown";

/** Structure measured in code. */
export interface Shape {
  words: number;
  sentences: number;
  paragraphs: number;
  questions: number;
  links: number;
  attachments: number;
}

/** The structured read of one message. Labels from the vocabularies; text fields are masked. */
export interface MessageRead {
  id: string;
  threadKey: string;
  role: Role;
  intent: Intent;
  opener: Opener;
  moves: Move[];
  cta: Cta;
  ctaTimeBoxed: boolean;
  proof: Proof[];
  hooks: Hook[];
  objections: Objection[];
  audience: Audience;
  /** The core claim, masked ("{company} watches a week of your work ..."), or null. */
  coreClaim: string | null;
  /** How the offer is positioned, masked, or null. */
  positioning: string | null;
  shape: Shape;
  outcome: Outcome;
  /** "rules" or "model": who set the labels (the model may overrule a rule label within the vocabulary). */
  labelledBy: "rules" | "model";
}

export interface Share {
  value: string;
  count: number;
  /** count / n, rounded to 2 decimals, computed in code. */
  share: number;
}

export interface PatternOutcome {
  dimension: "opener" | "cta" | "hook" | "proof" | "length";
  value: string;
  sent: number;
  replied: number;
  noReply: number;
  unknown: number;
  /** replied + noReply >= MIN_OUTCOME_SAMPLE; below it the pattern reads "too few to say". Never a rate. */
  enough: boolean;
}

export interface Outcomes {
  /** Outcomes are counted over the opening message of each thread. */
  scope: "first_touch";
  messages: number;
  replied: number;
  noReply: number;
  unknown: number;
  minSample: number;
  byPattern: PatternOutcome[];
}

export interface Cadence {
  threads: number;
  followUps: number;
  threadsWithFollowUp: number;
  maxFollowUps: number;
  /** Median whole days from a thread's opening message to its first follow-up; null when no gap is known. */
  medianDaysToFollowUp: number | null;
  /** Follow-ups whose gap could not be read (sent before the opening message, or no opening message). */
  timingUnclear: number;
  followUpMoves: Share[];
  /** At least MIN_OUTCOME_SAMPLE follow-ups: below it the cadence reads "too few to say". */
  enough: boolean;
}

export interface Stats {
  messages: number;
  byRole: Share[];
  intent: Share[];
  audience: Share[];
  opener: Share[];
  cta: Share[];
  ctaTimeBoxed: number;
  proof: Share[];
  hooks: Share[];
  objections: Share[];
  moveSequences: Share[];
  medianWords: number;
  p90Words: number;
  maxQuestions: number;
  messagesWithLinks: number;
  messagesWithAttachments: number;
  /** Derived limits the rules check against (code). */
  limits: { maxWords: number; maxLinks: number; maxQuestions: number };
}

export type RuleCheck =
  | { kind: "cta"; value: Cta }
  | { kind: "opener"; values: Opener[] }
  | { kind: "proof"; value: Proof }
  | { kind: "move"; value: Move }
  | { kind: "max_words"; value: number }
  | { kind: "max_links"; value: number }
  | { kind: "max_questions"; value: number };

export interface Rule {
  id: string;
  kind: "do" | "dont";
  text: string;
  check?: RuleCheck;
}

export const SLOTS = ["greeting", "apology", "hook", "claim", "proof", "fix", "next_step", "alternative", "attachment", "ask", "sign_off"] as const;
export type Slot = (typeof SLOTS)[number];

export interface Template {
  id: "first_touch" | "follow_up" | "reply";
  /** Slots in order, e.g. "{greeting}\n\n{hook} {claim}\n\n{proof}\n\n{ask}\n\n{sign_off}". */
  text: string;
  slots: Array<{ slot: Slot; says: string }>;
  /** Messages this template was read from. */
  from: number;
}

export interface PlaybookHistory {
  version: number;
  at: number;
  change: "built" | "notes";
}

export const PLAYBOOK_SCHEMA = "offload.playbook/1";

export interface Playbook {
  schema: typeof PLAYBOOK_SCHEMA;
  version: number;
  workflowId: string;
  channel: Channel;
  builtAt: number;
  sources: { messages: number; threads: number };
  /** The message they portray, in 2-3 plain sentences. */
  message: string;
  rules: Rule[];
  templates: Template[];
  /** 3-5 de-personalised example skeletons. */
  skeletons: string[];
  cadence: Cadence;
  avoid: string[];
  stats: Stats;
  outcomes: Outcomes;
  /** The user's own notes (checked for personal details like every other text field). */
  notes: string;
  history: PlaybookHistory[];
  models: { label: string; synth: string; synthUsed: boolean };
  warnings: string[];
}

export const MIN_OUTCOME_SAMPLE = 5;
export const MIN_MESSAGES = 3;
export const MAX_NOTES_CHARS = 4000;
