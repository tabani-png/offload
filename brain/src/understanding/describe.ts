// s12 span descriptions: Offload's own internal description ("internal prompt") of what the user did in one span.
// Deterministic composition: frame notes (confidence-weighted vote) first, then focus/title/URL/input counts/OCR rules.
// An optional DescriptionRefiner (a local or remote model) may reword activity/verb/object/step; it can never touch
// identifiers, ids, times or counts, and anything malformed is ignored.
import { categoryFor, isMailListView, WRITING_KEYS_PER_MINUTE } from "../grouping/group.ts";
import { clusterTitles, extractEmails, maskText, tokenize, urlPattern } from "../grouping/normalize.ts";
import type { Category, DayLabel, Span } from "../types.ts";
import type { FrameNote } from "./frames.ts";

export interface SpanDescription {
  spanId: string;
  day: DayLabel;
  start: number;
  end: number;
  activeMs: number;
  app: string;
  appName: string;
  host: string;
  urlPattern: string;
  title: string;
  /** Masked title template inside its app + host + path partition (v1 clustering). */
  template: string;
  /** app | host | urlPattern | template: where on screen this happened. */
  surfaceKey: string;
  /** v1 rule category: a feature only. */
  category: Category;
  activity: string;
  verb: string;
  object: string;
  counterpart: string;
  surface: string;
  step: string;
  /** Normalised identifiers (lower case), sorted. Never the user's own addresses. */
  identifiers: string[];
  source: "frames" | "rules";
  frameIds: string[];
  eventIds: string[];
  keysPerMinute: number;
  /** Best frame confidence; 0.5 for a rules-only description. Below 0.5 the surface decides the step. */
  confidence: number;
  /** Distinct verbs of the confident frames (a span can hold "read" then "reply"). */
  frameVerbs: string[];
  /** The internal prompt that gets embedded: masked, without identifiers or counterpart. */
  text: string;
}

const DOC_APPS = new Set(["com.apple.Preview", "com.adobe.Reader", "com.adobe.Acrobat.Pro", "com.readdle.PDFExpert-Mac", "com.apple.finder"]);
const DOC_EXT_RE = /\.(pdf|docx?|xlsx?|csv|pptx?|txt|png|jpe?g)$/i;

export const RULES_CONFIDENCE = 0.5;

export function isDocumentApp(app: string): boolean {
  return DOC_APPS.has(app);
}

export function normId(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
}

const TITLE_ID_RES: readonly RegExp[] = [/#\d{3,}/g, /\b[A-Z]{2,6}-\d{3,}\b/g];

function ruleIdentifiers(span: Span, own: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  const emails = new Set<string>(extractEmails(span.title));
  for (const o of span.ocr) for (const e of extractEmails(o.text)) emails.add(e);
  for (const e of emails) if (!own.has(e)) ids.add(e);
  for (const re of TITLE_ID_RES) for (const m of span.title.match(re) ?? []) ids.add(normId(m));
  if (DOC_EXT_RE.test(span.title.trim())) ids.add(normId(span.title));
  if (span.url !== "" && span.host !== "") {
    try {
      const path = new URL(span.url).pathname;
      const pattern = urlPattern(span.url);
      // A path with a per-item segment (an id, a number, a slug) names one item: keep it.
      if (/<(?:n|id|slug)>/.test(pattern)) ids.add(normId(`${span.host}${path.replace(/\/+$/, "")}`));
    } catch {
      // The URL did not parse; urlPattern already returned "" for it, so there is no item path.
    }
  }
  return [...ids];
}

interface Vote {
  value: string;
  weight: number;
}

/** Confidence-weighted vote; ties go to the alphabetically first value so the result is stable. */
function vote(values: readonly Vote[]): string {
  const sums = new Map<string, { w: number; shown: string }>();
  for (const v of values) {
    const k = v.value.trim().toLowerCase();
    if (k === "") continue;
    const cur = sums.get(k) ?? { w: 0, shown: v.value.trim() };
    cur.w += v.weight;
    sums.set(k, cur);
  }
  let best: { k: string; w: number; shown: string } | null = null;
  for (const [k, { w, shown }] of sums) if (best === null || w > best.w + 1e-9 || (Math.abs(w - best.w) <= 1e-9 && k < best.k)) best = { k, w, shown };
  return best?.shown ?? "";
}

const OBJECT_FOR: Record<Category, string> = { email: "email", chat: "message", call: "call", code: "code", sheet: "spreadsheet", calendar: "calendar", social: "profile", browse: "web page", other: "window" };

function ruleVerb(category: Category, kpm: number, template: string): string {
  const writes = kpm >= WRITING_KEYS_PER_MINUTE;
  switch (category) {
    case "email":
      return writes && !isMailListView(template) ? "write" : "read";
    case "chat":
      return writes ? "write" : "read";
    case "call":
      return "attend";
    case "code":
      return writes ? "write" : "read";
    case "sheet":
      return writes ? "edit" : "read";
    case "calendar":
      return "check";
    case "social":
    case "browse":
      return writes ? "type" : "read";
    case "other":
      return writes ? "edit" : "view";
  }
}

function surfaceLabel(appName: string, host: string, template: string): string {
  const site = host === "" ? appName : host.replace(/^www\./, "");
  const t = template.length > 40 ? `${template.slice(0, 40)}…` : template;
  return t === "" ? site : `${site}: ${t}`;
}

function stripAll(text: string, parts: readonly string[]): string {
  let out = text;
  for (const p of parts) {
    if (p.length < 3) continue;
    out = out.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  return out;
}

/** The internal prompt that gets embedded. Identifiers and the counterpart vary per item, so they are left out. */
export function descriptionText(d: Pick<SpanDescription, "activity" | "verb" | "object" | "surface" | "step" | "identifiers" | "counterpart">): string {
  const raw = `${d.activity}. ${d.verb} ${d.object} on ${d.surface}. ${d.step}`;
  return maskText(stripAll(raw, [...d.identifiers, d.counterpart])).replace(/\s+/g, " ").trim();
}

export interface DescribeOptions {
  /** The user's own addresses: never identifiers. */
  ownEmails?: readonly string[];
  /** Title template similarity (v1 clustering threshold). */
  clusterThreshold?: number;
}

/** Title templates per app + host + path partition, as v1 builds them. */
function templates(spans: readonly Span[], threshold: number | undefined): Map<string, string> {
  const parts = new Map<string, Set<string>>();
  for (const s of spans) {
    const key = `${s.app}|${s.host}|${urlPattern(s.url)}`;
    const set = parts.get(key) ?? new Set<string>();
    set.add(maskText(s.title));
    parts.set(key, set);
  }
  const out = new Map<string, string>();
  for (const [key, set] of parts) {
    const masked = [...set];
    for (const c of clusterTitles(masked.map(tokenize), threshold)) for (const m of c.members) out.set(`${key}|${masked[m]}`, c.template);
  }
  return out;
}

export function describeSpans(spans: readonly Span[], framesBySpan: ReadonlyMap<string, readonly FrameNote[]>, opts: DescribeOptions = {}): SpanDescription[] {
  const own = new Set((opts.ownEmails ?? []).map((e) => e.toLowerCase()));
  const tpl = templates(spans, opts.clusterThreshold);
  const sorted = [...spans].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  return sorted.map((s) => {
    const path = urlPattern(s.url);
    const masked = maskText(s.title);
    const template = tpl.get(`${s.app}|${s.host}|${path}|${masked}`) ?? masked;
    const category = categoryFor(s.app, s.host, path);
    const minutes = s.activeMs / 60_000;
    const kpm = minutes > 0 ? s.keys / minutes : 0;
    const frames = [...(framesBySpan.get(s.id) ?? [])].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const w = (f: FrameNote) => Math.max(0.01, f.confidence);
    const fv = (pick: (f: FrameNote) => string | undefined) => vote(frames.flatMap((f) => (pick(f) === undefined ? [] : [{ value: pick(f)!, weight: w(f) }])));
    const rVerb = ruleVerb(category, kpm, template);
    const rObject = DOC_EXT_RE.test(s.title.trim()) ? "document" : OBJECT_FOR[category];
    const rSurface = surfaceLabel(s.appName, s.host, template);
    const verb = fv((f) => f.verb) || rVerb;
    const object = fv((f) => f.object) || rObject;
    const surface = fv((f) => f.surface) || rSurface;
    const step = fv((f) => f.step) || `${verb} ${object}`;
    const activity = fv((f) => f.activity) || `${verb} ${object} in ${rSurface}`;
    const counterpart = fv((f) => f.counterpart);
    const ids = new Set(ruleIdentifiers(s, own));
    for (const f of frames) for (const id of f.identifiers ?? []) if (!own.has(normId(id))) ids.add(normId(id));
    const identifiers = [...ids].filter((x) => x !== "").sort();
    const d: SpanDescription = {
      spanId: s.id,
      day: s.day,
      start: s.start,
      end: s.end,
      activeMs: s.activeMs,
      app: s.app,
      appName: s.appName,
      host: s.host,
      urlPattern: path,
      title: s.title,
      template,
      surfaceKey: `${s.app}|${s.host}|${path}|${template}`,
      category,
      activity,
      verb: verb.toLowerCase(),
      object: object.toLowerCase(),
      counterpart,
      surface,
      step,
      identifiers,
      source: frames.length > 0 ? "frames" : "rules",
      frameIds: frames.map((f) => f.id),
      eventIds: [...s.eventIds],
      keysPerMinute: kpm,
      confidence: frames.length === 0 ? RULES_CONFIDENCE : Math.max(...frames.map((f) => f.confidence)),
      frameVerbs: [...new Set(frames.filter((f) => f.confidence >= RULES_CONFIDENCE && f.verb !== undefined).map((f) => f.verb!.trim().toLowerCase()))].sort(),
      text: "",
    };
    d.text = descriptionText(d);
    return d;
  });
}

/** What a refiner sees: masked text fields only. */
export interface RefineInput {
  activity: string;
  verb: string;
  object: string;
  surface: string;
  step: string;
  category: Category;
  appName: string;
}

export type Refinement = Partial<Pick<SpanDescription, "activity" | "verb" | "object" | "step">>;

export interface DescriptionRefiner {
  refine(input: RefineInput): Refinement | null | Promise<Refinement | null>;
}

const LIMITS = { activity: 200, verb: 40, object: 80, step: 120 } as const;

/** Applies a refiner. Only the four text fields can change, each must be a non-empty string within the schema limits. */
export async function refineDescriptions(descs: readonly SpanDescription[], refiner: DescriptionRefiner): Promise<SpanDescription[]> {
  const out: SpanDescription[] = [];
  for (const d of descs) {
    let r: unknown;
    try {
      r = await refiner.refine({ activity: d.activity, verb: d.verb, object: d.object, surface: d.surface, step: d.step, category: d.category, appName: d.appName });
    } catch {
      // A failing refiner is not fatal: the deterministic description stands.
      r = null;
    }
    const next: SpanDescription = { ...d, identifiers: [...d.identifiers], frameIds: [...d.frameIds], eventIds: [...d.eventIds] };
    if (r !== null && typeof r === "object") {
      for (const k of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
        const v = (r as Record<string, unknown>)[k];
        if (typeof v === "string" && v.trim() !== "" && v.length <= LIMITS[k]) next[k] = k === "verb" || k === "object" ? v.trim().toLowerCase() : v.trim();
      }
    }
    next.text = descriptionText(next);
    out.push(next);
  }
  return out;
}
