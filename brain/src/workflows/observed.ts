// What the user really did, per instance, from the store: recipient and subject parsed from the OCR text of the
// compose window, the text they wrote (excerpt), and the observed active minutes. Used by the dry run.
import type { Analysis } from "../analyze.ts";
import type { Recipient } from "../tone/draft.ts";

export interface ObservedInstance {
  instanceId: string;
  day: string;
  start: number;
  minutes: number;
  recipient: Recipient;
  subject: string;
  /** The user's own text as OCR saw it, at most 400 chars. */
  excerpt: string;
  eventIds: string[];
}

const TO_RE = /^To:\s*([^\s,<>]+@[^\s,<>]+)/m;
const SUBJECT_RE = /^Subject:\s*(.+)$/m;
const EXCERPT_CHARS = 400;

const cap = (s: string) => (s === "" ? s : s[0]!.toUpperCase() + s.slice(1));

export function parseCompose(text: string): { to: string; subject: string; body: string; first: string | null } | null {
  const to = TO_RE.exec(text)?.[1]?.toLowerCase();
  if (to === undefined) return null;
  const subject = SUBJECT_RE.exec(text)?.[1]?.trim() ?? "";
  const afterSubject = text.split(SUBJECT_RE)[2] ?? "";
  const body = afterSubject.replace(/^\s+/, "");
  const first = /^(?:Hi|Hello|Hey|Dear)\s+([A-Z][\w'-]*),/m.exec(body)?.[1] ?? null;
  return { to, subject, body, first };
}

function orgFrom(subject: string, email: string): string {
  const afterColon = /:\s*([^:]+)$/.exec(subject)?.[1]?.trim();
  if (afterColon !== undefined && afterColon !== "") return afterColon;
  return email.split("@")[1]?.split(".")[0] ?? "";
}

export function observedInstances(a: Analysis, taskId: string, opts: { limit: number }): { instances: ObservedInstance[]; skipped: number } {
  const task = a.tasks.find((t) => t.id === taskId);
  if (task === undefined) return { instances: [], skipped: 0 };
  const out: ObservedInstance[] = [];
  let skipped = 0;
  for (const inst of [...task.instances].sort((x, y) => y.start - x.start || (x.id < y.id ? -1 : 1))) {
    if (out.length >= opts.limit) break;
    const snaps = inst.spanIds.flatMap((id) => a.spansById.get(id)?.ocr ?? []);
    // The fullest compose snapshot: the longest text that has a To: line.
    const best = snaps.filter((s) => TO_RE.test(s.text)).sort((x, y) => y.text.length - x.text.length || x.ts - y.ts)[0];
    const parsed = best === undefined ? null : parseCompose(best.text);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    const local = parsed.to.split("@")[0] ?? "";
    out.push({
      instanceId: inst.id,
      day: inst.day,
      start: inst.start,
      minutes: inst.activeMs / 60_000,
      recipient: { email: parsed.to, firstName: parsed.first ?? cap(local.split(/[._-]/)[0] ?? ""), org: orgFrom(parsed.subject, parsed.to) },
      subject: parsed.subject,
      excerpt: parsed.body.replace(/\n{3,}/g, "\n\n").slice(0, EXCERPT_CHARS).trim(),
      eventIds: [...inst.eventIds],
    });
  }
  return { instances: out, skipped };
}
