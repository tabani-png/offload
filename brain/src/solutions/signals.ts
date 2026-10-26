// s22 signals: splits a task into parts and tags each part from a fixed lexicon (no model). Messaging tags come only
// from messaging evidence (a mail or chat surface, a reply/send verb, an email.* or chat.* kind), so a task that is
// not about messages never gets email treatment by default.
import type { Task, UnderstandingStep } from "../types.ts";
import type { PartTag, SolutionSubject, TaskPart } from "./types.ts";

const words = (...xs: Array<string | undefined>) => ` ${xs.filter((x): x is string => x !== undefined && x !== "").join(" ").toLowerCase().replace(/[^a-z0-9.@/+-]+/g, " ")} `;
const has = (text: string, re: RegExp) => re.test(text);

// Lexicon. Word-bounded on the padded, lowercased text.
const AGENT_SURFACE = /\b(terminal|iterm2?|warp|ghostty|cursor|vs ?code|visual studio code|zed|windsurf|xcode|claude|codex|copilot|aider|code\.claude-code|code\.terminal)\b/;
const AGENT_WORDS = /\b(claude( code)?|codex|copilot|agent|aider|devin|code\.claude-code)\b/;
const WATCH_VERBS = /\b(watch|watching|wait|waiting|monitor|follow|observe|check progress|read output|scroll output|running|thinking|working|esc to interrupt|in progress)\b/;
const APPROVAL = /\b(approve|approving|allow|permission|accept|confirm|proceed|yes to)\b/;
const PROMPT_VERBS = /\b(prompt|instruct|brief|explain the task|paste context|describe the task|type prompt|re-?prompt)\b/;
const CODE_MANUAL = /\b(run tests?|tests?|rerun|re-run|restart|rebuild|deploy|lint|format|git|commit|push|merge|copy error|paste error|build|npm|pnpm|yarn|bun|pytest|cargo|make)\b/;
const MEDIA_APPS = /\b(canva|figma|photoshop|illustrator|midjourney|dall-?e|firefly|ideogram|leonardo|pixelmator|affinity|lightroom|gimp)\b/;
const MAKE_VERBS = /\b(generate|create|design|make|edit|export|resize|render|draw|crop|prompt|upscale)\b/;
const MEDIA_OBJECTS = /\b(image|images|graphic|graphics|visual|visuals|banner|thumbnail|carousel|illustration|picture|photo|mockup|cover|header image|infographic)\b/;
const PUBLISH_SURFACE = /\b(linkedin|x\.com|twitter|instagram|buffer|hootsuite|typefully|medium|substack|wordpress|youtube|threads|facebook)\b/;
const PUBLISH_VERBS = /\b(post|posts|publish|schedule post|share|upload post)\b/;
const MAIL_SURFACE = /\b(gmail|mail\.google\.com|outlook|mail|superhuman|slack|teams|whatsapp|messages|intercom|front|zendesk)\b/;
const MESSAGE_VERBS = /\b(reply|replies|send|email|emails|message|messages|follow up|follow-up|respond|answer|dm)\b/;
const DATA_APPS = /\b(sheets|google sheets|excel|airtable|xero|quickbooks|salesforce|hubspot|crm|greenhouse|notion)\b/;
const DATA_VERBS = /\b(enter|fill|fill in|update|updates|log|record|key in|input|reconcile|match|add row|create bill|move stage)\b/;
const COPY_VERBS = /\b(copy|paste|transfer|download|upload|import|export|re-?type)\b/;
const READ_VERBS = /\b(read|reading|browse|browsing|research|scroll|skim|look up|search|watch video|visits)\b/;

/** Keys per active minute below which a code session is watching, not typing (ADR 0005: counts only). */
export const WATCH_KEYS_PER_MINUTE = 30;

export interface TagInput {
  text: string;
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
  const kindMessaging = /^(email|chat)\./.test(t.kind);
  const codeSurface = t.category === "code" || has(x, AGENT_SURFACE);
  const agent = has(x, AGENT_WORDS);
  if (kindMessaging || t.category === "email" || t.category === "chat" || has(t.surface, MAIL_SURFACE) || (t.verb !== undefined && has(words(t.verb), MESSAGE_VERBS) && !codeSurface && !has(x, PUBLISH_SURFACE))) tags.add("messaging");
  if (has(x, PUBLISH_SURFACE) && has(x, PUBLISH_VERBS)) tags.add("publish");
  if (has(x, MEDIA_APPS) || (has(x, MAKE_VERBS) && has(x, MEDIA_OBJECTS))) tags.add("media_make");
  if (codeSurface && agent) {
    if (has(x, APPROVAL)) tags.add("approval_prompt");
    if (has(x, PROMPT_VERBS) || (t.keysPerMinute >= WATCH_KEYS_PER_MINUTE * 2 && !has(x, WATCH_VERBS))) tags.add("agent_prompt");
    if (has(x, WATCH_VERBS) || t.keysPerMinute < WATCH_KEYS_PER_MINUTE) tags.add("agent_watch");
  } else if (codeSurface && has(x, APPROVAL)) tags.add("approval_prompt");
  // With an agent at work the agent types the commands; the person's repeated commands only count without one.
  if (codeSurface && !agent && has(x, CODE_MANUAL)) tags.add("code_manual");
  if (t.category === "sheet" || (has(x, DATA_APPS) && has(x, DATA_VERBS)) || (has(x, DATA_VERBS) && !tags.has("messaging") && !codeSurface && !tags.has("media_make"))) tags.add("data_entry");
  if (has(x, COPY_VERBS) && !codeSurface && !tags.has("media_make")) tags.add("copy_between");
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
      tags: tagsFor({ text: stepText(s), surface: words(s.surface, s.appName, s.host), verb: s.verb, category: s.category, kind, keysPerMinute: p.keysPerMinute }),
    }));
  }
  const text = words(kind, subject.label.name, p.template, ...p.exampleTitles.slice(0, 5), ...p.ocrKeywords.slice(0, 20), p.appName, p.host);
  return [{ id: "task", name: subject.label.name, activeMs: subject.stats.activeMinutes.value * 60_000, spanIds: [...task.spanIds], tags: tagsFor({ text, surface: words(p.appName, p.host), category: p.category, kind, keysPerMinute: p.keysPerMinute }) }];
}
