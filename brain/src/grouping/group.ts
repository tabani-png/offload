// S3 Group. Deterministic first: rule features (app, host, URL path pattern, title template, OCR keywords,
// identifiers) build a task signature; spans with one signature are one Task. A Labeler then names each task from
// its profile only. The default Labeler is rules; a model-backed one can be swapped in later without changing grouping.
import { createHash } from "node:crypto";
import type { Category, Identifiers, Span, Task, TaskInstance, TaskLabel, TaskProfile, UserContext } from "../types.ts";
import { clusterTitles, domainOf, extractEmails, maskText, ocrTokens, tokenize, urlPattern } from "./normalize.ts";

/** What a labeler may use besides the profile (s12). Context only: it never changes grouping or numbers. */
export interface LabelContext {
  user?: UserContext;
}

export interface Labeler {
  label(profile: TaskProfile, context?: LabelContext): TaskLabel | Promise<TaskLabel>;
}

export interface GroupOptions {
  labeler?: Labeler;
  /** The user's own addresses; detected from mail window titles when omitted. */
  ownEmails?: readonly string[];
  /** Title template similarity needed to join a cluster (0..1). */
  clusterThreshold?: number;
  /** Spans of one task with the same title and identifiers, at most this far apart, are one instance. */
  instanceMergeGapMs?: number;
  /** s12: optional onboarding context, handed to the labeler as its second argument. */
  user?: UserContext;
}

export const WRITING_KEYS_PER_MINUTE = 40;
const DEFAULT_MERGE_GAP_MS = 45_000;

const BROWSERS = new Set(["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser"]);
const MAIL_APPS = new Set(["com.apple.mail", "com.microsoft.Outlook", "com.superhuman.electron"]);
const MAIL_HOSTS = new Set(["mail.google.com", "outlook.office.com", "outlook.live.com", "app.superhuman.com"]);
const CHAT_APPS = new Set(["com.tinyspeck.slackmacgap", "com.hnc.Discord", "com.microsoft.teams2", "com.microsoft.teams"]);
const CHAT_HOSTS = new Set(["app.slack.com", "discord.com", "teams.microsoft.com"]);
const CALL_APPS = new Set(["us.zoom.xos", "com.apple.FaceTime"]);
const CALL_HOSTS = new Set(["meet.google.com", "zoom.us", "app.zoom.us"]);
const CODE_APPS = new Set(["com.apple.Terminal", "com.googlecode.iterm2", "com.microsoft.VSCode", "com.todesktop.230313mzl4w4u92", "com.mitchellh.ghostty", "dev.warp.Warp-Stable", "com.apple.dt.Xcode"]);
const SHEET_APPS = new Set(["com.microsoft.Excel", "com.apple.iWork.Numbers"]);
const CALENDAR_APPS = new Set(["com.apple.iCal"]);
const CALENDAR_HOSTS = new Set(["calendar.google.com", "calendly.com"]);
const SOCIAL_HOSTS = new Set(["www.linkedin.com", "linkedin.com", "x.com", "twitter.com"]);

export function categoryFor(app: string, host: string, path: string): Category {
  if (MAIL_APPS.has(app) || MAIL_HOSTS.has(host)) return "email";
  if (CHAT_APPS.has(app) || CHAT_HOSTS.has(host)) return "chat";
  if (CALL_APPS.has(app) || CALL_HOSTS.has(host)) return "call";
  if (CODE_APPS.has(app)) return "code";
  if (SHEET_APPS.has(app) || (host === "docs.google.com" && path.startsWith("/spreadsheets"))) return "sheet";
  if (CALENDAR_APPS.has(app) || CALENDAR_HOSTS.has(host)) return "calendar";
  if (SOCIAL_HOSTS.has(host)) return "social";
  if (BROWSERS.has(app)) return "browse";
  return "other";
}

const MAIL_LIST_VIEW_RE = /^(?:inbox|sent(?: mail)?|starred|snoozed|drafts|all mail|spam|important|search results)\b/i;

/** Mail list screens (Inbox, Sent, ...) are reading and triage, whatever the per-minute key counts say. */
export function isMailListView(template: string): boolean {
  return MAIL_LIST_VIEW_RE.test(template.trim());
}

/** Addresses in mail window titles are the signed-in account ("Inbox - sam@acme.io - Gmail"). */
export function detectOwnEmails(spans: readonly Span[]): string[] {
  const own = new Set<string>();
  for (const s of spans) {
    if (categoryFor(s.app, s.host, urlPattern(s.url)) !== "email") continue;
    for (const e of extractEmails(s.title)) own.add(e);
  }
  return [...own].sort();
}

const SCHEDULING_CUES: readonly RegExp[] = [
  /\b(?:does|would|could)\b[^.?!\n]{0,40}\bwork\b/i,
  /\b(?:monday|tuesday|wednesday|thursday|friday|mon|tue|tues|wed|thu|thurs|fri)\b/i,
  /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i,
  /\b(?:calendar|invite|availability|available|reschedule|calendly)\b/i,
];

/** OCR text reads as scheduling when at least two independent cues appear (a day, a time, "does X work", ...). */
export function looksLikeScheduling(text: string): boolean {
  return SCHEDULING_CUES.filter((re) => re.test(text)).length >= 2;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function identifiersOf(span: Span, own: ReadonlySet<string>): Identifiers {
  const emails = new Set<string>();
  for (const e of extractEmails(span.title)) emails.add(e);
  for (const o of span.ocr) for (const e of extractEmails(o.text)) emails.add(e);
  const counterparties = [...emails].filter((e) => !own.has(e)).sort();
  return { counterparties, domains: [...new Set(counterparties.map(domainOf))].sort() };
}

function unionIdentifiers(list: readonly Identifiers[]): Identifiers {
  const c = new Set<string>();
  const d = new Set<string>();
  for (const i of list) {
    i.counterparties.forEach((x) => c.add(x));
    i.domains.forEach((x) => d.add(x));
  }
  return { counterparties: [...c].sort(), domains: [...d].sort() };
}

function bySpanTime(a: Span, b: Span): number {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function buildInstances(taskId: string, spans: readonly Span[], own: ReadonlySet<string>, gapMs: number): TaskInstance[] {
  const out: TaskInstance[] = [];
  let cur: { inst: TaskInstance; title: string; idKey: string } | null = null;
  for (const s of spans) {
    const ids = identifiersOf(s, own);
    const idKey = ids.counterparties.join(",");
    if (cur !== null && cur.inst.day === s.day && cur.title === s.title && cur.idKey === idKey && s.start - cur.inst.end <= gapMs) {
      cur.inst.spanIds.push(s.id);
      cur.inst.end = Math.max(cur.inst.end, s.end);
      cur.inst.activeMs += s.activeMs;
      cur.inst.eventIds.push(...s.eventIds);
      continue;
    }
    const inst: TaskInstance = {
      id: `in_${s.id.replace(/^sp_/, "")}`,
      taskId,
      day: s.day,
      spanIds: [s.id],
      start: s.start,
      end: s.end,
      activeMs: s.activeMs,
      eventIds: [...s.eventIds],
      identifiers: ids,
    };
    out.push(inst);
    cur = { inst, title: s.title, idKey };
  }
  return out;
}

function topKeywords(instances: readonly TaskInstance[], spansById: ReadonlyMap<string, Span>, k = 10): string[] {
  const df = new Map<string, number>();
  for (const inst of instances) {
    const words = new Set<string>();
    for (const sid of inst.spanIds) for (const o of spansById.get(sid)?.ocr ?? []) ocrTokens(o.text).forEach((w) => words.add(w));
    words.forEach((w) => df.set(w, (df.get(w) ?? 0) + 1));
  }
  return [...df.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([w]) => w);
}

function instanceText(inst: TaskInstance, spansById: ReadonlyMap<string, Span>): string {
  return inst.spanIds.flatMap((sid) => (spansById.get(sid)?.ocr ?? []).map((o) => o.text)).join("\n");
}

function siteName(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const name = base ?? host;
  return name === "linkedin" ? "LinkedIn" : name.charAt(0).toUpperCase() + name.slice(1);
}

/** Rules-only Labeler. Names come from the profile; nothing here is a model guess. */
export const defaultLabeler = {
  label(p: TaskProfile): TaskLabel {
    const people = p.identifiers.counterparties.length;
    const orgs = p.identifiers.domains.length;
    switch (p.category) {
      case "email": {
        if (p.schedulingShare >= 0.3) {
          return { kind: "email.scheduling", name: "Scheduling meetings over email", description: `${p.instanceCount} replies proposing times to ${people} people at ${orgs} organisations` };
        }
        if (isMailListView(p.template) || p.keysPerMinute < WRITING_KEYS_PER_MINUTE) {
          return { kind: "email.triage", name: "Inbox triage", description: `${p.instanceCount} visits reading mail (${p.template})` };
        }
        if (/\b(?:new message|compose|draft)\b/i.test(p.template) && people >= 5) {
          return { kind: "email.outreach", name: "Outreach emails", description: `${p.instanceCount} new emails to ${people} people at ${orgs} organisations, written one by one` };
        }
        return { kind: "email.replies", name: "Email replies", description: `${p.instanceCount} replies in threads like "${p.exampleTitles[0] ?? p.template}"` };
      }
      case "chat":
        return { kind: "chat.messages", name: `${p.appName} messages`, description: `${p.instanceCount} visits to channels and DMs` };
      case "call":
        return { kind: "call.meetings", name: `Calls in ${p.appName}`, description: `${p.instanceCount} calls` };
      case "code":
        return /claude/i.test(p.template)
          ? { kind: "code.claude-code", name: "Coding with Claude Code", description: `${p.instanceCount} sessions in ${p.appName}` }
          : { kind: "code.terminal", name: `Work in ${p.appName}`, description: `${p.instanceCount} sessions` };
      case "sheet": {
        const doc = p.template.replace(/\s+-\s+Google Sheets$/, "");
        return { kind: "sheet.updates", name: `Spreadsheet updates: ${doc}`, description: `${p.instanceCount} edits in ${doc}` };
      }
      case "calendar":
        return { kind: "calendar.review", name: "Calendar checks", description: `${p.instanceCount} visits to the calendar` };
      case "social":
        return { kind: "social.browsing", name: `${siteName(p.host)} browsing`, description: `${p.instanceCount} visits (${p.template})` };
      case "browse":
        return { kind: "web.browsing", name: `Browsing ${p.host}`, description: `${p.instanceCount} visits (${p.template})` };
      case "other":
        return { kind: "other", name: `${p.appName}: ${p.template}`, description: `${p.instanceCount} sessions` };
    }
  },
} satisfies Labeler;

export async function groupTasks(spans: readonly Span[], opts: GroupOptions = {}): Promise<Task[]> {
  const labeler = opts.labeler ?? defaultLabeler;
  const own = new Set((opts.ownEmails ?? detectOwnEmails(spans)).map((e) => e.toLowerCase()));
  const gapMs = opts.instanceMergeGapMs ?? DEFAULT_MERGE_GAP_MS;
  const sorted = [...spans].sort(bySpanTime);
  const spansById = new Map(sorted.map((s) => [s.id, s]));

  // Partition on app + host + URL path pattern, then cluster masked titles inside each partition.
  const partitions = new Map<string, { app: string; host: string; path: string; spans: Span[] }>();
  for (const s of sorted) {
    const path = urlPattern(s.url);
    const key = `${s.app}|${s.host}|${path}`;
    const part = partitions.get(key) ?? { app: s.app, host: s.host, path, spans: [] };
    part.spans.push(s);
    partitions.set(key, part);
  }

  const drafts: Array<{ signature: string; template: string; app: string; host: string; path: string; spans: Span[] }> = [];
  for (const [key, part] of partitions) {
    const masked = [...new Set(part.spans.map((s) => maskText(s.title)))];
    const clusters = clusterTitles(masked.map(tokenize), opts.clusterThreshold);
    const templateOf = new Map<string, string>();
    for (const c of clusters) for (const m of c.members) templateOf.set(masked[m] ?? "", c.template);
    const byTemplate = new Map<string, Span[]>();
    for (const s of part.spans) {
      const t = templateOf.get(maskText(s.title)) ?? maskText(s.title);
      const list = byTemplate.get(t) ?? [];
      list.push(s);
      byTemplate.set(t, list);
    }
    for (const [template, list] of byTemplate) drafts.push({ signature: `${key}|${template}`, template, app: part.app, host: part.host, path: part.path, spans: list });
  }

  const tasks: Task[] = [];
  for (const d of drafts) {
    const id = `t_${sha(d.signature)}`;
    const instances = buildInstances(id, d.spans, own, gapMs);
    const activeMin = d.spans.reduce((n, s) => n + s.activeMs, 0) / 60_000;
    const keys = d.spans.reduce((n, s) => n + s.keys, 0);
    const first = d.spans[0];
    const profile: TaskProfile = {
      taskId: id,
      signature: d.signature,
      app: d.app,
      appName: first?.appName ?? d.app,
      host: d.host,
      urlPattern: d.path,
      template: d.template,
      category: categoryFor(d.app, d.host, d.path),
      exampleTitles: [...new Set(d.spans.map((s) => s.title))].slice(0, 5),
      ocrKeywords: topKeywords(instances, spansById),
      identifiers: unionIdentifiers(instances.map((i) => i.identifiers)),
      instanceCount: instances.length,
      keysPerMinute: activeMin > 0 ? keys / activeMin : 0,
      schedulingShare: instances.length === 0 ? 0 : instances.filter((i) => looksLikeScheduling(instanceText(i, spansById))).length / instances.length,
    };
    tasks.push({ id, profile, label: await (opts.user === undefined ? labeler.label(profile) : labeler.label(profile, { user: opts.user })), instances, spanIds: d.spans.map((s) => s.id) });
  }
  // Stable order: earliest first appearance.
  return tasks.sort((a, b) => (spansById.get(a.spanIds[0] ?? "")?.start ?? 0) - (spansById.get(b.spanIds[0] ?? "")?.start ?? 0) || (a.id < b.id ? -1 : 1));
}

/** The span lookup a stats pass needs; exported so callers do not rebuild it. */
export function indexSpans(spans: readonly Span[]): Map<string, Span> {
  return new Map(spans.map((s) => [s.id, s]));
}
