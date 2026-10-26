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

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cleanValue = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v !== "string") return null;
  const t = v.normalize("NFC").replace(/\s+/g, " ").trim();
  return t === "" || t.length > MAX_VALUE ? null : t;
};

function flat(o: Record<string, unknown>, depth = 0): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (depth >= 2) continue;
      for (const [k2, v2] of flat(v as Record<string, unknown>, depth + 1)) {
        if (!out.has(k2)) out.set(k2, v2);
      }
    } else if (!out.has(normKey(k))) {
      out.set(normKey(k), v);
    }
  }
  return out;
}

function objectsOf(v: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(v)) return v.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x));
  if (v === null || typeof v !== "object") return [];
  const o = v as Record<string, unknown>;
  // An answer that wraps its rows ({ results: [...] }, { data: [...] }): the one list of objects inside.
  const lists = Object.values(o).filter((x) => Array.isArray(x) && x.length > 0 && x.every((y) => y !== null && typeof y === "object" && !Array.isArray(y)));
  return lists.length === 1 ? objectsOf(lists[0]) : [o];
}

/**
 * Rows of [commit label, value] from what a source returned: JSON from a connector (keys matched to the source label or
 * the commit label), or screen text ("Signups 352" lines; accessibility outlines too). A row missing a field is not a
 * row: the missing labels are returned, never guessed. Values are copied by code (ADR 0005).
 */
export function readValues(text: string, fields: readonly Pick<ReadFieldDTO, "label" | "sourceLabel">[]): { rows: Array<Array<[string, string]>>; missing: string[] } {
  const missing = new Set<string>();
  const rows: Array<Array<[string, string]>> = [];
  let json: unknown;
  let isJson = false;
  try {
    json = JSON.parse(text.trim());
    isJson = json !== null && typeof json === "object";
  } catch {
    isJson = false;
  }
  if (isJson) {
    for (const o of objectsOf(json)) {
      const f = flat(o);
      const row: Array<[string, string]> = [];
      for (const fd of fields) {
        const v = cleanValue(f.get(normKey(fd.sourceLabel)) ?? f.get(normKey(fd.label)));
        if (v === null) missing.add(fd.label);
        else row.push([fd.label, v]);
      }
      if (row.length === fields.length) rows.push(row);
    }
    return { rows, missing: rows.length > 0 ? [] : [...missing] };
  }
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^AX[A-Za-z]+\s+/, "").replace(/"/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l !== "");
  const row: Array<[string, string]> = [];
  for (const fd of fields) {
    const re = new RegExp(`^${escapeRe(fd.sourceLabel)}(?![\\p{L}\\p{N}])\\s*[:=|\\-]?\\s*(.*)$`, "iu");
    let v: string | null = null;
    for (const l of lines) {
      const m = re.exec(l);
      if (m === null) continue;
      v = cleanValue((m[1] ?? "").replace(/^=\s*/, ""));
      if (v !== null) break;
    }
    if (v === null) missing.add(fd.label);
    else row.push([fd.label, v]);
  }
  if (row.length === fields.length) rows.push(row);
  return { rows, missing: rows.length > 0 ? [] : [...missing] };
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
  const { rows } = readValues(sourceText, src.fields);
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
