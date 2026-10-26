// s22 signals: splits a task into parts and tags each part from a fixed lexicon (no model). Messaging tags come only
// from messaging evidence (a mail or chat surface, a reply/send verb, an email.* or chat.* kind), so a task that is
// not about messages never gets email treatment by default.
// An app, a domain or a keyword alone never decides the kind of work where the app serves more than one kind: the
// ACTIVITY does (the step's own verb for v2, the task's label kind and name for v1; never titles or OCR words). A part
// whose activity is reviewing, reading or navigating (review, read, inspect, browse, search, present, ...) gets no
// making or writing tag: reviewing a Figma file is not image making, reading Gmail is not messaging, reading the
// LinkedIn feed is not publishing, reading a sheet is not data entry, reviewing a diff is not watching an agent.
import type { Task, UnderstandingStep } from "../types.ts";
import type { PartTag, SolutionSubject, TaskPart } from "./types.ts";

const words = (...xs: Array<string | undefined>) => ` ${xs.filter((x): x is string => x !== undefined && x !== "").join(" ").toLowerCase().replace(/[^a-z0-9.@/+-]+/g, " ")} `;
const has = (text: string, re: RegExp) => re.test(text);

// Lexicon. Word-bounded on the padded, lowercased text.
// Matched on the surface words only (app, host, surface): a chat with Claude in the browser is not a coding agent.
const AGENT_SURFACE = /\b(terminal|iterm2?|warp|ghostty|cursor|vs ?code|visual studio code|zed|windsurf|xcode|claude code|codex|aider|code\.claude-code|code\.terminal)\b/;
const AGENT_WORDS = /\b(claude( code)?|codex|copilot|agent|aider|devin|code\.claude-code)\b/;
const WATCH_VERBS = /\b(watch|watching|wait|waiting|monitor|follow|observe|check progress|read output|scroll output|running|thinking|working|esc to interrupt|in progress)\b/;
const APPROVAL = /\b(approve|approving|allow|permission|accept|confirm|proceed|yes to)\b/;
const PROMPT_VERBS = /\b(prompt|instruct|brief|explain the task|paste context|describe the task|type prompt|re-?prompt)\b/;
const CODE_MANUAL = /\b(run tests?|tests?|rerun|re-run|restart|rebuild|deploy|lint|format|git|commit|push|merge|copy error|paste error|build|npm|pnpm|yarn|bun|pytest|cargo|make)\b/;
const MEDIA_APPS = /\b(canva|figma|photoshop|illustrator|midjourney|dall-?e|firefly|ideogram|leonardo|pixelmator|affinity|lightroom|gimp)\b/;
const MAKE_VERBS = /\b(generate|create|design|make|edit|export|resize|render|draw|crop|prompt|upscale)\b/;
/** v1 label words: "design" is left out (a noun in "design review"), the -ing forms are in. */
const MAKE_WORDS_V1 = /\b(generate|generating|create|creating|designing|make|making|edit|editing|export|exporting|resize|resizing|render|rendering|draw|drawing|crop|cropping|upscale|upscaling)\b/;
const MEDIA_OBJECTS = /\b(image|images|graphic|graphics|visuals?(?! studio)|banners?|thumbnails?|carousel|illustrations?|picture|pictures|photo|photos|mockups?|cover image|cover art|header image|infographic)\b/;
const PUBLISH_SURFACE = /\b(linkedin|x\.com|twitter|instagram|buffer|hootsuite|typefully|medium|substack|wordpress|youtube|threads|facebook)\b/;
const PUBLISH_VERBS = /\b(post|posts|publish|schedule post|share|upload post)\b/;
const MAIL_SURFACE = /\b(gmail|mail\.google\.com|outlook|mail|superhuman|slack|teams|whatsapp|messages|intercom|front|zendesk)\b/;
const MESSAGE_VERBS = /\b(reply|replies|send|email|emails|message|messages|follow up|follow-up|respond|answer|dm)\b/;
const DATA_APPS = /\b(sheets|google sheets|excel|airtable|xero|quickbooks|salesforce|hubspot|crm|greenhouse|notion)\b/;
const DATA_VERBS = /\b(enter|fill|fill in|update|updates|log|record|key in|input|reconcile|match|add row|create bill|move stage)\b/;
const COPY_VERBS = /\b(copy|paste|transfer|download|upload|import|export|re-?type)\b/;
const READ_VERBS = /\b(read|reading|browse|browsing|research|scroll|skim|look up|search|watch video|visits)\b/;
/** Activity words of review, reading and navigation: no making or writing tag comes from a part doing these. */
const REVIEW_VERBS = /\b(review|reviews|reviewing|read|reads|reading|inspect|inspects|inspecting|view|views|viewing|browse|browsing|scroll|scrolling|skim|skimming|search|searching|look up|looking up|present|presenting|preview|previewing|compare|comparing|navigate|navigating|study|studying|annotate|annotating|comment|commenting)\b/;
/** Activity words that write or make something (a part with one of these is not only reviewing). */
const WRITE_VERBS = /\b(write|writing|compose|composing|draft|drafting|schedule|scheduling)\b/;

/** Keys per active minute below which a code session is watching, not typing (ADR 0005: counts only). */
export const WATCH_KEYS_PER_MINUTE = 30;

export interface TagInput {
  text: string;
  /** What the part DOES: the step's verb (v2) or the task's label kind and name (v1), never titles or OCR words.
   * Defaults to the verb, else the text (direct lexicon checks). */
  activity?: string;
  /** v2: the step's own verb (messaging verbs count only here, never from OCR words). */
  verb?: string;
  /** The app, host and surface words only (no titles, no OCR). */
  surface: string;
  category: string;
  kind: string;
  keysPerMinute: number;
}

export function tagsFor(t: TagInput): PartTag[] {
  const x = t.text;
  const tags = new Set<PartTag>();
  const act = t.activity ?? (t.verb !== undefined ? words(t.verb) : x);
  const v1 = t.activity !== undefined && t.verb === undefined;
  const makes = has(act, v1 ? MAKE_WORDS_V1 : MAKE_VERBS);
  const writesSomething = makes || has(act, WRITE_VERBS) || has(act, MESSAGE_VERBS) || has(act, PUBLISH_VERBS) || has(act, DATA_VERBS) || has(act, COPY_VERBS);
  // Review, reading or navigation, and nothing that writes: no making or writing tag below.
  const reviewing = has(act, REVIEW_VERBS) && !writesSomething;
  const kindMessaging = /^(email|chat)\./.test(t.kind);
  const codeSurface = t.category === "code" || has(t.surface, AGENT_SURFACE);
  const agent = has(x, AGENT_WORDS);
  // A task labelled as messaging keeps its reading steps (reading the thread is part of replying); elsewhere a mail
  // or chat app read, searched or scrolled is not messaging.
  if (kindMessaging || (!reviewing && (t.category === "email" || t.category === "chat" || has(t.surface, MAIL_SURFACE) || (t.verb !== undefined && has(words(t.verb), MESSAGE_VERBS) && !codeSurface && !has(x, PUBLISH_SURFACE))))) tags.add("messaging");
  if (!reviewing && has(x, PUBLISH_SURFACE) && (has(act, PUBLISH_VERBS) || (has(act, WRITE_VERBS) && /\bposts?\b/.test(x)))) tags.add("publish");
  // Image making needs a making activity AND an image app or an image object; the app name alone is not enough.
  if (!reviewing && makes && (has(x, MEDIA_APPS) || has(x, MEDIA_OBJECTS))) tags.add("media_make");
  if (codeSurface && agent) {
    if (!reviewing && has(x, APPROVAL)) tags.add("approval_prompt");
    if (!reviewing && (has(x, PROMPT_VERBS) || (t.keysPerMinute >= WATCH_KEYS_PER_MINUTE * 2 && !has(x, WATCH_VERBS)))) tags.add("agent_prompt");
    // Few keys alone count as watching only when the step is not reviewing (reviewing a diff is the person's work).
    if (has(x, WATCH_VERBS) || (t.keysPerMinute < WATCH_KEYS_PER_MINUTE && !reviewing)) tags.add("agent_watch");
  } else if (codeSurface && !reviewing && has(x, APPROVAL)) tags.add("approval_prompt");
  // With an agent at work the agent types the commands; the person's repeated commands only count without one.
  if (codeSurface && !agent && !reviewing && has(x, CODE_MANUAL)) tags.add("code_manual");
  // Like messaging, record and copy verbs count only as the step's own verb (or a records app as the surface), never
  // from OCR words: "record" on a call screen is not data entry.
  const verb = t.verb === undefined ? "" : words(t.verb);
  if (!reviewing && (t.category === "sheet" || (has(t.surface, DATA_APPS) && (verb === "" || has(verb, DATA_VERBS))) || (has(verb, DATA_VERBS) && !tags.has("messaging") && !codeSurface && !tags.has("media_make")))) tags.add("data_entry");
  if (has(verb, COPY_VERBS) && !codeSurface && !tags.has("media_make")) tags.add("copy_between");
  const writes = tags.has("messaging") || tags.has("publish") || tags.has("data_entry") || tags.has("media_make") || tags.has("code_manual");
  if (!writes && !codeSurface && (t.category === "browse" || t.category === "social" || has(x, READ_VERBS))) tags.add("reading");
  return [...tags].sort();
}

function stepText(s: UnderstandingStep): string {
  return words(s.verb, s.object, s.surface, s.appName, s.host);
}

/** The task's parts: its v2 steps (span ids from the span -> step map), else the whole task as one part. */
export function partsOf(subject: SolutionSubject, task: Pick<Task, "spanIds">, stepOf?: ReadonlyMap<string, string>): TaskPart[] {
  const p = subject.profile;
  const kind = subject.label.kind;
  const u = p.understanding;
  if (u !== undefined && u.steps.length > 0) {
    return u.steps.map((s) => ({
      id: s.id,
      name: `${s.verb} ${s.object} on ${s.surface}`.trim(),
      activeMs: s.activeMs,
      spanIds: stepOf === undefined ? [] : task.spanIds.filter((sid) => stepOf.get(sid) === s.id),
      tags: tagsFor({ text: stepText(s), surface: words(s.surface, s.appName, s.host), verb: s.verb, activity: words(s.verb), category: s.category, kind, keysPerMinute: p.keysPerMinute }),
    }));
  }
  const text = words(kind, subject.label.name, p.template, ...p.exampleTitles.slice(0, 5), ...p.ocrKeywords.slice(0, 20), p.appName, p.host);
  return [{ id: "task", name: subject.label.name, activeMs: subject.stats.activeMinutes.value * 60_000, spanIds: [...task.spanIds], tags: tagsFor({ text, surface: words(p.appName, p.host), activity: words(kind, subject.label.name), category: p.category, kind, keysPerMinute: p.keysPerMinute }) }];
}
