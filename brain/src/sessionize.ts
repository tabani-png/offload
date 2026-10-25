// S1 Sessionize (rules only). Events -> Spans: continuous focus on one app + title + host, idle removed,
// blips under `minSpanMs` merged into their neighbours. Pure: same events in, same spans out.
import type { DayLabel, OcrSnapshot, OffloadEvent, Span } from "./types.ts";

export interface SessionOptions {
  /** Segments shorter than this are blips and get merged into a neighbour. */
  minSpanMs: number;
  /** Two segments of the same focus split only by idle merge into one span if the idle gap is at most this long. */
  idleMergeMaxMs: number;
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = { minSpanMs: 10_000, idleMergeMaxMs: 15 * 60_000 };

interface Focus {
  key: string;
  app: string;
  appName: string;
  title: string;
  host: string;
  url: string;
  eventId: string;
}

interface Segment {
  focus: Focus;
  start: number;
  end: number;
  eventIds: string[];
  ocr: OcrSnapshot[];
  keys: number;
  clicks: number;
}

/** Working span while merging: one or more segments of the same focus. */
interface Building {
  focus: Focus;
  start: number;
  end: number;
  activeMs: number;
  eventIds: string[];
  ocr: OcrSnapshot[];
  keys: number;
  clicks: number;
}

function hostOf(e: OffloadEvent): string {
  if (e.host !== undefined && e.host !== "") return e.host;
  if (e.url === undefined || e.url === "") return "";
  try {
    return new URL(e.url).host;
  } catch {
    // A malformed URL carries no host; the span is still keyed on app + title.
    return "";
  }
}

function focusOf(e: OffloadEvent): Focus {
  const app = e.app ?? "unknown";
  const title = e.title ?? "";
  const host = hostOf(e);
  return { key: `${app}\u0000${title}\u0000${host}`, app, appName: e.appName ?? app, title, host, url: e.url ?? "", eventId: e.id };
}

function byTime(a: OffloadEvent, b: OffloadEvent): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Pass 1: events -> raw segments. A segment ends at the next focus, idle_start, pause, or the last event. */
function toSegments(events: readonly OffloadEvent[]): Segment[] {
  const sorted = [...events].sort(byTime);
  const out: Segment[] = [];
  let cur = null as Segment | null;
  let last: Focus | null = null;
  let paused = false;

  const close = (ts: number) => {
    if (cur === null) return;
    cur.end = Math.max(cur.start, ts);
    out.push(cur);
    cur = null;
  };
  const open = (focus: Focus, ts: number, ids: string[]) => {
    cur = { focus, start: ts, end: ts, eventIds: ids, ocr: [], keys: 0, clicks: 0 };
  };

  for (const e of sorted) {
    switch (e.kind) {
      case "focus": {
        close(e.ts);
        last = focusOf(e);
        if (!paused) open(last, e.ts, [e.id]);
        break;
      }
      case "idle_start":
        close(e.ts);
        break;
      case "idle_end":
        if (!paused && cur === null && last !== null) open(last, e.ts, [last.eventId, e.id]);
        break;
      case "pause":
        close(e.ts);
        paused = true;
        last = null;
        break;
      case "resume":
        // Focus during the pause is unknown, so nothing is counted until the next focus event.
        paused = false;
        break;
      case "input":
        if (cur !== null) {
          cur.eventIds.push(e.id);
          cur.keys += e.keys ?? 0;
          cur.clicks += e.clicks ?? 0;
        }
        break;
      case "ocr":
        if (cur !== null) {
          cur.eventIds.push(e.id);
          if (e.text !== undefined) cur.ocr.push({ eventId: e.id, ts: e.ts, text: e.text });
        }
        break;
    }
  }
  const lastEvent = sorted[sorted.length - 1];
  if (lastEvent !== undefined) close(lastEvent.ts);
  // A focus event re-opened on the same focus right after idle_end may duplicate the focus id; keep ids unique.
  return out.map((s) => ({ ...s, eventIds: [...new Set(s.eventIds)] }));
}

function fromSegment(s: Segment): Building {
  return { focus: s.focus, start: s.start, end: s.end, activeMs: s.end - s.start, eventIds: [...s.eventIds], ocr: [...s.ocr], keys: s.keys, clicks: s.clicks };
}

function absorb(into: Building, s: Segment | Building, keepFocus = true): void {
  into.start = Math.min(into.start, s.start);
  into.end = Math.max(into.end, s.end);
  into.activeMs += "activeMs" in s ? s.activeMs : s.end - s.start;
  for (const id of s.eventIds) if (!into.eventIds.includes(id)) into.eventIds.push(id);
  into.ocr.push(...s.ocr);
  into.ocr.sort((a, b) => a.ts - b.ts);
  into.keys += s.keys;
  into.clicks += s.clicks;
  if (!keepFocus) into.focus = s.focus;
}

/** Pass 2: merge blips and same-focus segments split by idle. */
function mergeSegments(segments: readonly Segment[], opts: SessionOptions): Building[] {
  const out: Building[] = [];
  let pendingBlip: Segment | null = null;

  for (const seg of segments) {
    const prev = out[out.length - 1];
    const isBlip = seg.end - seg.start < opts.minSpanMs;
    const contiguous = prev !== undefined && prev.end === seg.start;

    if (isBlip) {
      if (prev !== undefined && contiguous) absorb(prev, seg);
      else if (pendingBlip === null) pendingBlip = seg;
      else {
        // Two blips in a row with no earlier span: keep the first as the holder.
        const holder = fromSegment(pendingBlip);
        absorb(holder, seg);
        pendingBlip = null;
        out.push(holder);
      }
      continue;
    }

    const span = fromSegment(seg);
    if (pendingBlip !== null) {
      if (pendingBlip.end === seg.start) absorb(span, pendingBlip);
      else out.push(fromSegment(pendingBlip));
      pendingBlip = null;
    }

    const last = out[out.length - 1];
    if (last !== undefined && last.focus.key === span.focus.key && span.start - last.end <= opts.idleMergeMaxMs) {
      // Same focus either side of a blip (gap 0) or of an idle gap: one span. Idle time is not added to activeMs.
      absorb(last, span);
      continue;
    }
    out.push(span);
  }
  if (pendingBlip !== null) out.push(fromSegment(pendingBlip));
  return out;
}

export function sessionize(events: readonly OffloadEvent[], day: DayLabel, opts: SessionOptions = DEFAULT_SESSION_OPTIONS): Span[] {
  return mergeSegments(toSegments(events), opts).map((b) => {
    const first = b.eventIds[0] ?? b.focus.eventId;
    return {
      id: `sp_${first}`,
      day,
      key: b.focus.key,
      app: b.focus.app,
      appName: b.focus.appName,
      title: b.focus.title,
      host: b.focus.host,
      url: b.focus.url,
      start: b.start,
      end: b.end,
      activeMs: b.activeMs,
      eventIds: b.eventIds,
      ocr: b.ocr,
      keys: b.keys,
      clicks: b.clicks,
    };
  });
}

export function totalActiveMs(spans: readonly Span[]): number {
  return spans.reduce((n, s) => n + s.activeMs, 0);
}
