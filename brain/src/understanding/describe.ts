// s12 span descriptions: Offload's own internal description ("internal prompt") of what the user did in one span.
// Deterministic composition: frame notes (confidence-weighted vote) first, then focus/title/URL/input counts/OCR rules.
// An optional DescriptionRefiner (a local or remote model) may reword activity/verb/object/step; it can never touch
// identifiers, ids, times or counts, and anything malformed is ignored.
// s18 (ADR 0010): person names in the description fields and the embedded text become <name>; the names are learned
// from every span title of the run first (privacy/names.ts). The raw title stays local; identifiers stay record ids.
import { categoryFor, isMailListView, WRITING_KEYS_PER_MINUTE } from "../grouping/group.ts";
import { clusterTitles, extractEmails, maskText, tokenize, urlPattern } from "../grouping/normalize.ts";
import type { Category, DayLabel, Span } from "../types.ts";
import { maskNamesForStorage, NameMap } from "../privacy/names.ts";
import type { FrameNote } from "./frames.ts";
import { knownSurfaceAt, knownSurfaceIn, normalizeSurface, surfaceKeyOf, type KnownSurface } from "./surfaces.ts";
import { baseVerb, isGenericVerb } from "./verbs.ts";

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
  /** app | host | urlPattern | template: where on screen this happened. s20: on a stand-in app (see standIns)
   * the app part is the captioned product (`~<id>` when it has no bundle id) or a `|~<surface>` suffix is added. */
  surfaceKey: string;
  /** s20: "observed" = app/host are what the observer recorded; "caption" = the observed app was a stand-in and the
   * frame notes named the product, so app/appName/host/urlPattern/category are that product's. */
  surfaceFrom?: "observed" | "caption";
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

const GENERIC_WORD_RE = new RegExp(
  `\\b(?:${["review", "view", "look at", "read", "check", "browse", "watch", "scroll", "skim", "reviewing", "viewing", "looking", "reading", "checking", "browsing", "watching", "scrolling", "skimming"]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/ /g, "\\s+"))
    .join("|")})\\b(?:\\s+(?:at|over|through|on))?`,
  "gi",
);

/** Text without the words that only say someone looks at a screen ("Reviewing a doc" -> "a doc"). */
export function withoutGenericVerbs(text: string): string {
  return text.replace(GENERIC_WORD_RE, " ").replace(/\s+/g, " ").trim();
}

/** The internal prompt that gets embedded. Identifiers and the counterpart vary per item, so they are left out.
 * s20: generic looking verbs (reviewing, viewing, reading, ...) carry no task signal, so they are left out too and
 * the surface and object lead (a small captioner says "reviewing" on 3 of 4 screens, which merged unrelated work). */
export function descriptionText(d: Pick<SpanDescription, "activity" | "verb" | "object" | "surface" | "step" | "identifiers" | "counterpart">, names: NameMap = new NameMap()): string {
  const verb = isGenericVerb(d.verb) ? "" : `${d.verb} `;
  const raw = `${d.surface} ${d.object}. ${withoutGenericVerbs(d.activity)}. ${verb}${d.object} on ${d.surface}. ${withoutGenericVerbs(d.step)}`;
  return maskNamesForStorage(maskText(stripAll(raw, [...d.identifiers, d.counterpart])), names).replace(/\s+/g, " ").trim();
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

const BROWSER_APPS = new Set(["com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.brave.Browser"]);

/** Confident frames only: what the caption says the screen is. */
const confidentFrames = (frames: readonly FrameNote[]) => frames.filter((f) => f.confidence >= RULES_CONFIDENCE);

/** The product the confident frames of a span name (vote by grouping key), or null. */
function namedProduct(frames: readonly FrameNote[]): KnownSurface | null {
  const n = new Map<string, { s: KnownSurface; w: number }>();
  for (const f of confidentFrames(frames)) {
    const k = f.surface === undefined ? null : knownSurfaceIn(f.surface);
    if (k === null) continue;
    const cur = n.get(k.id) ?? { s: k, w: 0 };
    cur.w += f.confidence;
    n.set(k.id, cur);
  }
  let best: { s: KnownSurface; w: number } | null = null;
  for (const v of n.values()) if (best === null || v.w > best.w + 1e-9 || (Math.abs(v.w - best.w) <= 1e-9 && v.s.id < best.s.id)) best = v;
  return best?.s ?? null;
}

/**
 * s20 stand-in apps. An app is a stand-in when what it shows is other products: a browser with no URL, or an app
 * whose captioned screens name at least two known products other than itself in at least half of its framed spans
 * (a screen recorder, a remote desktop, the blind-test importer's one synthetic app). On a stand-in, a span whose
 * caption names a known product takes that product's place (app, host, path, category), so grouping and routing see
 * Gmail or Granola, not "Screen". Real apps whose captions name themselves are never touched.
 */
function standIns(spans: readonly Span[], framesBySpan: ReadonlyMap<string, readonly FrameNote[]>): Set<string> {
  const per = new Map<string, { framed: number; named: number; products: Set<string> }>();
  for (const s of spans) {
    if (s.host !== "") continue;
    const frames = confidentFrames(framesBySpan.get(s.id) ?? []);
    if (frames.length === 0) continue;
    const cur = per.get(s.app) ?? { framed: 0, named: 0, products: new Set<string>() };
    cur.framed += 1;
    const own = knownSurfaceAt(s.app, "") ?? knownSurfaceIn(s.appName);
    const p = namedProduct(frames);
    if (p !== null && p.id !== own?.id) {
      cur.named += 1;
      cur.products.add(p.id);
    }
    per.set(s.app, cur);
  }
  const out = new Set<string>();
  for (const [app, v] of per) if (BROWSER_APPS.has(app) || (v.products.size >= 2 && v.named >= 0.5 * v.framed)) out.add(app);
  return out;
}

export function describeSpans(spans: readonly Span[], framesBySpan: ReadonlyMap<string, readonly FrameNote[]>, opts: DescribeOptions = {}): SpanDescription[] {
  const own = new Set((opts.ownEmails ?? []).map((e) => e.toLowerCase()));
  const tpl = templates(spans, opts.clusterThreshold);
  const standIn = standIns(spans, framesBySpan);
  const sorted = [...spans].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  const names = new NameMap();
  for (const s of sorted) names.learn(s.title);
  const noNames = (s: string) => maskNamesForStorage(s, names);
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
    // s20: gerunds become base verbs ("writing" -> "write") and surface names are normalised before the vote, so
    // "Instagram" and "instagram.com" are one vote and one surface. s22: names are masked.
    const verb = fv((f) => (f.verb === undefined ? undefined : baseVerb(f.verb))) || rVerb;
    const object = noNames(fv((f) => f.object) || rObject);
    const surface = noNames(fv((f) => (f.surface === undefined ? undefined : normalizeSurface(f.surface))) || rSurface);
    const step = noNames(fv((f) => f.step) || `${verb} ${object}`);
    const activity = noNames(fv((f) => f.activity) || `${verb} ${object} in ${rSurface}`);
    const counterpart = noNames(fv((f) => f.counterpart));
    const ids = new Set(ruleIdentifiers(s, own));
    for (const f of frames) for (const id of f.identifiers ?? []) if (!own.has(normId(id))) ids.add(normId(id));
    const identifiers = [...ids].filter((x) => x !== "").sort();
    // s20: on a stand-in app the captioned product is the surface (see standIns).
    const named = standIn.has(s.app) && s.host === "" ? namedProduct(frames) : null;
    const product = named !== null && named.id !== (knownSurfaceAt(s.app, "") ?? knownSurfaceIn(s.appName))?.id ? named : null;
    const where =
      product !== null
        ? { app: product.app ?? "", appName: product.name, host: product.host ?? "", path: product.path ?? "", keyApp: product.app ?? `~${product.id}`, suffix: "", from: "caption" as const }
        : { app: s.app, appName: s.appName, host: s.host, path, keyApp: s.app, suffix: standIn.has(s.app) && !BROWSER_APPS.has(s.app) && frames.length > 0 ? `|~${surfaceKeyOf(surface)}` : "", from: "observed" as const };
    const d: SpanDescription = {
      spanId: s.id,
      day: s.day,
      start: s.start,
      end: s.end,
      activeMs: s.activeMs,
      app: where.app,
      appName: where.appName,
      host: where.host,
      urlPattern: where.path,
      title: s.title,
      template,
      surfaceKey: `${where.keyApp}|${where.host}|${where.path}|${template}${where.suffix}`,
      surfaceFrom: where.from,
      category: product === null ? category : categoryFor(where.app, where.host, where.path),
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
      frameVerbs: [...new Set(frames.filter((f) => f.confidence >= RULES_CONFIDENCE && f.verb !== undefined).map((f) => baseVerb(f.verb!)))].sort(),
      text: "",
    };
    d.text = descriptionText(d, names);
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
        if (typeof v === "string" && v.trim() !== "" && v.length <= LIMITS[k]) next[k] = k === "verb" ? baseVerb(v) : k === "object" ? v.trim().toLowerCase() : v.trim();
      }
    }
    next.text = descriptionText(next);
    out.push(next);
  }
  return out;
}
