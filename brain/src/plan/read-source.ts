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

const cellsOf = (line: string): string[] | null => (line.includes("|") ? line.split("|") : line.includes("\t") ? line.split("\t") : null)?.map((c) => c.trim()) ?? null;

/**
 * The values typed on a commit screen, from its masked OCR: a table header of plain-word labels with the row under it
 * ("Week | Signups\n42 | 350"), or "Label: value" lines. First value per label wins.
 */
export function parseCommitValues(texts: readonly string[]): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const t of texts) {
    const lines = t.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    for (let i = 0; i < lines.length; i++) {
      const head = cellsOf(lines[i]!);
      if (head !== null && head.length >= 2 && head.every((c) => plainLabel(c) !== null)) {
        const row = lines.slice(i + 1).map(cellsOf).find((c) => c !== null && c.length === head.length && !c.every((x) => plainLabel(x) !== null));
        if (row != null) head.forEach((h, k) => row[k] !== "" && !out.has(h) && out.set(h, row[k]!));
        continue;
      }
      const m = /^([A-Za-z][A-Za-z ]{0,39}):\s*(\S.*)$/.exec(lines[i]!);
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
  return t === "" || t.length > MAX_VALUE || /[\r\n]/.test(t) ? null : t;
};

/** JSON with every number turned into a string of its own text (25.50 stays "25.50", 1e3 stays "1e3", -0.0 stays). */
function quoteNumbers(t: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < t.length; ) {
    const c = t[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += t[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(t.slice(i, i + 400));
      if (m !== null) {
        out += JSON.stringify(m[0]);
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Context words that, at the start of a text line without a ":" or "=", still declare a report or filter. */
const TEXT_DECLARATIONS = ["report", "insight", "dashboard", "period", "date range", "time range", "timeframe"];

/**
 * s27 round 7: a TEXT answer (screen text, a plain-text connector answer) as the same structure a JSON answer gives,
 * so it goes through the same pipeline and invariants: "Label: value" / "Label = value" lines and "Label value" lines
 * for the wanted fields and the context words become one object; a table (header of labels, cells split by | or
 * tabs) becomes its rows. Values are kept exactly as shown.
 */
function textAnswer(text: string, fields: readonly Pick<ReadFieldDTO, "label" | "sourceLabel">[]): Obj {
  const lines = text
    .split("\n")
    .map((l) => {
      const ax = /^AX[A-Za-z]+\s+"(.*)"(?:\s*=\s*"(.*)")?\s*$/.exec(l.trim());
      return (ax === null ? l : ax[2] === undefined ? ax[1]! : `${ax[1]} = ${ax[2]}`).replace(/\s+$/, "").replace(/^\s+/, "");
    })
    .filter((l) => l !== "");
  const obj: Obj = {};
  const rows: Obj[] = [];
  const put = (k: string, v: string) => {
    if (!Object.hasOwn(obj, k)) obj[k] = v;
  };
  const words = [...new Set([...fields.flatMap((f) => [f.sourceLabel, f.label]), ...TEXT_DECLARATIONS])].sort((a, b) => b.length - a.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const head = cellsOf(line);
    if (head !== null && head.length >= 2 && head.every((c) => plainLabel(c) !== null)) {
      // A table: every following line with the same number of cells is a row; cells kept exactly.
      let j = i + 1;
      for (; j < lines.length; j++) {
        const raw = lines[j]!.includes("|") ? lines[j]!.split("|") : lines[j]!.includes("\t") ? lines[j]!.split("\t") : null;
        if (raw === null || raw.length !== head.length) break;
        rows.push(Object.fromEntries(head.map((h, k) => [h, raw[k]!.trim()])));
      }
      i = j - 1;
      continue;
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
  return rows.length > 0 ? { ...obj, rows } : obj;
}


function flat(o: Record<string, unknown>, depth = 0): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (depth >= 2) continue;
      for (const [k2, v2] of flat(v as Record<string, unknown>, depth + 1)) {
        if (!out.has(k2)) out.set(k2, v2);
      }
    } else if (out.get(normKey(k)) == null) {
      // A null never hides a value under the same key ("active_users": null beside "activeUsers": 2455).
      out.set(normKey(k), v);
    }
  }
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
/** How deep an answer's envelopes are walked ({ data: { results: [...] } } is 2). */
const MAX_DEPTH = 4;

/** A table answer: { columns: [names | {name}], rows | data: [[...], ...] } -> one object per row. */
function tableRows(o: Obj): Obj[] | null {
  const cols = o.columns;
  const rows = Array.isArray(o.rows) ? o.rows : Array.isArray(o.data) ? o.data : null;
  if (!Array.isArray(cols) || rows === null || rows.length === 0 || !rows.every(Array.isArray)) return null;
  const names = cols.map((c) => (typeof c === "string" ? c : isObj(c) && typeof c.name === "string" ? c.name : null));
  if (names.some((n) => n === null)) return null;
  return (rows as unknown[][]).map((r) => Object.fromEntries(names.map((n, i) => [n as string, r[i]])));
}

/** Pagination markers: a non-empty next link or cursor, or has_more true. Only page one was read. */
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
      const objs = x.filter(isObj);
      if (objs.length > 0) all.push({ rows: objs, depth, context: ctx, order: all.length });
      return;
    }
    if (!isObj(x)) return;
    if (morePages(x)) more = true;
    const here = [...ctx, ...scalars(x)];
    const t = tableRows(x);
    if (t !== null) all.push({ rows: t, depth, context: here, order: all.length });
    // The object itself as one row: its own scalars are the row's, only the envelopes above are context.
    all.push({ rows: [x], depth, context: ctx, order: all.length });
    for (const k of Object.keys(x)) walk(x[k], depth + 1, here);
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
function declarations(v: unknown, out: Array<[string, unknown]> = [], depth = 0): Array<[string, unknown]> {
  if (depth > 64) return out;
  if (Array.isArray(v)) {
    for (const x of v) declarations(x, out, depth + 1);
    return out;
  }
  if (!isObj(v)) return out;
  // A table's columns declare per row: { columns: [..., "period"], rows: [[..., "last 30 days"]] }.
  const t = tableRows(v);
  if (t !== null) for (const r of t) declarations(r, out, depth + 1);
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string" || typeof x === "number") out.push([normKey(k), x]);
    else declarations(x, out, depth + 1);
  }
  return out;
}

/** A recognised empty collection: the answer is [] or a row key holds [] / a table with no rows. */
function emptyCollection(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(v)) return depth === 0 && v.length === 0;
  if (!isObj(v)) return false;
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
  const allMissing = () => fields.map((f) => f.label);
  let answer: unknown;
  let textual = false;
  try {
    answer = JSON.parse(quoteNumbers(text.trim()));
    if (answer === null || typeof answer !== "object") throw new Error("not an object");
  } catch {
    // Text answers go through the SAME pipeline and invariants as JSON (round 7).
    answer = textAnswer(text, fields);
    textual = true;
  }
  // 1. context first, over the whole answer (I1, I4).
  if (query !== undefined) {
    const conflict = conflictOf(declarations(answer), query);
    if (conflict !== null) return { kind: "wrong_context", reason: conflict };
  }
  // 2. candidate collections; 3. pick over all rows (best field match, how many rows reach it, shallower, order).
  const { all, more } = collections(answer);
  const wanted = fields.map((f) => [normKey(f.sourceLabel), normKey(f.label)] as const);
  const hits = (f: Map<string, unknown>) => wanted.filter(([a, b]) => f.get(a) != null || f.get(b) != null).length;
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
    if (!textual && emptyCollection(answer)) return { kind: "empty", ...extra };
    return { kind: "unreadable", reason: textual ? `did not show ${allMissing().join(", ")}` : `no rows with ${allMissing().join(", ")}`, missing: allMissing() };
  }
  // 4. each row: complete = row (I2), values exactly as shown (I6); else skipped with what it lacks (I3).
  const rows: ValueRow[] = [];
  const skipped: SkippedRow[] = [];
  for (const f of best.flats) {
    const row: ValueRow = [];
    const lacks: string[] = [];
    fields.forEach((fd, i) => {
      const v = cleanValue(f.get(wanted[i]![0]) ?? f.get(wanted[i]![1]));
      if (v === null) lacks.push(fd.label);
      else row.push([fd.label, v]);
    });
    if (lacks.length === 0) rows.push(row);
    else skipped.push({ missing: lacks });
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
export function fillFromSource(src: ReadSourceDTO, sourceText: string, commitOcr: readonly string[], o: { outputType: OutputType; verb: string; object: string }): SourceFilled {
  const rows = rowsOf(readValues(sourceText, src.fields));
  const got = new Map(rows[0] ?? []);
  const ours: OutputFieldDTO[] = src.fields.map((f) => ({ label: f.label, value: got.get(f.label) ?? null }));
  const typed = new Map(parseCommitValues(commitOcr));
  const theirs: OutputFieldDTO[] = src.fields.filter((f) => typed.has(f.label)).map((f) => ({ label: f.label, value: typed.get(f.label)! }));
  let matched = 0;
  for (const t of theirs) if (ours.find((x) => x.label === t.label)?.value === t.value) matched += 1;
  const filled = ours.filter((f) => f.value !== null);
  const warnings = ours.filter((f) => f.value === null).map((f) => `${f.label}: not on ${src.targetName} before this one; left for you`);
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
