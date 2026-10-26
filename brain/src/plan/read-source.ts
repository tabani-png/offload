// s27: where a repeated task's values come from (slices/s27-workflow-reads/SPEC.md, design 1). Pure code over the
// Analysis (ADR 0005): for every instance of the task, the spans just before it (same day, other apps or sites) are
// candidate sources; the values the person typed are read from the commit screen's masked OCR; a candidate whose
// screen showed those values before enough instances is the source. Only labels, the app or site and code arithmetic
// are kept, never a value. Also: the read step in the plan, and the code that turns what a source shows (connector
// JSON, screen text) into rows of [commit label, value].
import type { Analysis } from "../analyze.ts";
import type { CapabilityNeedDTO, OutputDTO, OutputFieldDTO, OutputType, PlanStepDTO, ReadFieldDTO, ReadQueryDTO, ReadSourceDTO, WorkflowPlanDTO } from "../api/s14-types.ts";
import { SCREEN_READ, targetForProfile, type ChainTarget } from "../connectors/targets.ts";
import type { Span, TaskInstance } from "../types.ts";
import type { FrameNote } from "../understanding/frames.ts";
import { knownSurfaceAt } from "../understanding/surfaces.ts";
import { parseAxLine } from "../connectors/computer/ax-text.ts";

export const READ_STEP_ID = "read_source";
/** A source span ends at most this long before the instance starts. */
export const SOURCE_WINDOW_MS = 3 * 60_000;
/** At most this many spans just before an instance are looked at. */
const MAX_BACK = 2;
/** Plain-word labels only: letters and spaces, 1 to 4 words. No value, number or address is ever kept. */
const LABEL_RE = /^[A-Za-z][A-Za-z ]{0,39}$/;
const MAX_VALUE = 200;

const plainLabel = (s: string): string | null => {
  const t = s.replace(/\s+/g, " ").trim();
  return LABEL_RE.test(t) && t.split(" ").length <= 4 ? t : null;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `value` in `text` as a whole token: "3" is not in "43", "240" is not in "1,240.00". */
export function tokenIn(text: string, value: string): boolean {
  return tokenRe(value).test(text);
}

const tokenRe = (value: string) => new RegExp(`(?<![\\p{L}\\p{N}.,])${escapeRe(value)}(?![\\p{L}\\p{N}]|[.,]\\p{N})`, "u");

/** The plain-word label shown before `value` on one line ("Active users 2400" -> "Active users"), or null. */
export function labelOnLine(line: string, value: string): string | null {
  const m = tokenRe(value).exec(line);
  if (m === null || m.index === 0) return null;
  return plainLabel(line.slice(0, m.index).replace(/[\s:=|\-–]+$/, ""));
}

/** s27 round 10 (I8): a line that is only table formatting (Markdown delimiters `---` / `:---:`, `+---+` and `|===|`
 * borders, box-drawing lines): never data. */
export const isFormattingLine = (line: string): boolean => /^[\s\-=_:+|.*~\u2500-\u257F]+$/u.test(line) && /[-=_+\u2500-\u257F]/u.test(line);

/** True when a table line has outer borders (`| a | b |`, `│ a │ b │`): then its rows have them too. */
const outerPipes = (line: string): boolean => /^[|│┃║┆┊╎╏]/.test(line.trim());

/** The cells of a table line: split on | (box-drawing verticals count as |) or on tabs; trimmed. `outer` (from the
 * header): drop the outer borders. Without outer borders a trailing | is an empty last cell, never dropped. */
const cellsOf = (line: string, outer: boolean = outerPipes(line)): string[] | null => {
  const l = line.replace(/[│┃║┆┊╎╏]/g, "|").trim();
  if (l.includes("|")) {
    let t = l;
    if (outer && t.startsWith("|")) t = t.slice(1);
    if (outer && t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  }
  return line.includes("\t") ? line.split("\t").map((c) => c.trim()) : null;
};

/**
 * The values typed on a commit screen, from its masked OCR: a table header of plain-word labels with the row under it
 * ("Week | Signups\n42 | 350"), or "Label: value" lines. First value per label wins.
 */
export function parseCommitValues(texts: readonly string[]): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const t of texts) {
    // I8: formatting lines (table delimiters, borders) are never data, here either.
    const lines = t.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "" && !isFormattingLine(l));
    for (let i = 0; i < lines.length; i++) {
      const head = cellsOf(lines[i]!);
      if (head !== null && head.length >= 2 && head.every((c) => plainLabel(c) !== null)) {
        const outer = outerPipes(lines[i]!);
        // The header is the first table line (structure); the next line with the header's width is data, whatever its
        // cells look like (word values too, round 19).
        // The whole table is consumed here (every delimited line after the header), so a data line is never taken
        // for another header.
        let j = i + 1;
        let row: string[] | null = null;
        for (; j < lines.length; j++) {
          const c = cellsOf(lines[j]!, outer);
          if (c === null) break;
          if (row === null && c.length === head.length) row = c;
        }
        if (row !== null) head.forEach((h, k) => row![k] !== "" && !out.has(h) && out.set(h, row![k]!));
        i = j - 1;
        continue;
      }
      const m = /^([A-Za-z][A-Za-z ]{0,39}):\s*(\S.*)$/.exec(lines[i]!.trim());
      if (m !== null && plainLabel(m[1]!) !== null && !out.has(m[1]!.trim())) out.set(m[1]!.trim(), m[2]!.trim());
    }
  }
  return [...out.entries()];
}

/** The site or app a span is on: the host (no www.) in a browser, else the app. */
export const surfaceOf = (s: Pick<Span, "host" | "app">): string => (s.host !== "" ? s.host.replace(/^www\./, "") : s.app);

/** Text of the frame notes on a span (v2): activity, object, inputs, outputs, identifiers. */
function frameTexts(a: Analysis): Map<string, { text: string; ids: string[] }> {
  const out = new Map<string, { text: string; ids: string[] }>();
  const frames = new Map<string, FrameNote>((a.understanding?.frames ?? []).map((f) => [f.id, f]));
  for (const d of a.understanding?.descriptions ?? []) {
    const notes = d.frameIds.map((id) => frames.get(id)).filter((f): f is FrameNote => f !== undefined);
    if (notes.length === 0) continue;
    const text = notes.flatMap((f) => [f.activity, f.object ?? "", ...(f.inputs ?? []), ...(f.outputs ?? []), ...(f.identifiers ?? [])]).filter((x) => x !== "").join("\n");
    out.set(d.spanId, { text, ids: notes.map((f) => f.id) });
  }
  return out;
}

/** Spans just before an instance, not part of `taskId`, not on `own` surfaces: nearest first, at most MAX_BACK. */
function before(a: Analysis, taskId: string, inst: Pick<TaskInstance, "day" | "start">, own: ReadonlySet<string>): Span[] {
  return a.spans
    .filter((s) => s.day === inst.day && s.end <= inst.start + 1000 && s.end >= inst.start - SOURCE_WINDOW_MS && s.start < inst.start && a.taskOfSpan.get(s.id) !== taskId && !own.has(surfaceOf(s)))
    .sort((x, y) => y.end - x.end || (x.id < y.id ? -1 : 1))
    .slice(0, MAX_BACK);
}

function ownSurfaces(a: Analysis, taskId: string): Set<string> {
  const task = a.tasks.find((t) => t.id === taskId);
  return new Set((task?.spanIds ?? []).map((id) => a.spansById.get(id)).filter((s): s is Span => s !== undefined).map(surfaceOf));
}

/** The source's spans just before one instance (the dry run fills the instance from them). */
export function sourceSpansBefore(a: Analysis, taskId: string, src: Pick<ReadSourceDTO, "surface">, inst: Pick<TaskInstance, "day" | "start">): Span[] {
  return before(a, taskId, inst, ownSurfaces(a, taskId)).filter((s) => surfaceOf(s) === src.surface);
}

const r1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;
const r2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;

interface Candidate {
  surface: string;
  sample: Span;
  seen: number;
  withValues: number;
  ms: number;
  spanIds: string[];
  eventIds: string[];
  frameIds: string[];
  votes: Map<string, Map<string, number>>;
  /** Report names (page titles without the product name) and period filters seen on its screen, with counts. */
  reports: Map<string, number>;
  periods: Map<string, number>;
}

/** Period filters a report shows ("Last 7 days", "This month"): the filter the person looked at. */
const PERIOD_RE = /\b(last \d{1,3} (?:days?|weeks?|months?)|this (?:week|month|quarter|year)|today|yesterday|month to date|year to date)\b/i;

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const top = (m: Map<string, number>, min: number): string | null => {
  const best = [...m.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
  return best === undefined || best[1] < min ? null : best[0];
};

/** The report a page title names, without the product or site name ("Weekly metrics - PostHog" -> "Weekly metrics"). */
export function reportOf(title: string, name: string): string | null {
  const parts = title.split(/\s+[-–|·]\s+/).map((x) => x.trim()).filter((x) => x !== "" && x.toLowerCase() !== name.toLowerCase());
  return parts.length === 0 ? null : plainLabel(parts[0]!);
}

/** The arguments a read sends: the report, the fields, and each filter as its own key. */
export function queryArgs(q: ReadQueryDTO): Record<string, unknown> {
  return { ...(q.report === null ? {} : { report: q.report }), fields: [...q.fields], ...Object.fromEntries(q.filters) };
}

/** The learned query of a source (sources from before round 1: the fields alone). */
export const queryOf = (src: Pick<ReadSourceDTO, "query" | "fields">): ReadQueryDTO => src.query ?? { report: null, fields: src.fields.map((f) => f.sourceLabel), filters: [] };

/** One line naming what is read: "Weekly metrics (Week, Signups; period last 7 days)". Part of hashed item text. */
export function queryText(src: Pick<ReadSourceDTO, "query" | "fields" | "targetName">): string {
  const q = queryOf(src);
  const filters = q.filters.map(([k, v]) => `${k} ${v}`).join(", ");
  return `${q.report ?? src.targetName} (${q.fields.join(", ")}${filters === "" ? "" : `; ${filters}`})`;
}

/** The display name of a source: a known product (PostHog), else the host or the app name. */
export function sourceName(s: Pick<Span, "app" | "appName" | "host" | "url">): string {
  let path = "";
  try {
    path = s.url === "" ? "" : new URL(s.url).pathname;
  } catch {
    path = "";
  }
  return knownSurfaceAt(s.app, s.host, path)?.name ?? (s.host !== "" ? s.host.replace(/^www\./, "") : s.appName !== "" ? s.appName : s.app);
}

/**
 * Where the values of a task come from, or null. A candidate is the source when it is on screen right before at least
 * half of the instances (and at least 2), and on at least half of those (and at least 2) at least half of the values
 * typed were on its screen (OCR, or its frame notes). Fields: commit labels found on at least half of those instances,
 * each with the label the source shows before it (majority).
 */
export function findReadSource(a: Analysis, taskId: string, now: number = Date.now()): ReadSourceDTO | null {
  const task = a.tasks.find((t) => t.id === taskId);
  if (task === undefined || task.instances.length === 0) return null;
  const own = ownSurfaces(a, taskId);
  const notes = frameTexts(a);
  const order: string[] = [];
  const cands = new Map<string, Candidate>();
  for (const inst of task.instances) {
    const commitOcr = inst.spanIds.flatMap((id) => a.spansById.get(id)?.ocr.map((o) => o.text) ?? []);
    const typed = parseCommitValues(commitOcr).filter(([, v]) => /[\p{L}\p{N}]/u.test(v) && v.length <= MAX_VALUE);
    for (const [l] of typed) if (!order.includes(l)) order.push(l);
    const groups = new Map<string, Span[]>();
    for (const s of before(a, taskId, inst, own)) groups.set(surfaceOf(s), [...(groups.get(surfaceOf(s)) ?? []), s]);
    for (const [surface, spans] of groups) {
      const c: Candidate = cands.get(surface) ?? { surface, sample: spans[0]!, seen: 0, withValues: 0, ms: 0, spanIds: [], eventIds: [], frameIds: [], votes: new Map(), reports: new Map(), periods: new Map() };
      c.seen += 1;
      c.ms += spans.reduce((n, s) => n + s.activeMs, 0);
      c.spanIds.push(...spans.map((s) => s.id));
      c.eventIds.push(...spans.flatMap((s) => s.eventIds));
      const lines = spans
        .flatMap((s) => [...s.ocr.map((o) => o.text), notes.get(s.id)?.text ?? ""])
        .join("\n")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      c.frameIds.push(...spans.flatMap((s) => notes.get(s.id)?.ids ?? []));
      // What the person looked at, to build Offload's own view of it (never the page address).
      const report = reportOf(spans[0]!.title, sourceName(spans[0]!));
      if (report !== null) bump(c.reports, report);
      const period = lines.map((l) => PERIOD_RE.exec(l)?.[1]).find((x) => x !== undefined);
      if (period !== undefined) bump(c.periods, period.toLowerCase());
      let found = 0;
      for (const [label, value] of typed) {
        const line = lines.find((l) => labelOnLine(l, value) !== null) ?? lines.find((l) => tokenIn(l, value));
        if (line === undefined) continue;
        found += 1;
        const sl = labelOnLine(line, value) ?? label;
        const v = c.votes.get(label) ?? new Map<string, number>();
        v.set(sl, (v.get(sl) ?? 0) + 1);
        c.votes.set(label, v);
      }
      if (typed.length > 0 && found >= Math.max(1, Math.ceil(typed.length / 2))) c.withValues += 1;
      cands.set(surface, c);
    }
  }
  const n = task.instances.length;
  const ok = [...cands.values()].filter((c) => c.seen >= Math.max(2, Math.ceil(n / 2)) && c.withValues >= Math.max(2, Math.ceil(c.seen / 2)));
  ok.sort((x, y) => y.withValues - x.withValues || y.seen - x.seen || (x.surface < y.surface ? -1 : 1));
  const best = ok[0];
  if (best === undefined) return null;
  const fields: ReadFieldDTO[] = [];
  for (const label of order) {
    const v = best.votes.get(label);
    if (v === undefined) continue;
    const support = [...v.values()].reduce((s, x) => s + x, 0);
    if (support < Math.ceil(best.withValues / 2)) continue;
    const sourceLabel = [...v.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]![0];
    const l = plainLabel(label);
    const sl = plainLabel(sourceLabel);
    if (l !== null && sl !== null) fields.push({ label: l, sourceLabel: sl, support });
  }
  if (fields.length === 0) return null;
  const s = best.sample;
  const name = sourceName(s);
  let path = "";
  try {
    path = s.url === "" ? "" : new URL(s.url).pathname;
  } catch {
    path = "";
  }
  const target = targetForProfile({ app: s.app, appName: s.appName, host: s.host, urlPattern: path, schedulingShare: 0 });
  const secs = Math.round(best.ms / best.seen / 1000);
  const perDay = a.stats.get(taskId)?.instancesPerDay.value ?? n / Math.max(1, a.windowDays.length);
  const share = best.seen / n;
  const hours = r2((secs / 3600) * perDay * share * 7);
  return {
    version: 1,
    target: target.id,
    targetName: name,
    app: s.app,
    appName: s.appName,
    host: s.host,
    surface: best.surface,
    fields,
    instances: n,
    seenBefore: best.seen,
    withValues: best.withValues,
    readSecondsPerInstance: secs,
    readHoursPerWeek: hours,
    arithmetic: `${secs} s reading ${name} before ${best.seen} of ${n} times × ${r1(perDay)}/day × 7 days = ${hours.toFixed(2)} h/wk`,
    evidence: { spanIds: [...new Set(best.spanIds)].slice(0, 200), eventIds: [...new Set(best.eventIds)].slice(0, 200), frameIds: [...new Set(best.frameIds)].slice(0, 200) },
    query: (() => {
      const min = Math.max(2, Math.ceil(best.seen / 2));
      const period = top(best.periods, min);
      return { report: top(best.reports, min), fields: fields.map((f) => f.sourceLabel), filters: period === null ? [] : [["period", period] as [string, string]] };
    })(),
    foundAt: now,
  };
}

/** The chain target a source is read through. */
export function sourceTarget(src: ReadSourceDTO): ChainTarget {
  const t = targetForProfile({ app: src.app, appName: src.appName, host: src.host, urlPattern: "", schedulingShare: 0 });
  return t.id === src.target ? t : { ...t, id: src.target };
}

/** The read step every plan variant starts with when the task has a source. Never gated: it changes nothing. */
export function readStep(src: ReadSourceDTO): PlanStepDTO {
  const t = sourceTarget(src);
  const labels = src.fields.map((f) => f.label).join(", ");
  const capability: CapabilityNeedDTO = {
    need: `read ${labels} from ${src.targetName}`.slice(0, 200),
    target: src.target,
    targetName: src.targetName,
    capability: t.catalog ? (t.reads[0] ?? SCREEN_READ) : SCREEN_READ,
    role: "read",
    via: t.catalog ? "catalog" : "computer_use",
  };
  return {
    id: READ_STEP_ID,
    type: "read",
    title: `Read the values from ${src.targetName}`,
    detail: `Reads ${labels} from ${src.targetName} before each item, the way you did, through the first way that works (its connector, Composio, its direct connection, then the screen). Read only: it never changes anything there.`,
    capability,
    gated: false,
    when: null,
    writesText: false,
    sourceSteps: [],
  };
}

/** The plan with the read step first in every variant (once). */
export function withReadStep(plan: WorkflowPlanDTO, src: ReadSourceDTO): WorkflowPlanDTO {
  const step = readStep(src);
  return { ...plan, variants: plan.variants.map((v) => (v.steps.some((s) => s.id === READ_STEP_ID) ? v : { ...v, steps: [step, ...v.steps] })) };
}

// ---------- what a source shows -> rows ----------

/** "activeUsers", "active_users", "Active users" -> "active users". */
const normKey = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** I6: a value is exactly what the source shows (only surrounding spaces are dropped): sign, symbols, separators and
 * zeros kept. A value that is empty, multi-line or too long is not known (null): its row is skipped, never altered. */
const cleanValue = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  // I8: a cell of only punctuation, dashes or box characters is formatting, not a value (its row is never a row).
  return t === "" || t.length > MAX_VALUE || /[\r\n]/.test(t) || /^[\p{P}\p{S}\p{Z}\u2500-\u257F]+$/u.test(t) ? null : t;
};

/** s27 round 8 (I7): a key that appeared more than once with different values. Never picked from: a field holding
 * one makes its row ambiguous (skipped); a context key holding one counts every value as a declaration (I4). */
/** s27 round 19: every object built from an answer has no prototype, so `__proto__`, `constructor` and `prototype` are
 * plain data keys (their context is checked like any other) and nothing can change an object's prototype. */
const dataObj = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;

export class Repeated {
  constructor(readonly values: unknown[]) {}
}
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Sets `k` on `o`; a second, different value makes it Repeated (never first-wins, never last-wins). */
function putKey(o: Obj, k: string, v: unknown): void {
  if (!Object.hasOwn(o, k)) {
    o[k] = v;
    return;
  }
  const cur = o[k];
  if (cur instanceof Repeated) {
    if (!cur.values.some((x) => sameValue(x, v))) cur.values.push(v);
  } else if (!sameValue(cur, v)) o[k] = new Repeated([cur, v]);
}

/**
 * JSON parsed exactly: every number keeps its own text (25.50 stays "25.50", 1e3 stays "1e3", -0.0 stays), and a key
 * repeated in one object with another value is Repeated (JSON.parse would silently keep the last). Throws on invalid.
 */
export function parseExact(t: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < t.length && (t[i] === " " || t[i] === "\n" || t[i] === "\r" || t[i] === "\t")) i += 1;
  };
  const fail = (): never => {
    throw new Error(`not JSON at ${i}`);
  };
  const str = (): string => {
    const start = i;
    i += 1;
    while (i < t.length && t[i] !== '"') i += t[i] === "\\" ? 2 : 1;
    if (i >= t.length) fail();
    i += 1;
    return JSON.parse(t.slice(start, i)) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 200) fail();
    ws();
    const c = t[i];
    if (c === "{") {
      i += 1;
      const o: Obj = dataObj();
      ws();
      if (t[i] === "}") {
        i += 1;
        return o;
      }
      for (;;) {
        ws();
        if (t[i] !== '"') fail();
        const k = str();
        ws();
        if (t[i] !== ":") fail();
        i += 1;
        putKey(o, k, value(depth + 1));
        ws();
        if (t[i] === ",") {
          i += 1;
          continue;
        }
        if (t[i] === "}") {
          i += 1;
          return o;
        }
        fail();
      }
    }
    if (c === "[") {
      i += 1;
      const a: unknown[] = [];
      ws();
      if (t[i] === "]") {
        i += 1;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (t[i] === ",") {
          i += 1;
          continue;
        }
        if (t[i] === "]") {
          i += 1;
          return a;
        }
        fail();
      }
    }
    if (c === '"') return str();
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(t.slice(i, i + 400));
    if (m !== null) {
      i += m[0].length;
      return m[0];
    }
    for (const [w, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (t.startsWith(w, i)) {
        i += w.length;
        return v;
      }
    }
    return fail();
  };
  const v = value(0);
  ws();
  if (i !== t.length) fail();
  return v;
}

/** Context words that, at the start of a text line without a ":" or "=", still declare a report or filter. */
const TEXT_DECLARATIONS = ["report", "insight", "dashboard", "period", "date range", "time range", "timeframe"];

/**
 * s27 round 7: a TEXT answer (screen text, a plain-text connector answer) as the same structure a JSON answer gives,
 * so it goes through the same pipeline and invariants: "Label: value" / "Label = value" lines and "Label value" lines
 * for the wanted fields and the context words become one object; a table (header of labels, cells split by | or
 * tabs) becomes its rows. Values are kept exactly as shown.
 */
/** s27 round 15: a table row with the wrong number of cells: kept in place as a row that is skipped, with this reason. */
const MALFORMED = Symbol("malformed row");
const notARow = (n: number, e: unknown): Obj => {
  const r: Obj = dataObj();
  (r as Record<symbol, string>)[MALFORMED] = `row ${n} is not a row (${e === null ? "null" : typeof e})`;
  return r;
};

function textAnswer(text: string, fields: readonly Pick<ReadFieldDTO, "label" | "sourceLabel">[]): Obj {
  const obj: Obj = dataObj();
  const rows: Obj[] = [];
  // Every declaration and every field value is kept (a multimap, I4/I7): a repeat with another value is Repeated.
  const put = (k: string, v: string) => putKey(obj, normKey(k), v);
  const lines: string[] = [];
  for (const l of text.split("\n")) {
    // Accessibility lines in the one shared format (connectors/computer/ax-text.ts): a field's label and value are
    // read separately and exactly; a label-only element is read as the text it shows.
    const ax = parseAxLine(l);
    if (ax !== null && ax.value !== null) put(ax.label, ax.value);
    else if (ax !== null) lines.push(ax.label.trim());
    // Round 15: lines are kept as they are (only a trailing \r dropped): a table row is split into cells BEFORE any
    // trimming, so an empty first or last cell keeps its place.
    else if (l.trim() !== "" && !isFormattingLine(l)) lines.push(l.replace(/\r$/, ""));
  }
  const words = [...new Set([...fields.flatMap((f) => [f.sourceLabel, f.label]), ...TEXT_DECLARATIONS])].sort((a, b) => b.length - a.length);
  for (let i = 0; i < lines.length; i++) {
    const raw0 = lines[i]!;
    const line = raw0.trim();
    const head = cellsOf(raw0);
    // A header: plain-word labels, at least two of them (an unnamed first column is allowed).
    if (head !== null && head.filter((c) => c !== "").length >= 2 && head.every((c) => c === "" || plainLabel(c) !== null)) {
      // A table: every following line with a cell delimiter is a row, cells split before trimming and kept exactly.
      // A row with the wrong number of cells is skipped and named (never ends the table); only a line without any
      // delimiter ends it.
      const outer = outerPipes(raw0);
      let j = i + 1;
      let n = 0;
      for (; j < lines.length; j++) {
        const cells = cellsOf(lines[j]!, outer);
        if (cells === null) break;
        n += 1;
        rows.push(tableRow(head, cells, n));
      }
      i = j - 1;
      continue;
    }
    // "Label: value" pairs side by side ("Signups: 1 | Active users: 2"): read cell by cell, never one value
    // swallowing the next (round 18).
    if (head !== null && head.length >= 2) {
      const pairs = head.map((c) => /^([A-Za-z][A-Za-z _-]{0,39}?)\s*[:=]\s*(.*)$/.exec(c));
      if (pairs.every((m) => m !== null)) {
        for (const m of pairs) put(m!.at(1)!.trim(), m!.at(2)!);
        continue;
      }
    }
    const kv = /^([A-Za-z][A-Za-z _-]{0,39}?)\s*[:=]\s*(.*)$/.exec(line);
    if (kv !== null) {
      put(kv[1]!.trim(), kv[2]!);
      continue;
    }
    // "Label value": a wanted field or a context word, then a space, then the value exactly (a leading sign is kept).
    for (const w of words) {
      const m = new RegExp(`^${escapeRe(w)}(?![\\p{L}\\p{N}])\\s+(\\S.*)$`, "iu").exec(line);
      if (m !== null) {
        put(w, m[1]!);
        break;
      }
    }
  }
  if (rows.length > 0) putKey(obj, "rows", rows);
  return obj;
}


function flat(o: Record<string, unknown>, depth = 0): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const set = (k: string, v: unknown) => {
    const cur = out.get(k);
    // A null never hides a value under the same key ("active_users": null beside "activeUsers": 2455); two
    // different values under one key (snake/camel twins, a nested copy) are Repeated, never first-wins (I7).
    if (cur == null) out.set(k, v);
    else if (v == null) return;
    else if (cur instanceof Repeated) {
      for (const x of v instanceof Repeated ? v.values : [v]) if (!cur.values.some((y) => sameValue(y, x))) cur.values.push(x);
    } else if (v instanceof Repeated) out.set(k, new Repeated([cur, ...v.values.filter((x) => !sameValue(x, cur))]));
    else if (!sameValue(cur, v)) out.set(k, new Repeated([cur, v]));
  };
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v)) {
      if (depth >= 2) continue;
      for (const [k2, v2] of flat(v, depth + 1)) set(k2, v2);
    } else if (!Array.isArray(v)) set(normKey(k), v);
  }
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x) && !(x instanceof Repeated);
/** How deep an answer's envelopes are walked ({ data: { results: [...] } } is 2). */
const MAX_DEPTH = 4;

/** A table answer: { columns: [names | {name}], rows | data: [[...], ...] } -> one object per row. */
/** The rows array of a table node ({columns: [...], rows|data: [...]}), or null when the node is not a table. */
const tableBody = (o: Obj): { key: "rows" | "data"; rows: unknown[] } | null => (!Array.isArray(o.columns) ? null : Array.isArray(o.rows) ? { key: "rows", rows: o.rows } : Array.isArray(o.data) ? { key: "data", rows: o.data } : null);

/**
 * A table is recognised by SHAPE (round 18): a `columns` array and a `rows` (or `data`) array, whatever they hold.
 * Every row then goes through tableRow; a row that is null, a primitive or holds a nested value, and every row of a
 * table with an unnamed column, is skipped and named. A table's rows are never read as a plain list.
 */
function tableRows(o: Obj): Obj[] | null {
  const body = tableBody(o);
  if (body === null) return null;
  const cols = o.columns as unknown[];
  const names = cols.map((c) => (typeof c === "string" ? c : isObj(c) && typeof c.name === "string" ? c.name : null));
  const unnamed = names.findIndex((n) => n === null || n.trim() === "");
  return body.rows.map((r, i) => {
    if (unnamed >= 0) {
      const bad: Obj = dataObj();
      for (const n of names) if (typeof n === "string" && n.trim() !== "") bad[n] = null;
      (bad as Record<symbol, string>)[MALFORMED] = `column ${unnamed + 1} of the table has no name`;
      return bad;
    }
    return tableRow(names as string[], r, i + 1);
  });
}

/**
 * s27 round 16: ONE row rule for every table, text or JSON. Array rows: exactly one cell per column, else the row is
 * kept in place as skipped and named ("row 2 has 3 cells, the table has 2"); object rows (JSON): only the declared
 * columns, else skipped and named. Repeated column names are Repeated (I7); empty and formatting-only cells are judged
 * later by the row pass (cleanValue), the same for both.
 */
function tableRow(headers: readonly string[], cells: unknown, n: number): Obj {
  const r: Obj = dataObj();
  // A row that cannot be read still shows which columns the table has (null), so the table is chosen by presence and
  // the row is skipped and named in the row pass, never dropped.
  const malformed = (why: string): Obj => {
    for (const h of headers) if (!Object.hasOwn(r, h)) r[h] = null;
    (r as Record<symbol, string>)[MALFORMED] = why;
    return r;
  };
  // Keys are the column names as given (flattening normalises them: a null never hides a value, two different values
  // under one name are Repeated), the same for text and JSON.
  if (Array.isArray(cells)) {
    if (cells.length !== headers.length) return malformed(`row ${n} has ${cells.length} cell${cells.length === 1 ? "" : "s"}, the table has ${headers.length}`);
    // A cell is a value or empty; a nested object or list in a cell is never flattened into the row.
    const nested = cells.findIndex((c) => c !== null && typeof c === "object");
    if (nested >= 0) return malformed(`row ${n}, column ${headers[nested]} holds a nested value`);
    headers.forEach((h, k) => putKey(r, h, typeof cells[k] === "string" ? (cells[k] as string).trim() : cells[k]));
    return r;
  }
  if (!isObj(cells)) return malformed(`row ${n} is not a row (${cells === null ? "null" : typeof cells})`);
  const allowed = new Set(headers.map(normKey));
  const outside = Object.keys(cells).filter((k) => !allowed.has(normKey(k)));
  if (outside.length > 0) return malformed(`row ${n} has keys outside the columns: ${outside.join(", ")}`);
  // The same scalar-cell rule as array rows (round 19): a nested object or list in a cell is skipped and named.
  const isNested = (v: unknown): boolean => (v instanceof Repeated ? v.values.some(isNested) : v !== null && typeof v === "object");
  const nestedKey = Object.entries(cells).find(([, v]) => isNested(v))?.[0];
  if (nestedKey !== undefined) return malformed(`row ${n}, column ${nestedKey} holds a nested value`);
  for (const [k, v] of Object.entries(cells)) putKey(r, k, v);
  return r;
}

function morePages(o: Obj): boolean {
  for (const [k, v] of Object.entries(o)) {
    const n = normKey(k);
    if ((n === "next" || n === "next cursor" || n === "next page token" || n === "next page" || n === "cursor") && v !== null && v !== "" && v !== undefined && v !== false) return true;
    if ((n === "has more" || n === "has next page" || n === "more") && v === true) return true;
    if (n === "links" && isObj(v) && morePages(v)) return true;
    if (n === "pagination" && isObj(v) && morePages(v)) return true;
  }
  return false;
}

/** A candidate collection of rows: where it sits (depth) and the context of the envelopes around it. */
interface Collection {
  rows: Obj[];
  depth: number;
  /** [normalised key, text] scalars of every envelope on the path to it (the top level included). */
  context: Array<[string, string]>;
  order: number;
}

const scalars = (o: Obj): Array<[string, string]> => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" || typeof v === "number" ? [[normKey(k), String(v).trim()] as [string, string]] : []));

/**
 * s27 round 5: the ONE normaliser of a connector answer. One walk (depth <= MAX_DEPTH) yields every candidate
 * collection with the context of its envelopes: lists of objects, `columns` + `rows` tables, and each object as a
 * single row. Pagination markers are noted on the way.
 */
function collections(v: unknown): { all: Collection[]; more: boolean } {
  const all: Collection[] = [];
  let more = false;
  const walk = (x: unknown, depth: number, ctx: Array<[string, string]>) => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(x)) {
      // A list with objects is a list of rows: an element that is not an object is a row that is skipped and named,
      // never silently dropped (round 18).
      if (x.some(isObj)) all.push({ rows: x.map((e, i) => (isObj(e) ? e : notARow(i + 1, e))), depth, context: ctx, order: all.length });
      return;
    }
    if (!isObj(x)) return;
    if (morePages(x)) more = true;
    const here = [...ctx, ...scalars(x)];
    const t = tableRows(x);
    if (t !== null) all.push({ rows: t, depth, context: here, order: all.length });
    // The object itself as one row: its own scalars are the row's, only the envelopes above are context.
    all.push({ rows: [x], depth, context: ctx, order: all.length });
    // A table's own rows are read only through the table (tableRow), never as a second, unchecked list.
    const tableKey = tableBody(x)?.key ?? null;
    for (const k of Object.keys(x)) {
      if (k === tableKey) continue;
      const v = x[k];
      if (v instanceof Repeated) for (const y of v.values) walk(y, depth + 1, here);
      else walk(v, depth + 1, here);
    }
  };
  walk(v, 0, []);
  return { all, more };
}

const REPORT_KEYS = new Set(["report", "report name", "insight", "insight name", "dashboard", "dashboard name"]);
const FILTER_ALIASES: Record<string, string[]> = { period: ["period", "date range", "time range", "range", "timeframe"] };
const sameText = (a: string, b: string) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

/** A [key, value] that names another report or filter value than the learned query: the reason, else null. */
function conflictOf(pairs: Iterable<[string, unknown]>, q: ReadQueryDTO): string | null {
  for (const [k, raw] of pairs) {
    if (k === TOO_DEEP) return `the answer is nested too deeply to confirm it is ${contextWords(q)}`;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const v = String(raw).trim();
    if (v === "") continue;
    if (q.report !== null && REPORT_KEYS.has(k) && !sameText(v, q.report)) return `the answer is for the '${v}' report, not ${contextWords(q)}`;
    for (const [fk, fv] of q.filters) if ((FILTER_ALIASES[fk] ?? [normKey(fk)]).includes(k) && !sameText(v, fv)) return `the answer is for ${v}, not ${contextWords(q)}`;
  }
  return null;
}

/** A row the source returned that is not complete: SKIPPED (never done, never guessed), with the fields it lacked. */
export interface SkippedRow {
  missing: string[];
  /** Fields shown with two different values in this row (I7). */
  ambiguous?: string[];
  /** Why a row could not be read at all (a table row with the wrong number of cells). */
  reason?: string;
}

export type ValueRow = Array<[string, string]>;

/**
 * s27 round 6: what reading an answer gave, explicitly.
 *   ok             recognised rows: complete ones in `rows`, incomplete ones in `skipped` (with what they lack); a read
 *                  with 0 complete rows and N skipped is still ok (the person sees the skipped rows);
 *   empty          a recognised collection with no rows ({results: []}): a successful read of nothing;
 *   wrong_context  the answer declares another report or filter than the learned query, anywhere in it;
 *   unreadable     no recognisable rows at all (or a screen without the labels): `reason`, `missing`.
 * The fetcher stops the chain on ok and empty, marks the method failed and tries the next on wrong_context, and falls
 * back only on unreadable (or an error).
 */
export type ReadOutcome =
  | { kind: "ok"; rows: ValueRow[]; skipped: SkippedRow[]; more?: true }
  | { kind: "empty"; more?: true }
  | { kind: "wrong_context"; reason: string }
  | { kind: "unreadable"; reason: string; missing: string[] };

/** The complete rows of an outcome ([] unless ok). */
export const rowsOf = (o: ReadOutcome): ValueRow[] => (o.kind === "ok" ? o.rows : []);

/** Keys that hold rows when they hold a list: an empty list under one of them is a recognised empty collection. */
const ROW_KEYS = new Set(["results", "result", "data", "items", "rows", "records", "entries", "values", "series", "list"]);

/**
 * EVERY context declaration in the whole answer (all depths, every object and row, every key alias), collected before
 * anything is chosen or flattened, so a nested declaration can never be overwritten or skipped.
 */
/** Declarations deeper than this cannot be checked: the answer is refused (a hidden conflict must not slip by). */
const MAX_DECLARATION_DEPTH = 64;
const TOO_DEEP = "__offload_too_deep__";

function declarations(v: unknown, out: Array<[string, unknown]> = [], depth = 0): Array<[string, unknown]> {
  if (depth > MAX_DECLARATION_DEPTH) {
    out.push([TOO_DEEP, "1"]);
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) declarations(x, out, depth + 1);
    return out;
  }
  if (!isObj(v)) return out;
  // A table's columns declare per row: { columns: [..., "period"], rows: [[..., "last 30 days"]] }.
  const t = tableRows(v);
  if (t !== null) for (const r of t) declarations(r, out, depth + 1);
  for (const [k, x] of Object.entries(v)) {
    // Every value of a repeated key is its own declaration (I4): one conflicting repeat refuses the answer.
    for (const y of x instanceof Repeated ? x.values : [x]) {
      if (typeof y === "string" || typeof y === "number") out.push([normKey(k), y]);
      else declarations(y, out, depth + 1);
    }
  }
  return out;
}

/** A recognised empty collection: the answer is [] or a row key holds [] / a table with no rows. */
/** True when an answer object reports an error (a non-empty error / errors / fault): never an empty read. */
const reportsError = (o: Obj): boolean =>
  Object.entries(o).some(([k, v]) => ["error", "errors", "fault", "error message"].includes(normKey(k)) && v !== null && v !== false && v !== "" && !(Array.isArray(v) && v.length === 0));

function emptyCollection(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return depth === 0 && v.length === 0;
  if (!isObj(v)) return false;
  // An error next to an empty list is not "nothing new" (round 18): it is unreadable.
  if (reportsError(v)) return false;
  if (Array.isArray(v.columns) && (Array.isArray(v.rows) || Array.isArray(v.data)) && ((v.rows ?? v.data) as unknown[]).length === 0) return true;
  for (const [k, x] of Object.entries(v)) {
    if (Array.isArray(x) && x.length === 0 && ROW_KEYS.has(normKey(k))) return true;
    if (isObj(x) && emptyCollection(x, depth + 1)) return true;
  }
  return false;
}

/**
 * Rows of [commit label, value] from what a source returned: JSON from a connector, or screen text ("Signups 352"
 * lines; accessibility outlines too). Values are copied by code (ADR 0005); nothing is guessed.
 * JSON, one normaliser: (1) every context declaration anywhere is checked against the learned query; (2) candidate
 * collections with their depth; (3) the collection scored over ALL its rows; (4) each row validated.
 */
export function readValues(
  text: string,
  fields: readonly Pick<ReadFieldDTO, "label" | "sourceLabel">[],
  /** The learned query: an answer declaring another report or filter anywhere is wrong_context. */
  query?: ReadQueryDTO,
): ReadOutcome {
  return readValueParts([{ kind: "text", text }], fields, query);
}

/** One part of an answer: text as received (JSON is parsed exactly, else read as text), or a value a connector's
 * software already parsed (MCP structuredContent). */
export type AnswerPart = { kind: "text"; text: string } | { kind: "json"; value: unknown };
/** A JSON-looking part that does not parse: it holds nothing readable (never re-read as text). */
const INVALID_JSON = Object.freeze({}) as unknown;

function partAnswer(p: AnswerPart, fields: readonly Pick<ReadFieldDTO, "label" | "sourceLabel">[]): { answer: unknown; textual: boolean } {
  if (p.kind === "json") return { answer: p.value, textual: false };
  const t = p.text.trim();
  // JSON-looking text is JSON or nothing (round 18): cut-off or invalid JSON is never re-read as text lines.
  const looksJson = (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")) || t.startsWith("{\"") || t.startsWith("[{");
  try {
    const a = parseExact(t);
    if (a !== null && typeof a === "object") return { answer: a, textual: false };
  } catch {
    if (looksJson) return { answer: INVALID_JSON, textual: false };
  }
  // Text answers go through the SAME pipeline and invariants as JSON (round 7).
  return { answer: textAnswer(p.text, fields), textual: true };
}

/**
 * s27 round 14: an answer in one or more parts (MCP text blocks, resource text, structuredContent) read as ONE answer.
 * Order, always: (1) collect every context declaration from every part and refuse on any conflict (I1, I4);
 * (2) collect the candidate collections of every part; (3) pick the collection by field PRESENCE over all its rows
 * (a key that is there counts even when null), then how many rows reach it, then shallower, then first (text parts
 * come first); (4) validate each row: complete = row (I2, I6), else skipped with what it lacks or holds twice (I3,
 * I7). Nothing is discarded before it is checked.
 */
export function readValueParts(parts: readonly AnswerPart[], fields: readonly Pick<ReadFieldDTO, "label" | "sourceLabel">[], query?: ReadQueryDTO): ReadOutcome {
  const allMissing = () => fields.map((f) => f.label);
  const answers = parts.map((p) => partAnswer(p, fields));
  // 1. context first, over every part (I1, I4).
  if (query !== undefined) {
    const decl: Array<[string, unknown]> = [];
    for (const a of answers) declarations(a.answer, decl);
    const conflict = conflictOf(decl, query);
    if (conflict !== null) return { kind: "wrong_context", reason: conflict };
  }
  // 2. candidate collections of every part.
  const all: Collection[] = [];
  let more = false;
  for (const a of answers) {
    const c = collections(a.answer);
    for (const x of c.all) all.push({ ...x, order: all.length });
    more = more || c.more;
  }
  // 3. pick by presence over all rows; validity is the row pass's job.
  const wanted = fields.map((f) => [normKey(f.sourceLabel), normKey(f.label)] as const);
  const hits = (f: Map<string, unknown>) => wanted.filter(([a, b]) => f.has(a) || f.has(b)).length;
  let best: { c: Collection; flats: Array<Map<string, unknown>>; top: number; count: number } | undefined;
  for (const c of all) {
    const flats = c.rows.map((r) => flat(r));
    const top = Math.max(0, ...flats.map(hits));
    if (top === 0) continue;
    const count = flats.filter((f) => hits(f) === top).length;
    if (best === undefined || top > best.top || (top === best.top && (count > best.count || (count === best.count && (c.depth < best.c.depth || (c.depth === best.c.depth && c.order < best.c.order)))))) best = { c, flats, top, count };
  }
  const extra = more ? { more: true as const } : {};
  if (best === undefined) {
    // Empty only when some part is a recognised empty collection and NO part reports an error (round 18).
    const erroring = answers.some((a) => isObj(a.answer) && reportsError(a.answer));
    if (!erroring && answers.some((a) => !a.textual && emptyCollection(a.answer))) return { kind: "empty", ...extra };
    const textual = answers.every((a) => a.textual);
    return { kind: "unreadable", reason: textual ? `did not show ${allMissing().join(", ")}` : `no rows with ${allMissing().join(", ")}`, missing: allMissing() };
  }
  // 4. each row: complete = row (I2), values exactly as shown (I6); else skipped with what it lacks (I3).
  const rows: ValueRow[] = [];
  const skipped: SkippedRow[] = [];
  for (const [ri, f] of best.flats.entries()) {
    const bad = (best.c.rows[ri] as Record<symbol, unknown> | undefined)?.[MALFORMED];
    if (typeof bad === "string") {
      skipped.push({ missing: [], reason: bad });
      continue;
    }
    const row: ValueRow = [];
    const lacks: string[] = [];
    const unsure: string[] = [];
    fields.forEach((fd, i) => {
      const [k0, k1] = wanted[i]!;
      const a = f.get(k0);
      const b = k1 === k0 ? undefined : f.get(k1);
      // I7: two different values for one field in one row (repeated key, or its source label and its own label) are
      // ambiguous: the row is skipped, never first-wins.
      if (a instanceof Repeated || b instanceof Repeated || (a != null && b != null && !sameValue(a, b))) {
        unsure.push(fd.label);
        return;
      }
      const v = cleanValue(a ?? b);
      if (v === null) lacks.push(fd.label);
      else row.push([fd.label, v]);
    });
    if (lacks.length === 0 && unsure.length === 0) rows.push(row);
    else skipped.push({ missing: lacks, ...(unsure.length === 0 ? {} : { ambiguous: unsure }) });
  }
  return { kind: "ok", rows, skipped, ...extra };
}

// ---------- dry run: a past instance filled from its source ----------

export interface SourceFilled {
  ours: OutputDTO;
  theirs: OutputDTO & { excerpt: string };
  match: { matched: number; total: number; value: number; arithmetic: string };
  commit: { verb: string; fields: Array<[string, string]> } | null;
  warnings: string[];
}

/** One past instance: the values its source showed right before it (code) next to what the person typed. */
/**
 * s27 round 17: every set of values typed on a commit screen: each row of each table under a label header, and the
 * "Label: value" lines as one more set. Used as evidence to match a source row to a past instance (never "the first").
 */
export function parseCommitRows(texts: readonly string[]): Array<Map<string, string>> {
  const out: Array<Map<string, string>> = [];
  for (const t of texts) {
    const lines = t.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "" && !isFormattingLine(l));
    const kv = new Map<string, string>();
    for (let i = 0; i < lines.length; i++) {
      const head = cellsOf(lines[i]!);
      if (head !== null && head.length >= 2 && head.every((c) => plainLabel(c) !== null)) {
        const outer = outerPipes(lines[i]!);
        let j = i + 1;
        for (; j < lines.length; j++) {
          const cells = cellsOf(lines[j]!, outer);
          if (cells === null) break;
          if (cells.length !== head.length) continue;
          out.push(new Map(head.map((h, k) => [h, cells[k]!] as [string, string]).filter(([, v]) => v !== "")));
        }
        i = j - 1;
        continue;
      }
      const m = /^([A-Za-z][A-Za-z ]{0,39}):\s*(\S.*)$/.exec(lines[i]!.trim());
      if (m !== null && plainLabel(m[1]!) !== null && !kv.has(m[1]!.trim())) kv.set(m[1]!.trim(), m[2]!.trim());
    }
    if (kv.size > 0) out.push(kv);
  }
  return out;
}

/** A source row matches a typed set when they share at least one field and no shared field differs. */
const rowMatches = (row: ValueRow, typed: ReadonlyMap<string, string>): boolean => {
  let shared = 0;
  for (const [l, v] of row) {
    const t = typed.get(l);
    if (t === undefined) continue;
    if (t !== v) return false;
    shared += 1;
  }
  return shared > 0;
};

export const NO_MATCH_WORDS = (name: string) => `could not match the source row: ${name} showed no single row that fits what was typed here; left for you`;

export function fillFromSource(src: ReadSourceDTO, sourceText: string, commitOcr: readonly string[], o: { outputType: OutputType; verb: string; object: string }): SourceFilled {
  const rows = rowsOf(readValues(sourceText, src.fields));
  // The source row for THIS instance: the one row that matches the values typed on its commit screen (recorded
  // evidence). None or several -> unfilled, said plainly, and it saves nothing (it is not doable from the source).
  const typedRows = parseCommitRows(commitOcr);
  const matching = rows.filter((r) => typedRows.some((t) => rowMatches(r, t)));
  const got = new Map(matching.length === 1 ? matching[0]! : []);
  const ours: OutputFieldDTO[] = src.fields.map((f) => ({ label: f.label, value: got.get(f.label) ?? null }));
  const typed = matching.length === 1 ? (typedRows.find((t) => rowMatches(matching[0]!, t)) ?? new Map<string, string>()) : new Map(parseCommitValues(commitOcr));
  const theirs: OutputFieldDTO[] = src.fields.filter((f) => typed.has(f.label)).map((f) => ({ label: f.label, value: typed.get(f.label)! }));
  let matched = 0;
  for (const t of theirs) if (ours.find((x) => x.label === t.label)?.value === t.value) matched += 1;
  const filled = ours.filter((f) => f.value !== null);
  const warnings = matching.length === 1 ? ours.filter((f) => f.value === null).map((f) => `${f.label}: not on ${src.targetName} before this one; left for you`) : [NO_MATCH_WORDS(src.targetName)];
  const value = theirs.length === 0 ? 0 : Math.round((matched / theirs.length) * 1000) / 1000;
  const verb = o.verb;
  return {
    ours: { kind: o.outputType, summary: `${verb.charAt(0).toUpperCase()}${verb.slice(1)} the ${o.object}: ${filled.length} of ${ours.length} fields read from ${src.targetName}`, fields: ours, text: null, actions: [`update the ${o.object}`] },
    theirs: { kind: o.outputType, summary: theirs.length === 0 ? "No screen note of what you filled in" : `You filled ${theirs.length} field${theirs.length === 1 ? "" : "s"}`, fields: theirs, text: null, actions: [], excerpt: (commitOcr.at(-1) ?? "").slice(0, 400) },
    match: { matched, total: theirs.length, value, arithmetic: theirs.length === 0 ? "nothing on screen to compare fields with" : `${matched} of ${theirs.length} fields match = ${Math.round(value * 100)}%` },
    commit: filled.length === 0 ? null : { verb, fields: filled.map((f) => [f.label, f.value!] as [string, string]) },
    warnings,
  };
}

// ---------- what a read can confirm ----------

const phrase = (text: string, p: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** Plain words for the learned context: "the 'Weekly metrics' report for last 7 days". */
export function contextWords(q: ReadQueryDTO): string {
  const filters = q.filters.map(([, v]) => v).join(", ");
  return `${q.report === null ? "the values" : `the '${q.report}' report`}${filters === "" ? "" : ` for ${filters}`}`;
}

/**
 * A screen read accepts values only when the learned report and every learned filter are visible on screen (it never
 * navigates or changes a filter to get there). null = confirmed; else the plain reason.
 */
export function confirmOnScreen(text: string, q: ReadQueryDTO): string | null {
  const ok = (q.report === null || phrase(text, q.report)) && q.filters.every(([, v]) => phrase(text, v));
  return ok ? null : `could not confirm ${contextWords(q)} on screen`;
}

/** True when an answer names the learned report and every learned filter value somewhere (a connector that confirms). */
export function mentionsContext(text: string, q: ReadQueryDTO): boolean {
  return (q.report === null || phrase(text, q.report)) && q.filters.every(([, v]) => phrase(text, v));
}
